import { useEffect, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  Pencil,
  Plus,
  Trash2,
  Undo2,
  RotateCw,
  FlipHorizontal,
  Download,
  Sparkles,
  Crop,
  Eye,
  ExternalLink,
  Check,
} from "lucide-react";
import {
  type Asset,
  type PhotoRegion,
  type RegionPoint,
  type PhotoEdit,
  type ColorAdjustments,
  neutralEdit,
  neutralColor,
} from "./model";
import { commit, current, native, useProject, detach } from "./store";
import { normalizedPoint, polygonArea } from "./regions";
import { copyColorToPhotos } from "./photo-operations";

type Preview = { data_url: string; width: number; height: number };
type PhotoProposal = {
  summary: string;
  supported: boolean;
  color: ColorAdjustments;
  revision: number;
  asset_id: string;
  region_id: string | null;
};
const controls: [keyof ColorAdjustments, string, number, number, number][] = [
  ["exposure", "Exposure", -3, 3, 0.1],
  ["contrast", "Contrast", -100, 100, 1],
  ["saturation", "Saturation", -100, 100, 1],
  ["warmth", "Warmth", -100, 100, 1],
];
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function usePreview(
  asset: Asset,
  edit: PhotoEdit,
  regions: PhotoRegion[],
  composition: boolean,
) {
  const [result, setResult] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const spec = JSON.stringify({
    assetId: asset.id,
    edit,
    regions,
    composition,
  });
  const wanted = useRef(spec);
  wanted.current = spec;
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError("");
    const timer = setTimeout(() => {
      if (!native) {
        setBusy(false);
        return;
      }
      void invoke<Preview>("photo_preview", {
        assetId: asset.id,
        edit,
        regions,
        composition,
      })
        .then((r) => {
          if (!cancelled && wanted.current === spec) {
            setResult(r);
            setBusy(false);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setError(String(e));
            setBusy(false);
          }
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [spec, asset.data_url]);
  return { result, error, busy };
}

export function PhotoEditor({
  onImport,
  selectedId,
}: {
  onImport: () => void;
  selectedId?: string;
}) {
  const doc = useProject();
  const [assetId, setAssetId] = useState(""),
    [checked, setChecked] = useState<string[]>([]);
  useEffect(() => {
    if (selectedId) setAssetId(selectedId);
  }, [selectedId]);
  const asset =
    doc.project.assets.find((a) => a.id === assetId) ?? doc.project.assets[0];
  const selection = checked.filter((id) =>
    doc.project.assets.some((a) => a.id === id),
  );
  return (
    <div className="photo-workspace">
      <div className="canvas-toolbar">
        <div className="row">
          <strong>Photo studio</strong>
          <span className="photo-subtitle">Originals preserved</span>
        </div>
        <div className="row">
          <button className="subtle" onClick={() => void detach("photos")}>
            <ExternalLink size={14} /> Detach
          </button>
          <button className="subtle" onClick={onImport}>
            <Plus size={15} /> Import photos
          </button>
        </div>
      </div>
      {asset ? (
        <>
          <div className="photo-strip">
            {doc.project.assets.map((a) => (
              <div
                className={`photo-film ${a.id === asset.id ? "chosen" : ""}`}
                key={a.id}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${a.name} for batch`}
                  checked={selection.includes(a.id)}
                  onChange={(e) =>
                    setChecked(
                      e.target.checked
                        ? [...selection, a.id]
                        : selection.filter((id) => id !== a.id),
                    )
                  }
                />
                <button onClick={() => setAssetId(a.id)}>
                  <img src={a.data_url} alt="" />
                  <span>{a.name}</span>
                  {doc.project.photo_edits?.[a.id] && <Check size={12} />}
                </button>
              </div>
            ))}
            <button
              className="subtle"
              onClick={() =>
                setChecked(
                  selection.length === doc.project.assets.length
                    ? []
                    : doc.project.assets.map((a) => a.id),
                )
              }
            >
              {selection.length === doc.project.assets.length
                ? "Deselect all"
                : "Select all"}
            </button>
          </div>
          <PhotoCanvas
            key={`${doc.file}:${asset.id}`}
            asset={asset}
            checked={selection}
          />
        </>
      ) : (
        <div className="photo-empty">
          <Pencil size={38} />
          <small>PHOTO STUDIO · V1</small>
          <h1>Your next idea starts here.</h1>
          <p>
            Bring in photographs. Adjust light and color, draw regions, and work
            with Astra to refine them.
          </p>
          <button className="primary" onClick={onImport}>
            Import photographs
          </button>
          <p>
            JPEG · PNG · WebP
            <br />
            8-bit RGB photo workflow
          </p>
        </div>
      )}
    </div>
  );
}
function PhotoCanvas({ asset, checked }: { asset: Asset; checked: string[] }) {
  const doc = useProject();
  const saved = doc.project.photo_edits?.[asset.id] ?? neutralEdit;
  const regions = (doc.project.regions ?? []).filter(
    (r) => r.asset_id === asset.id,
  );
  const [points, setPoints] = useState<RegionPoint[]>([]),
    [tool, setTool] = useState("view"),
    [shape, setShape] = useState("outline");
  const drawing = useRef<{ pointer: number; points: RegionPoint[] } | null>(
    null,
  );
  const [instruction, setInstruction] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [tab, setTab] = useState("adjust");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [before, setBefore] = useState(false),
    [showRegions, setShowRegions] = useState(true);
  const [draftColor, setDraftColor] = useState<ColorAdjustments | null>(null),
    [proposal, setProposal] = useState<PhotoProposal | null>(null),
    [asking, setAsking] = useState(false),
    [request, setRequest] = useState("");
  const [format, setFormat] = useState("png"),
    [exporting, setExporting] = useState(false),
    [progress, setProgress] = useState(""),
    [batch, setBatch] = useState(false);
  const region = regions.find((r) => r.id === selected);
  const targetColor =
    region?.adjustments ?? (region ? neutralColor : saved.color);
  const proposalValid =
    proposal?.supported &&
    proposal.revision === doc.revision &&
    proposal.region_id === (region?.id ?? null);
  const color = draftColor ?? (proposalValid ? proposal!.color : targetColor);
  const edit = {
    ...saved,
    color: before ? neutralColor : region ? saved.color : color,
  };
  const shownRegions = before
    ? []
    : regions.map((r) =>
        r.id === region?.id ? { ...r, adjustments: color } : r,
      );
  const composition = tool === "view";
  const {
    result,
    error: previewError,
    busy,
  } = usePreview(asset, edit, shownRegions, composition);
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const size = result ?? dimensions;
  useEffect(() => {
    setDraftColor(null);
    setBatch(false);
  }, [doc.revision]);
  useEffect(() => {
    let gone = false;
    let stop: (() => void) | undefined;
    void listen<{ completed: number; total: number }>(
      "photo-export-progress",
      (e) => setProgress(`${e.payload.completed} / ${e.payload.total}`),
    ).then((f) => {
      if (gone) f();
      else stop = f;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  async function protect(f: () => Promise<unknown>) {
    setError("");
    setNotice("");
    try {
      await f();
    } catch (e) {
      setError(String(e));
    }
  }
  async function setEdit(next: PhotoEdit, label: string) {
    const s = current();
    await commit(
      {
        ...s.project,
        photo_edits: { ...s.project.photo_edits, [asset.id]: next },
      },
      label,
      s.revision,
    );
    setDraftColor(null);
    setProposal(null);
  }
  async function applyColor(
    c: ColorAdjustments,
    base = current().revision,
    label = "Adjust photo color",
  ) {
    const s = current();
    if (base !== s.revision)
      throw Error(
        "The project changed. Review the latest photo and try again.",
      );
    if (region)
      await commit(
        {
          ...s.project,
          regions: (s.project.regions ?? []).map((r) =>
            r.id === region.id ? { ...r, adjustments: c } : r,
          ),
        },
        label,
        base,
      );
    else
      await commit(
        {
          ...s.project,
          photo_edits: {
            ...s.project.photo_edits,
            [asset.id]: {
              ...(s.project.photo_edits?.[asset.id] ?? neutralEdit),
              color: c,
            },
          },
        },
        label,
        base,
      );
    setDraftColor(null);
    setProposal(null);
  }
  function point(e: PointerEvent<SVGSVGElement>) {
    return normalizedPoint(
      e.clientX,
      e.clientY,
      e.currentTarget.getBoundingClientRect(),
      e.pointerType === "pen" ? e.pressure : 0.5,
    );
  }
  function down(e: PointerEvent<SVGSVGElement>) {
    if (!native || tool === "view" || busy || e.button !== 0 || !e.isPrimary)
      return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = point(e);
    drawing.current = { pointer: e.pointerId, points: [start] };
    setPoints([start]);
    setSelected(null);
    setProposal(null);
  }
  function move(e: PointerEvent<SVGSVGElement>) {
    const draft = drawing.current;
    if (!draft || draft.pointer !== e.pointerId) return;
    const next = point(e),
      last = draft.points.at(-1)!;
    if (tool === "crop" || shape === "rectangle") {
      const start = draft.points[0];
      setPoints([
        start,
        { ...next, y: start.y },
        next,
        { ...next, x: start.x },
      ]);
      return;
    }
    if (
      draft.points.length < 4096 &&
      Math.hypot(next.x - last.x, next.y - last.y) > 0.001
    ) {
      draft.points.push(next);
      setPoints([...draft.points]);
    }
  }
  function up(e: PointerEvent<SVGSVGElement>) {
    if (drawing.current?.pointer !== e.pointerId) return;
    move(e);
    drawing.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  }
  async function saveRegion() {
    const s = current();
    const r: PhotoRegion = {
      id: crypto.randomUUID(),
      asset_id: asset.id,
      points,
      instruction: instruction.trim() || `Region ${regions.length + 1}`,
      adjustments: neutralColor,
    };
    await commit(
      { ...s.project, regions: [...(s.project.regions ?? []), r] },
      "Add photo region",
      s.revision,
    );
    setPoints([]);
    setInstruction("");
    setSelected(r.id);
    setTab("adjust");
    setNotice("Region saved. Color controls now affect this area only.");
  }
  async function crop() {
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y);
    const x = Math.min(...xs),
      y = Math.min(...ys);
    await setEdit(
      {
        ...saved,
        crop: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
      },
      "Crop photo",
    );
    setTool("view");
    setPoints([]);
  }
  async function removeRegion(id: string) {
    const s = current();
    await commit(
      {
        ...s.project,
        regions: (s.project.regions ?? []).filter((r) => r.id !== id),
      },
      "Remove photo region",
      s.revision,
    );
    if (selected === id) setSelected(null);
  }
  async function ask() {
    setAsking(true);
    setProposal(null);
    try {
      const p = await invoke<PhotoProposal>("photo_propose", {
        prompt: request,
        revision: doc.revision,
        assetId: asset.id,
        regionId: region?.id ?? null,
      });
      setProposal(p);
      setBefore(false);
    } finally {
      setAsking(false);
    }
  }
  async function exportPhotos() {
    if (proposalValid || draftColor)
      throw Error("Apply or discard the preview before exporting.");
    const directory = await open({
      title: "Choose a folder for finished photos",
      directory: true,
      multiple: false,
    });
    if (typeof directory !== "string") return;
    setExporting(true);
    setProgress("Starting…");
    try {
      const r = await invoke<{ directory: string; files: string[] }>(
        "export_photos",
        {
          assetIds: checked.length ? checked : [asset.id],
          directory,
          format,
          revision: current().revision,
        },
      );
      setNotice(
        `Exported ${r.files.length} photo${r.files.length === 1 ? "" : "s"} to ${r.directory}`,
      );
    } finally {
      setExporting(false);
    }
  }
  const coordinates = (p: RegionPoint[]) =>
    p.map((v) => `${v.x * size.width},${v.y * size.height}`).join(" ");
  const hasArea = points.length >= 3 && polygonArea(points) >= 0.0001;
  return (
    <div className="photo-editor-body">
      <div className="photo-canvas-column">
        <div className="photo-hint">
          {(
            [
              ["view", "View", Eye],
              ["region", "Region", Pencil],
              ["crop", "Crop", Crop],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              className={tool === id ? "chosen" : ""}
              key={id}
              onClick={() => {
                setTool(id);
                setPoints([]);
                if (id === "region") setTab("regions");
              }}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
          {tool === "region" && (
            <select
              aria-label="Region drawing tool"
              value={shape}
              onChange={(e) => setShape(e.target.value)}
            >
              <option value="outline">Freehand outline</option>
              <option value="rectangle">Rectangle</option>
            </select>
          )}
          <button
            title="Rotate clockwise"
            onClick={() =>
              void protect(async () => {
                await setEdit(
                  { ...saved, quarter_turns: (saved.quarter_turns + 1) % 4 },
                  "Rotate photo",
                );
                setTool("view");
              })
            }
          >
            <RotateCw size={15} />
          </button>
          <button
            title="Flip horizontally"
            onClick={() =>
              void protect(async () => {
                await setEdit(
                  { ...saved, flip_x: !saved.flip_x },
                  "Flip photo",
                );
                setTool("view");
              })
            }
          >
            <FlipHorizontal size={15} />
          </button>
          <label>
            <input
              type="checkbox"
              checked={before}
              onChange={(e) => setBefore(e.target.checked)}
            />
            Before
          </label>
        </div>
        <div className="photo-stage">
          <div
            className="photo-sheet"
            style={{
              aspectRatio: `${size.width}/${size.height}`,
              maxWidth: `min(100%, calc((100vh - 360px) * ${size.width / size.height}))`,
            }}
          >
            <img
              draggable={false}
              src={result?.data_url ?? asset.data_url}
              alt={`${before ? "Before" : "Edited"} ${asset.name}`}
              onLoad={(e) => {
                if (!result)
                  setDimensions({
                    width: e.currentTarget.naturalWidth,
                    height: e.currentTarget.naturalHeight,
                  });
              }}
            />
            {!composition && (
              <svg
                viewBox={`0 0 ${size.width} ${size.height}`}
                aria-label="Draw a region on the photograph"
                role="img"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={() => {
                  drawing.current = null;
                  setPoints([]);
                }}
              >
                {showRegions &&
                  !before &&
                  tool === "region" &&
                  regions.map((r, i) => (
                    <g key={r.id}>
                      <polygon
                        className={
                          r.id === selected ? "region selected" : "region"
                        }
                        points={coordinates(r.points)}
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x={r.points[0].x * size.width}
                        y={r.points[0].y * size.height}
                        fontSize={Math.max(size.width / 50, 12)}
                        fill="white"
                      >
                        {i + 1}
                      </text>
                    </g>
                  ))}
                {points.length > 0 && (
                  <polygon
                    className="region draft"
                    points={coordinates(points)}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {tool === "crop" && saved.crop && points.length === 0 && (
                  <rect
                    className="region"
                    x={saved.crop.x * size.width}
                    y={saved.crop.y * size.height}
                    width={saved.crop.width * size.width}
                    height={saved.crop.height * size.height}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </svg>
            )}
            {(busy || proposalValid || before) && (
              <span className="photo-preview-badge">
                {busy
                  ? "Updating preview…"
                  : before
                    ? "Before adjustments"
                    : "AI preview · not applied"}
              </span>
            )}
          </div>
        </div>
        <div className="photo-caption">
          {tool === "crop"
            ? "Draw a rectangle on the full original. Crop is applied before rotation."
            : tool === "region"
              ? "Draw on the full original. Regions stay aligned through crop and rotation."
              : "Finished composition · Original pixels preserved in your project"}
          {previewError && <span role="alert"> {previewError}</span>}
        </div>
        {tool === "crop" && (
          <div className="photo-action-bar">
            <button
              className="primary"
              disabled={!hasArea}
              onClick={() => void protect(crop)}
            >
              Apply crop
            </button>
            <button
              className="subtle"
              disabled={!saved.crop}
              onClick={() =>
                void protect(() =>
                  setEdit({ ...saved, crop: null }, "Reset crop"),
                )
              }
            >
              Reset crop
            </button>
          </div>
        )}
        <div className="photo-export-bar">
          <span>
            {checked.length ? `${checked.length} photos selected` : asset.name}
          </span>
          <select
            aria-label="Export format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
          </select>
          <button
            className="primary"
            disabled={exporting || !!proposalValid || !!draftColor}
            onClick={() => void protect(exportPhotos)}
          >
            <Download size={15} />
            {exporting
              ? `Exporting ${progress}`
              : `Export ${checked.length > 1 ? `${checked.length} photos` : "photo"}`}
          </button>
        </div>
      </div>
      <aside className="photo-instructions">
        <div className="photo-panel-tabs">
          {[
            ["adjust", "Adjust"],
            ["regions", "Regions"],
            ["ai", "Astra"],
            ["batch", "Batch"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="photo-target">
          Editing
          <select
            aria-label="Adjustment target"
            value={region?.id ?? ""}
            onChange={(e) => {
              setSelected(e.target.value || null);
              setDraftColor(null);
              setProposal(null);
            }}
          >
            <option value="">Whole photo</option>
            {regions.map((r, i) => (
              <option key={r.id} value={r.id}>
                Region {i + 1} · {r.instruction.slice(0, 30)}
              </option>
            ))}
          </select>
        </label>
        {tab === "adjust" && (
          <>
            <small>LIGHT & COLOR</small>
            <h2>
              {region ? "Refine this region." : "Find the right feeling."}
            </h2>
            {controls.map(([key, label, min, max, step]) => (
              <ColorControl
                key={`${region?.id ?? "all"}:${key}`}
                label={label}
                value={color[key]}
                min={min}
                max={max}
                step={step}
                onPreview={(v) => {
                  setBefore(false);
                  setProposal(null);
                  setDraftColor({ ...color, [key]: v });
                }}
                onApply={(v) =>
                  void protect(() => applyColor({ ...color, [key]: v }))
                }
              />
            ))}
            <button
              className="subtle"
              onClick={() => void protect(() => applyColor(neutralColor))}
            >
              <Undo2 size={14} /> Reset color
            </button>
            <p>
              Each finished slider adjustment is one undo step.{" "}
              {region
                ? "Outside pixels stay unchanged."
                : "Crop and rotation remain separate."}
            </p>
          </>
        )}
        {tab === "regions" && (
          <>
            <small>LOCAL EDITS</small>
            <h2>Show me where.</h2>
            <p>Draw an outline or rectangle, then save the area.</p>
            <textarea
              aria-label="Photo region instruction"
              placeholder="Brighten the water and make it more turquoise…"
              maxLength={8000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <div className="row">
              <button
                className="subtle"
                disabled={!points.length}
                onClick={() => setPoints([])}
              >
                Clear outline
              </button>
              <button
                className="primary"
                disabled={!hasArea}
                onClick={() => void protect(saveRegion)}
              >
                Save region
              </button>
            </div>
            <label className="photo-check">
              <input
                type="checkbox"
                checked={showRegions}
                onChange={(e) => setShowRegions(e.target.checked)}
              />
              Show region outlines
            </label>
            <h3>Saved regions · {regions.length}</h3>
            {regions.map((r, i) => (
              <div
                className={`region-card ${r.id === selected ? "selected" : ""}`}
                key={r.id}
              >
                <button
                  className="region-description"
                  onClick={() => {
                    setSelected(r.id);
                    setTool("region");
                    setShowRegions(true);
                    setTab("adjust");
                  }}
                >
                  <b>Region {i + 1}</b>
                  <span>{r.instruction}</span>
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove region ${i + 1}`}
                  onClick={() => void protect(() => removeRegion(r.id))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </>
        )}
        {tab === "ai" && (
          <>
            <small>YOUR DESIGN PARTNER</small>
            <h2>Shape the mood.</h2>
            <p>
              Astra can inspect this photo and propose exposure, contrast,
              saturation, and warmth changes.
            </p>
            <textarea
              aria-label="Ask Astra about this photo"
              placeholder="Warm up this photo and gently brighten the shadows…"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              maxLength={8000}
            />
            <button
              className="primary"
              disabled={asking || !request.trim()}
              onClick={() => void protect(ask)}
            >
              <Sparkles size={15} />
              {asking ? "Considering the photo…" : "Ask Astra"}
            </button>
            <p className="photo-boundary">
              Sends a photo preview and your instruction to OpenAI using your
              Codex sign-in. Object generation and removal are not available in
              this version.
            </p>
            {proposal && (
              <div className="proposal-card">
                <strong>
                  {proposal.supported
                    ? "Proposed adjustment"
                    : "Outside current tools"}
                </strong>
                <p>{proposal.summary}</p>
                {proposal.supported && (
                  <>
                    <div className="photo-values">
                      {controls.map(([k, l]) => (
                        <span key={k}>
                          {l}
                          <b>{proposal.color[k]}</b>
                        </span>
                      ))}
                    </div>
                    {proposal.revision !== doc.revision ? (
                      <p>The project changed. Ask for a fresh proposal.</p>
                    ) : (
                      <button
                        className="primary"
                        onClick={() =>
                          void protect(() =>
                            applyColor(
                              proposal.color,
                              proposal.revision,
                              "Apply AI photo proposal",
                            ),
                          )
                        }
                      >
                        Apply proposal
                      </button>
                    )}
                  </>
                )}
                <button className="subtle" onClick={() => setProposal(null)}>
                  Discard
                </button>
              </div>
            )}
          </>
        )}
        {tab === "batch" && (
          <>
            <small>CONSISTENT SETS</small>
            <h2>Carry the look across.</h2>
            <p>
              Select photos in the strip above. Copy this photo’s saved
              whole-image color settings to the set. Their crops, rotations and
              regional edits stay intact.
            </p>
            <button
              className="subtle"
              disabled={!checked.length}
              onClick={() => setBatch(true)}
            >
              Preview on {checked.length} selected
            </button>
            {batch && (
              <>
                <div className="batch-previews">
                  {doc.project.assets
                    .filter((a) => checked.includes(a.id))
                    .slice(0, 4)
                    .map((a) => (
                      <BatchPreview key={a.id} asset={a} color={saved.color} />
                    ))}
                </div>
                <p>
                  {checked.length > 4
                    ? "Showing the first four selected photos. "
                    : ""}
                  This replaces whole-photo color settings on {checked.length}{" "}
                  photo{checked.length === 1 ? "" : "s"}.
                </p>
                <button
                  className="primary"
                  onClick={() =>
                    void protect(async () => {
                      const s = current();
                      await commit(
                        copyColorToPhotos(s.project, checked, saved.color),
                        `Apply color to ${checked.length} photos`,
                        s.revision,
                      );
                      setBatch(false);
                      setNotice("Batch applied. Undo restores the entire set.");
                    })
                  }
                >
                  Apply to {checked.length} photos
                </button>
              </>
            )}
          </>
        )}
        {(error || notice) && (
          <p
            className={error ? "photo-error" : "photo-notice"}
            role={error ? "alert" : "status"}
          >
            {error || notice}
          </p>
        )}
      </aside>
    </div>
  );
}
function ColorControl({
  label,
  value,
  min,
  max,
  step,
  onPreview,
  onApply,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onPreview: (n: number) => void;
  onApply: (n: number) => void;
}) {
  const draft = useRef(value);
  draft.current = value;
  const origin = useRef(value);
  return (
    <label className="photo-color-control">
      <span>
        {label}
        <output>{value.toFixed(step < 1 ? 1 : 0)}</output>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={() => {
          origin.current = value;
        }}
        onChange={(e) => {
          draft.current = Number(e.target.value);
          onPreview(draft.current);
        }}
        onPointerUp={() => {
          if (draft.current !== origin.current) {
            origin.current = draft.current;
            onApply(draft.current);
          }
        }}
        onKeyDown={(e) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(e.key)
          )
            origin.current = value;
        }}
        onKeyUp={(e) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(e.key)
          ) {
            origin.current = Number(e.currentTarget.value);
            onApply(origin.current);
          }
        }}
        onBlur={() => {
          if (draft.current !== origin.current) {
            origin.current = draft.current;
            onApply(draft.current);
          }
        }}
      />
    </label>
  );
}
function BatchPreview({
  asset,
  color,
}: {
  asset: Asset;
  color: ColorAdjustments;
}) {
  const doc = useProject();
  const edit = {
    ...(doc.project.photo_edits?.[asset.id] ?? neutralEdit),
    color,
  };
  const { result, busy, error } = usePreview(
    asset,
    edit,
    (doc.project.regions ?? []).filter((r) => r.asset_id === asset.id),
    true,
  );
  return (
    <div>
      <img
        src={result?.data_url ?? asset.data_url}
        alt={`Batch preview ${asset.name}`}
      />
      <span>
        {busy ? "Updating…" : error ? "Preview unavailable" : asset.name}
      </span>
    </div>
  );
}
