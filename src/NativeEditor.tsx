import { useEffect, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Group,
  Hand,
  ImagePlus,
  Layers,
  Lasso,
  LoaderCircle,
  Move,
  Paintbrush,
  Plus,
  RotateCw,
  Scan,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
  Crop,
  PaintBucket,
  ShieldHalf,
  Lock,
} from "lucide-react";
import { current, detach, native, useProject } from "./store";
import {
  canvasPoint,
  rectanglePoints,
  type Engine,
  type EnginePoint,
  type EngineOperation,
  type EngineProposal,
  type NativeDocument,
} from "./engine-model";
import "./native-editor.css";

type Tool =
  "view" | "move" | "brush" | "eraser" | "rectangle" | "lasso" | "crop";
const tools: { id: Tool; label: string; key: string; icon: typeof Hand }[] = [
  { id: "view", label: "Pan and inspect", key: "H", icon: Hand },
  { id: "move", label: "Move layer", key: "V", icon: Move },
  {
    id: "rectangle",
    label: "Rectangle selection",
    key: "M",
    icon: SquareDashed,
  },
  { id: "lasso", label: "Freehand selection", key: "L", icon: Lasso },
  { id: "brush", label: "Brush", key: "B", icon: Paintbrush },
  { id: "eraser", label: "Eraser", key: "E", icon: Eraser },
  { id: "crop", label: "Crop canvas", key: "C", icon: Crop },
];
export function NativeEditor({
  engine,
  active,
}: {
  engine: Engine;
  active: boolean;
}) {
  const project = useProject();
  const documents = (project.project.native_documents ?? []).filter(
    (d) => d.engine === engine,
  );
  const [id, setId] = useState("");
  const doc =
    documents.find((d) => d.id === id) ?? documents[documents.length - 1];
  const [selected, setSelected] = useState("");
  const layer =
    doc?.layers.find((l) => l.id === selected) ??
    doc?.layers.find((l) => l.id === doc.selected) ??
    doc?.layers[0];
  const [tool, setTool] = useState<Tool>(
    engine === "Krita" ? "brush" : "rectangle",
  );
  const [size, setSize] = useState(32),
    [color, setColor] = useState("#32b8b0"),
    [opacity, setOpacity] = useState(100),
    [preset, setPreset] = useState("");
  const [target, setTarget] = useState("layer"),
    [tab, setTab] = useState<"layers" | "partner">("layers");
  const [zoom, setZoom] = useState(1),
    [bounds, setBounds] = useState({ width: 800, height: 600 });
  const [points, setPoints] = useState<EnginePoint[]>([]);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [prompt, setPrompt] = useState(""),
    [proposal, setProposal] = useState<EngineProposal | null>(null),
    [preview, setPreview] = useState<NativeDocument | null>(null),
    [showPreview, setShowPreview] = useState(true);
  const [layerName, setLayerName] = useState(""),
    [layerOpacity, setLayerOpacity] = useState(100),
    [brightness, setBrightness] = useState(0),
    [contrast, setContrast] = useState(0);
  const [newCanvas, setNewCanvas] = useState(false),
    [width, setWidth] = useState(1600),
    [height, setHeight] = useState(1000);
  const [presetQuery, setPresetQuery] = useState("");
  const stage = useRef<HTMLDivElement>(null),
    surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    points: EnginePoint[];
    base: number;
    id: string;
    layer: string;
    startX: number;
    startY: number;
    scrollX: number;
    scrollY: number;
  } | null>(null);
  const busyRef = useRef(false);
  const isPaint = engine === "Krita";
  const stale =
    proposal !== null &&
    (proposal.base !== project.revision || proposal.id !== doc?.id);
  const viewing = preview && showPreview && !stale ? preview : doc;
  const currentPreset = doc?.presets.includes(preset)
    ? preset
    : (doc?.presets.find((p) =>
        isPaint ? p.includes("Basic-5 Size") : p === "2. Hardness 100",
      ) ??
      doc?.presets[0] ??
      "");
  useEffect(() => {
    setLayerName(layer?.name ?? "");
    setLayerOpacity(layer?.opacity ?? 100);
    setTarget("layer");
  }, [layer?.id, layer?.name, layer?.opacity]);
  useEffect(() => {
    setPoints([]);
    setSelected("");
    setProposal(null);
    setPreview(null);
  }, [doc?.id]);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const o = new ResizeObserver(([entry]) =>
      setBounds({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    o.observe(node);
    return () => o.disconnect();
  }, [active, !!doc]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      const t = tools.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (t) {
        e.preventDefault();
        setTool(t.id);
      }
      if (e.key === "Escape") {
        gesture.current = null;
        setPoints([]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);
  async function run(label: string, fn: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  async function edit(
    operations: EngineOperation[],
    label: string,
    base = project.revision,
    documentId = doc?.id,
  ) {
    if (!documentId) return;
    const result = await invoke<NativeDocument>("engine_edit", {
      id: documentId,
      operations,
      base,
      label,
      preview: false,
    });
    if (result.selected) setSelected(result.selected);
    setProposal(null);
    setPreview(null);
  }
  function one(
    kind: string,
    values: Record<string, unknown> = {},
    label = kind.replaceAll("_", " "),
  ) {
    void run(label, () => edit([{ kind, layer: layer?.id, ...values }], label));
  }
  async function openDocument(path?: string, assetId?: string) {
    let chosen = path;
    if (!chosen && !assetId) {
      const p = await open({
        title: `Open in ${isPaint ? "Paint" : "Edit"}`,
        multiple: false,
        filters: [
          {
            name: `${engine} documents and images`,
            extensions: isPaint
              ? [
                  "kra",
                  "ora",
                  "psd",
                  "png",
                  "jpg",
                  "jpeg",
                  "webp",
                  "tif",
                  "tiff",
                ]
              : [
                  "xcf",
                  "ora",
                  "psd",
                  "png",
                  "jpg",
                  "jpeg",
                  "webp",
                  "tif",
                  "tiff",
                ],
          },
        ],
      });
      if (typeof p !== "string") return;
      chosen = p;
    }
    await invoke("engine_open", {
      engine,
      path: chosen ?? null,
      assetId: assetId ?? null,
      width: 1600,
      height: 1000,
      base: current().revision,
    });
    setId("");
    setSelected("");
  }
  async function exportDocument(format: "native" | "png" | "ora") {
    if (!doc) return;
    const ext = format === "native" ? (isPaint ? "kra" : "xcf") : format;
    const path = await saveDialog({
      title:
        format === "native"
          ? `Save ${engine} document`
          : `Export ${format.toUpperCase()}`,
      defaultPath: `${doc.name}.${ext}`,
      filters: [
        {
          name:
            format === "native" ? `${engine} document` : format.toUpperCase(),
          extensions: [ext],
        },
      ],
    });
    if (!path) return;
    await invoke("engine_export", {
      id: doc.id,
      path,
      base: current().revision,
    });
    setNotice(`Saved ${ext.toUpperCase()} file`);
  }
  const fit = doc
    ? Math.max(
        0.02,
        Math.min(
          (bounds.width - 72) / doc.width,
          (bounds.height - 72) / doc.height,
          1,
        ),
      )
    : 1;
  const scale = fit * zoom;
  function point(e: PointerEvent): EnginePoint {
    const r = surface.current!.getBoundingClientRect();
    return canvasPoint(
      e.clientX,
      e.clientY,
      r,
      e.pointerType === "pen" ? e.pressure : 1,
    );
  }
  function down(e: PointerEvent<HTMLDivElement>) {
    if (
      !doc ||
      !layer ||
      busyRef.current ||
      (proposal && showPreview && !stale)
    )
      return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    gesture.current = {
      points: [p],
      base: project.revision,
      id: doc.id,
      layer: layer.id,
      startX: e.clientX,
      startY: e.clientY,
      scrollX: stage.current?.scrollLeft ?? 0,
      scrollY: stage.current?.scrollTop ?? 0,
    };
    setPoints([p]);
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g) return;
    if (tool === "view") {
      stage.current?.scrollTo(
        g.scrollX - (e.clientX - g.startX),
        g.scrollY - (e.clientY - g.startY),
      );
      return;
    }
    if (["rectangle", "crop", "move"].includes(tool))
      g.points = [g.points[0], point(e)];
    else {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
      for (const ev of events) {
        if (g.points.length >= 2048) break;
        g.points.push(
          canvasPoint(
            ev.clientX,
            ev.clientY,
            surface.current!.getBoundingClientRect(),
            ev.pointerType === "pen" ? ev.pressure : 1,
          ),
        );
      }
    }
    setPoints([...g.points]);
  }
  function up(e: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || !doc) return;
    gesture.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (tool === "view") {
      setPoints([]);
      return;
    }
    const end = point(e);
    if (g.points.length < 2) g.points.push(end);
    let op: EngineOperation;
    let label: string;
    if (tool === "brush" || tool === "eraser") {
      op = {
        kind: "stroke",
        layer: g.layer,
        points: g.points,
        color,
        size,
        opacity,
        preset: currentPreset,
        target,
        erase: tool === "eraser",
      };
      label = tool === "eraser" ? "Erase stroke" : "Paint stroke";
    } else if (tool === "move") {
      op = {
        kind: "move",
        layer: g.layer,
        dx: Math.round((end.x - g.points[0].x) * doc.width),
        dy: Math.round((end.y - g.points[0].y) * doc.height),
      };
      label = "Move layer";
    } else if (tool === "crop") {
      const a = g.points[0];
      const x = Math.floor(Math.min(a.x, end.x) * doc.width),
        y = Math.floor(Math.min(a.y, end.y) * doc.height);
      const w = Math.floor(Math.abs(end.x - a.x) * doc.width),
        h = Math.floor(Math.abs(end.y - a.y) * doc.height);
      if (w < 2 || h < 2) {
        setPoints([]);
        return;
      }
      op = { kind: "crop", x, y, width: w, height: h };
      label = "Crop canvas";
    } else {
      const polygon =
        tool === "rectangle" ? rectanglePoints(g.points[0], end) : g.points;
      if (polygon.length < 3) {
        setPoints([]);
        return;
      }
      op = { kind: "select", points: polygon };
      label = "Select region";
    }
    void run(label, async () => {
      try {
        await edit([op], label, g.base, g.id);
      } finally {
        setPoints([]);
      }
    });
  }
  async function ask() {
    if (!doc || !layer || !prompt.trim()) return;
    const p = await invoke<EngineProposal>("engine_propose", {
      id: doc.id,
      base: project.revision,
      prompt,
      layer: layer.id,
    });
    setProposal(p);
    setPreview(null);
    if (p.supported) {
      const result = await invoke<NativeDocument>("engine_edit", {
        id: p.id,
        operations: p.operations,
        base: p.base,
        label: "Preview design proposal",
        preview: true,
      });
      setPreview(result);
      setShowPreview(true);
    }
  }
  const overlayPoints =
    points.length > 0
      ? ["rectangle", "crop"].includes(tool)
        ? rectanglePoints(points[0], points[points.length - 1])
        : points
      : [];
  const painted = points.length > 0 && (tool === "brush" || tool === "eraser");
  return (
    <div className="native-editor">
      <div className="native-document-tabs">
        <span className="native-workspace-name">
          {isPaint ? <Paintbrush size={17} /> : <Layers size={17} />}{" "}
          {isPaint ? "Paint studio" : "Image studio"}
        </span>
        <div className="native-tabs-scroll">
          {documents.map((d) => (
            <button
              key={d.id}
              className={d.id === doc?.id ? "active" : ""}
              onClick={() => {
                setId(d.id);
                setSelected("");
              }}
            >
              <span className="native-file-dot" />
              {d.name}
              <small>{isPaint ? "KRA" : "XCF"}</small>
            </button>
          ))}
        </div>
        <button
          title="Detach this workspace"
          aria-label="Detach this workspace"
          onClick={() =>
            void run("Opening window", () => detach(isPaint ? "paint" : "edit"))
          }
        >
          <ExternalLink size={16} />
        </button>
      </div>
      <div className="native-commandbar">
        <button
          onClick={() => setNewCanvas(!newCanvas)}
          disabled={!native || !!busy}
        >
          <Plus size={15} />
          New
        </button>
        <button
          onClick={() =>
            void run(`Opening with ${engine}`, () => openDocument())
          }
          disabled={!native || !!busy}
        >
          <FolderOpen size={15} />
          Open…
        </button>
        <span className="divider" />
        <button
          disabled={!doc || !!busy}
          onClick={() =>
            void run("Saving native document", () => exportDocument("native"))
          }
        >
          <Download size={15} />
          Save {isPaint ? "KRA" : "XCF"}
        </button>
        <button
          disabled={!doc || !!busy}
          onClick={() =>
            void run("Exporting image", () => exportDocument("png"))
          }
        >
          Export PNG
        </button>
        <div className="workspace-spacer" />
        <span className="engine-badge">
          <span className={doc ? "live-dot" : "status-dot"} />
          {engine}
          {doc && <small>{doc.engine_version.split(" ")[0]}</small>}
        </span>
      </div>
      {newCanvas && (
        <form
          className="native-new-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run("Creating canvas", async () => {
              await invoke("engine_open", {
                engine,
                path: null,
                assetId: null,
                width,
                height,
                base: current().revision,
              });
              setId("");
              setNewCanvas(false);
            });
          }}
        >
          <strong>New canvas</strong>
          <label>
            Width{" "}
            <input
              aria-label="Canvas width"
              type="number"
              min={16}
              max={16000}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </label>
          <span>×</span>
          <label>
            Height{" "}
            <input
              aria-label="Canvas height"
              type="number"
              min={16}
              max={16000}
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
            />
          </label>
          <small>pixels</small>
          <button className="primary" disabled={!!busy}>
            Create
          </button>
          <button type="button" onClick={() => setNewCanvas(false)}>
            <X size={14} />
          </button>
        </form>
      )}
      {error && (
        <div className="native-message error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div className="native-message" role="status">
          <Check size={14} />
          {notice}
        </div>
      )}
      {!doc ? (
        <div className="native-welcome">
          <div className="native-welcome-icon">
            {isPaint ? <Paintbrush size={42} /> : <Layers size={42} />}
          </div>
          <span className="eyebrow">
            {isPaint ? "KRITA PAINTING" : "GIMP COMPOSITING"}
          </span>
          <h1>{isPaint ? "Make your mark." : "Every layer, in your hands."}</h1>
          <p>
            {isPaint
              ? "Native brushes, editable layers, and your design partner in one studio."
              : "Compose with real layers, masks, selections, and your design partner."}
          </p>
          <div className="row">
            <button
              className="primary"
              disabled={!!busy || !native}
              onClick={() =>
                void run(`Opening with ${engine}`, () => openDocument())
              }
            >
              <FolderOpen size={16} />
              Open a document
            </button>
            <button className="subtle" onClick={() => setNewCanvas(true)}>
              <Plus size={16} />
              Create canvas
            </button>
          </div>
          {project.project.assets.length > 0 && (
            <div className="native-references">
              <small>Start from a project photograph</small>
              <div>
                {project.project.assets.map((a) => (
                  <button
                    key={a.id}
                    disabled={!!busy}
                    onClick={() =>
                      void run("Opening photograph", () =>
                        openDocument(undefined, a.id),
                      )
                    }
                  >
                    <img src={a.data_url} alt={a.name} />
                    <span>{a.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <small className="native-format-note">
            {isPaint
              ? "KRA · PSD · OpenRaster · images"
              : "XCF · PSD · OpenRaster · images"}
            <br />
            Native document structure stays with the engine.
          </small>
          {busy && (
            <span className="native-loading">
              <LoaderCircle className="spin" size={16} />
              {busy}…
            </span>
          )}
        </div>
      ) : (
        <>
          <div className="native-optionsbar">
            <strong>{tools.find((t) => t.id === tool)?.label}</strong>
            {tool === "brush" || tool === "eraser" ? (
              <>
                <span className="divider" />
                <label>
                  Size{" "}
                  <input
                    aria-label="Brush size"
                    type="range"
                    min="1"
                    max="300"
                    value={size}
                    onChange={(e) => setSize(Number(e.target.value))}
                  />
                  <output>{size} px</output>
                </label>
                <label>
                  Opacity{" "}
                  <input
                    aria-label="Brush opacity"
                    type="number"
                    min="1"
                    max="100"
                    value={opacity}
                    onChange={(e) => setOpacity(Number(e.target.value))}
                  />
                  %
                </label>
                <select
                  aria-label="Paint target"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="layer">Layer pixels</option>
                  {layer?.mask && <option value="mask">Layer mask</option>}
                </select>
              </>
            ) : (
              <small>
                {tool === "rectangle" || tool === "lasso"
                  ? "Draw a region. Fill it, mask it, or guide a change."
                  : tool === "crop"
                    ? "Drag the part of the canvas to keep."
                    : tool === "move"
                      ? "Drag to move the selected layer."
                      : "Drag to pan. Use the zoom controls below."}
              </small>
            )}
            <div className="workspace-spacer" />
            {doc.selection && (
              <button
                disabled={!!busy}
                onClick={() => one("clear_selection", {}, "Clear selection")}
              >
                <X size={13} />
                Deselect
              </button>
            )}
          </div>
          <div className="native-body">
            <aside className="native-toolrail" aria-label="Canvas tools">
              {tools.map((t) => (
                <button
                  key={t.id}
                  aria-label={`${t.label} (${t.key})`}
                  title={`${t.label} (${t.key})`}
                  className={tool === t.id ? "chosen" : ""}
                  onClick={() => setTool(t.id)}
                >
                  <t.icon size={19} />
                </button>
              ))}
              <span className="rail-rule" />
              <button
                title="Fill selected layer or region"
                aria-label="Fill selected layer or region"
                disabled={!!busy || !layer}
                onClick={() => one("fill", { color }, "Fill region")}
              >
                <PaintBucket size={19} />
              </button>
              <input
                aria-label="Foreground color"
                title="Foreground color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
            </aside>
            <div className="native-canvas-column">
              <div className={`native-stage tool-${tool}`} ref={stage}>
                <div
                  className="native-canvas-spacing"
                  style={{
                    minWidth: doc.width * scale + 72,
                    minHeight: doc.height * scale + 72,
                  }}
                >
                  <div
                    ref={surface}
                    className={`native-surface ${busy ? "processing" : ""}`}
                    style={{
                      width: doc.width * scale,
                      height: doc.height * scale,
                    }}
                    onPointerDown={down}
                    onPointerMove={move}
                    onPointerUp={up}
                    onPointerCancel={() => {
                      gesture.current = null;
                      setPoints([]);
                    }}
                  >
                    <img
                      draggable={false}
                      src={viewing?.preview}
                      alt={`${doc.name} — ${preview && showPreview && !stale ? "proposed" : "current"} ${engine} canvas`}
                    />
                    {viewing?.selection_preview && (
                      <svg
                        className="native-selection-mask"
                        viewBox="0 0 1024 1024"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <defs>
                          <mask
                            id={`selection-${engine}`}
                            maskUnits="objectBoundingBox"
                            maskContentUnits="objectBoundingBox"
                          >
                            <image
                              href={viewing.selection_preview}
                              width="1"
                              height="1"
                              preserveAspectRatio="none"
                            />
                          </mask>
                        </defs>
                        <rect
                          width="1024"
                          height="1024"
                          fill="#5ad7ce"
                          opacity=".26"
                          mask={`url(#selection-${engine})`}
                        />
                      </svg>
                    )}
                    <svg
                      className="native-overlay"
                      viewBox={`0 0 ${doc.width} ${doc.height}`}
                      aria-hidden="true"
                    >
                      {overlayPoints.length > 1 &&
                        (painted ? (
                          <polyline
                            points={overlayPoints
                              .map(
                                (p) => `${p.x * doc.width},${p.y * doc.height}`,
                              )
                              .join(" ")}
                            fill="none"
                            stroke={tool === "eraser" ? "#ffffff" : color}
                            strokeWidth={size}
                            strokeOpacity={opacity / 100}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        ) : (
                          <polygon
                            points={overlayPoints
                              .map(
                                (p) => `${p.x * doc.width},${p.y * doc.height}`,
                              )
                              .join(" ")}
                            fill="rgba(69,200,190,.08)"
                            stroke="#f5ffff"
                            strokeWidth={1.5 / scale}
                            strokeDasharray={`${5 / scale} ${4 / scale}`}
                          />
                        ))}
                    </svg>
                  </div>
                </div>
                {preview && showPreview && !stale && (
                  <div className="native-preview-tag">
                    <Sparkles size={13} />
                    Proposal preview · not applied
                  </div>
                )}
              </div>
              <div className="native-canvas-status">
                <span>
                  {doc.width.toLocaleString()} × {doc.height.toLocaleString()}{" "}
                  px
                </span>
                <span>{doc.layers.length} layers</span>
                {doc.selection && (
                  <span className="teal">Selection active</span>
                )}
                <div className="workspace-spacer" />
                <button
                  aria-label="Zoom out"
                  onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}
                >
                  <ZoomOut size={14} />
                </button>
                <button onClick={() => setZoom(1)} title="Fit canvas">
                  {Math.round(scale * 100)}%
                </button>
                <button
                  aria-label="Zoom in"
                  onClick={() => setZoom((z) => Math.min(8, z * 1.25))}
                >
                  <ZoomIn size={14} />
                </button>
                <button aria-label="Fit canvas" onClick={() => setZoom(1)}>
                  <Scan size={14} />
                </button>
              </div>
            </div>
            <aside className="native-inspector">
              <div className="native-inspector-tabs">
                <button
                  className={tab === "layers" ? "active" : ""}
                  onClick={() => setTab("layers")}
                >
                  <Layers size={15} />
                  Layers & tools
                </button>
                <button
                  className={tab === "partner" ? "active" : ""}
                  onClick={() => setTab("partner")}
                >
                  <Sparkles size={15} />
                  Astra
                </button>
              </div>
              {tab === "layers" ? (
                <div className="native-inspector-scroll">
                  <div className="native-section-heading">
                    <span>LAYER STACK</span>
                    <span>{doc.layers.length}</span>
                  </div>
                  <div className="native-layer-actions">
                    <button
                      aria-label="Add paint layer"
                      title="Add paint layer"
                      disabled={!!busy}
                      onClick={() =>
                        one(
                          "add_layer",
                          { name: `Paint layer ${doc.layers.length + 1}` },
                          "Add layer",
                        )
                      }
                    >
                      <Plus size={16} />
                    </button>
                    <button
                      aria-label="Add layer group"
                      title="Add group"
                      disabled={!!busy}
                      onClick={() =>
                        one("add_group", { name: "Group" }, "Add group")
                      }
                    >
                      <Group size={16} />
                    </button>
                    <button
                      aria-label="Import as layer"
                      title="Import as layer"
                      disabled={!!busy}
                      onClick={() =>
                        void run("Import layer", async () => {
                          const p = await open({
                            multiple: false,
                            filters: [
                              {
                                name: "Images",
                                extensions: ["png", "jpg", "jpeg", "webp"],
                              },
                            ],
                          });
                          if (typeof p === "string")
                            await edit(
                              [{ kind: "import_layer", path: p }],
                              "Import layer",
                            );
                        })
                      }
                    >
                      <ImagePlus size={16} />
                    </button>
                    <span className="workspace-spacer" />
                    <button
                      aria-label="Duplicate layer"
                      title="Duplicate layer"
                      disabled={!!busy || !layer}
                      onClick={() => one("duplicate", {}, "Duplicate layer")}
                    >
                      <Copy size={15} />
                    </button>
                    <button
                      aria-label="Delete layer"
                      title="Delete layer"
                      disabled={!!busy || doc.layers.length <= 1}
                      onClick={() => one("delete", {}, "Delete layer")}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="native-layer-list">
                    {(preview && showPreview && !stale
                      ? preview.layers
                      : doc.layers
                    ).map((l) => (
                      <div
                        key={l.id}
                        className={`native-layer ${l.id === layer?.id ? "selected" : ""}`}
                        style={{ paddingLeft: 8 + Math.min(l.depth, 5) * 14 }}
                      >
                        <button
                          className="layer-eye"
                          aria-label={`${l.visible ? "Hide" : "Show"} ${l.name}`}
                          disabled={!!busy || !!preview}
                          onClick={() =>
                            one(
                              "visibility",
                              { layer: l.id, visible: !l.visible },
                              `${l.visible ? "Hide" : "Show"} layer`,
                            )
                          }
                        >
                          {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                        </button>
                        <button
                          className="native-layer-select"
                          onClick={() => setSelected(l.id)}
                        >
                          <span
                            className={`layer-swatch ${l.kind === "group" || l.kind === "grouplayer" ? "group" : ""}`}
                          >
                            {l.kind === "group" || l.kind === "grouplayer" ? (
                              <Group size={18} />
                            ) : (
                              <Layers size={17} />
                            )}
                          </span>
                          <span>
                            {l.name}
                            <small>
                              {l.mode} · {Math.round(l.opacity)}%
                            </small>
                          </span>
                          {l.mask && <ShieldHalf size={15} />}{" "}
                          {l.locked && <Lock size={12} />}
                        </button>
                      </div>
                    ))}
                  </div>
                  {layer && (
                    <div className="native-layer-properties">
                      <label>
                        Name{" "}
                        <input
                          aria-label="Layer name"
                          value={layerName}
                          onChange={(e) => setLayerName(e.target.value)}
                          onBlur={() => {
                            if (layerName.trim() && layerName !== layer.name)
                              one(
                                "rename",
                                { name: layerName },
                                "Rename layer",
                              );
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                      </label>
                      <label>
                        Blend{" "}
                        <select
                          aria-label="Layer blend mode"
                          value={layer.mode}
                          disabled={!!busy}
                          onChange={(e) =>
                            one(
                              "blend",
                              { mode: e.target.value },
                              "Change blend mode",
                            )
                          }
                        >
                          {![
                            "normal",
                            "multiply",
                            "screen",
                            "overlay",
                          ].includes(layer.mode) && (
                            <option value={layer.mode}>
                              {layer.mode} (native)
                            </option>
                          )}
                          <option value="normal">Normal</option>
                          <option value="multiply">Multiply</option>
                          <option value="screen">Screen</option>
                          <option value="overlay">Overlay</option>
                        </select>
                      </label>
                      <label>
                        Opacity{" "}
                        <input
                          aria-label="Layer opacity"
                          type="range"
                          min="0"
                          max="100"
                          value={layerOpacity}
                          disabled={!!busy}
                          onChange={(e) =>
                            setLayerOpacity(Number(e.target.value))
                          }
                          onPointerUp={(e) =>
                            one(
                              "opacity",
                              { value: Number(e.currentTarget.value) },
                              "Layer opacity",
                            )
                          }
                          onKeyUp={(e) => {
                            if (e.key.startsWith("Arrow"))
                              one(
                                "opacity",
                                { value: Number(e.currentTarget.value) },
                                "Layer opacity",
                              );
                          }}
                        />
                        <output>{Math.round(layerOpacity)}%</output>
                      </label>
                      <div className="native-property-buttons">
                        <button
                          disabled={!!busy}
                          onClick={() =>
                            one("reorder", { direction: -1 }, "Raise layer")
                          }
                        >
                          <ArrowUp size={14} />
                          Raise
                        </button>
                        <button
                          disabled={!!busy}
                          onClick={() =>
                            one("reorder", { direction: 1 }, "Lower layer")
                          }
                        >
                          <ArrowDown size={14} />
                          Lower
                        </button>
                        <button
                          disabled={!!busy}
                          onClick={() =>
                            one(
                              layer.mask ? "remove_mask" : "mask",
                              {},
                              layer.mask ? "Remove mask" : "Add layer mask",
                            )
                          }
                        >
                          <ShieldHalf size={14} />
                          {layer.mask ? "Remove mask" : "Add mask"}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="native-section-heading">
                    <span>
                      {isPaint ? "KRITA BRUSH PRESETS" : "GIMP BRUSHES"}
                    </span>
                    <Paintbrush size={14} />
                  </div>
                  <div className="native-brushes">
                    <input
                      aria-label="Find brush preset"
                      placeholder="Find a brush…"
                      value={presetQuery}
                      onChange={(e) => setPresetQuery(e.target.value)}
                    />
                    <select
                      size={4}
                      aria-label="Brush preset"
                      value={currentPreset}
                      onChange={(e) => {
                        setPreset(e.target.value);
                        setTool("brush");
                      }}
                    >
                      {doc.presets
                        .filter((p) =>
                          p.toLowerCase().includes(presetQuery.toLowerCase()),
                        )
                        .map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                    </select>
                    <small>
                      {isPaint
                        ? "Native Krita brush · pen pressure controls each segment"
                        : "Native GIMP brush · constant pressure"}
                    </small>
                  </div>
                  <div className="native-section-heading">
                    <span>LAYER ADJUSTMENTS</span>
                    <SlidersHorizontal size={14} />
                  </div>
                  <div className="native-adjustments">
                    <div className="native-property-buttons">
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          one("desaturate", {}, "Desaturate layer")
                        }
                      >
                        Desaturate
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() => one("invert", {}, "Invert layer")}
                      >
                        Invert
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() => one("rotate", {}, "Rotate canvas")}
                      >
                        <RotateCw size={13} />
                        Rotate
                      </button>
                    </div>
                    {!isPaint && (
                      <>
                        <label>
                          Brightness{" "}
                          <input
                            type="range"
                            aria-label="Layer brightness"
                            min="-1"
                            max="1"
                            step=".01"
                            value={brightness}
                            onChange={(e) =>
                              setBrightness(Number(e.target.value))
                            }
                          />
                        </label>
                        <label>
                          Contrast{" "}
                          <input
                            type="range"
                            aria-label="Layer contrast"
                            min="-1"
                            max="1"
                            step=".01"
                            value={contrast}
                            onChange={(e) =>
                              setContrast(Number(e.target.value))
                            }
                          />
                        </label>
                        <button
                          className="subtle"
                          disabled={
                            !!busy || (brightness === 0 && contrast === 0)
                          }
                          onClick={() =>
                            void run("Adjust layer", async () => {
                              await edit(
                                [
                                  {
                                    kind: "brightness_contrast",
                                    layer: layer?.id,
                                    brightness,
                                    contrast,
                                  },
                                ],
                                "Adjust layer",
                              );
                              setBrightness(0);
                              setContrast(0);
                            })
                          }
                        >
                          Apply to selected layer
                        </button>
                      </>
                    )}
                  </div>
                  <div className="native-handoff">
                    <strong>Continue in {isPaint ? "Edit" : "Paint"}</strong>
                    <p>
                      Copy editable pixel layers to {isPaint ? "GIMP" : "Krita"}
                      . Masks, filters, and unsupported effects are rendered
                      into the copy; this document stays intact.
                    </p>
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void run("Copying layers", async () => {
                          await invoke("engine_transfer", {
                            id: doc.id,
                            base: current().revision,
                          });
                          setNotice(
                            `Layer copy is ready in ${isPaint ? "Edit" : "Paint"}`,
                          );
                        })
                      }
                    >
                      <ArrowUpRight size={15} />
                      Copy layers to {isPaint ? "Edit" : "Paint"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="native-partner">
                  <div className="native-partner-intro">
                    <span className="native-partner-orb">
                      <Sparkles size={22} />
                    </span>
                    <h3>Your design partner</h3>
                    <p>
                      Describe a change to your layers. Review it on the canvas
                      before applying.
                    </p>
                  </div>
                  <div className="native-context">
                    <Layers size={14} />
                    <span>{layer?.name ?? "Select a layer"}</span>
                    {doc.selection && <small>Region selected</small>}
                  </div>
                  <div className="native-suggestions">
                    {[
                      "Duplicate this layer",
                      "Make this layer half transparent",
                      "Rename this layer to Pool concept",
                    ].map((p) => (
                      <button
                        key={p}
                        disabled={!!busy}
                        onClick={() => setPrompt(p)}
                      >
                        {p}
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  </div>
                  {proposal && (
                    <div className={`native-proposal ${stale ? "stale" : ""}`}>
                      <strong>
                        {proposal.supported
                          ? "Proposed change"
                          : "A different tool is needed"}
                      </strong>
                      <p>{proposal.summary}</p>
                      {stale ? (
                        <small>
                          The document changed. Request a fresh proposal.
                        </small>
                      ) : proposal.supported && preview ? (
                        <>
                          <label>
                            <input
                              type="checkbox"
                              checked={showPreview}
                              onChange={(e) => setShowPreview(e.target.checked)}
                            />
                            Preview on canvas
                          </label>
                          <div className="row">
                            <button
                              className="primary"
                              disabled={!!busy}
                              onClick={() =>
                                void run("Applying proposal", () =>
                                  edit(
                                    proposal.operations,
                                    "Apply design proposal",
                                    proposal.base,
                                    proposal.id,
                                  ),
                                )
                              }
                            >
                              <Check size={14} />
                              Apply
                            </button>
                            <button
                              onClick={() => {
                                setProposal(null);
                                setPreview(null);
                              }}
                            >
                              Discard
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>
                  )}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run("Astra is considering your document", ask);
                    }}
                  >
                    <textarea
                      aria-label={`Ask Astra about ${engine} document`}
                      placeholder="What would you like to change?"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={4}
                    />
                    <button
                      className="primary"
                      disabled={!!busy || !prompt.trim() || !layer}
                    >
                      <Sparkles size={15} />
                      Preview change
                    </button>
                  </form>
                  <small className="native-partner-note">
                    Uses your connected Codex session. Layer operations are
                    live; generative image replacement needs a separate image
                    service.
                  </small>
                </div>
              )}
            </aside>
          </div>
          <div className="native-bottom-bar">
            <span className="live-dot" />
            <span>
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={13} /> {busy}…
                </>
              ) : (
                "Native document · shared across windows"
              )}
            </span>
            <div className="workspace-spacer" />
            <span>{project.history[project.history.length - 1]}</span>
            <small>Revision {project.revision}</small>
          </div>
        </>
      )}
    </div>
  );
}
