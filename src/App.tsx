import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save as saveDialog, confirm } from "@tauri-apps/plugin-dialog";
import {
  availableMonitors,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import {
  ArrowUp,
  Box,
  Boxes,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  Expand,
  ExternalLink,
  Eye,
  FolderOpen,
  GitBranch,
  Grid2X2,
  House,
  Image,
  Layers,
  Link2,
  LoaderCircle,
  Maximize2,
  Monitor,
  Paintbrush,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Undo2,
  Unlink,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import { Viewport, type ViewportHandle } from "./Viewport";
import { PhotoEditor } from "./PhotoEditor";
import {
  commit,
  current,
  detach,
  getIntegrations,
  history,
  initialize,
  load,
  native,
  save,
  startRender,
  useProject,
  useRender,
} from "./store";
import {
  type Asset,
  type Integration,
  type Proposal,
  type SceneSettings,
  validateScene,
} from "./model";

const workspaces = [
  ["Library", Image],
  ["Develop", SlidersHorizontal],
  ["Edit", Layers],
  ["Paint", Paintbrush],
  ["Scene", Box],
  ["CAD", Boxes],
  ["Workflows", Workflow],
] as const;
const detached = new URLSearchParams(location.search).get("view");
const objects = [
  ["House", House],
  ["Terrain", Layers],
  ["Pool", Box],
  ["Pool deck", Grid2X2],
  ["Planters", Boxes],
  ["Camera", Camera],
] as const;
const hints: Record<
  string,
  { engine: string; title: string; description: string }
> = {
  Develop: {
    engine: "darktable",
    title: "A home for your digital negatives",
    description:
      "RAW development, color management and photo collections will connect through the darktable adapter. Your original images remain untouched.",
  },
  Edit: {
    engine: "GIMP",
    title: "Compositing with editable layers",
    description:
      "The GIMP adapter will bring selections, masks and layered image operations into the shared project.",
  },
  Paint: {
    engine: "Krita",
    title: "A canvas for your hand and your ideas",
    description:
      "The Krita adapter will provide the painting workspace. Brush strokes, references and AI proposals will meet in the same document.",
  },
  CAD: {
    engine: "FreeCAD",
    title: "From an idea to a dimensioned object",
    description:
      "The FreeCAD adapter will keep parametric solids and dimensions authoritative. Scene meshes will be derived previews.",
  },
};
function IconButton({
  title,
  children,
  onClick,
  disabled = false,
}: {
  title: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      aria-label={title}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function SectionLabel({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {action}
    </div>
  );
}
function Parameter({
  label,
  value,
  min,
  max,
  step = 0.1,
  onCommit,
  unit = "m",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (v: number) => void;
  unit?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="parameter">
      <span>
        {label}
        <output>
          {draft.toFixed(step < 1 ? 2 : 0)} <small>{unit}</small>
        </output>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => {
          if (draft !== value) onCommit(draft);
        }}
        onKeyUp={() => {
          if (draft !== value) onCommit(draft);
        }}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
      />
    </label>
  );
}
export function App() {
  const doc = useProject(),
    render = useRender();
  const view = useRef<ViewportHandle>(null);
  const [workspace, setWorkspace] = useState(
    detached === "photos"
      ? "Edit"
      : detached === "workflows"
        ? "Workflows"
        : detached === "library"
          ? "Library"
          : detached === "wireframe" || detached === "render"
            ? "Scene"
            : "Edit",
  );
  const [mode, setMode] = useState(
    detached === "wireframe"
      ? "wireframe"
      : detached === "render"
        ? "final"
        : "shaded",
  );
  const [linked, setLinked] = useState(false),
    [selected, setSelected] = useState("Pool"),
    [panel, setPanel] = useState("partner");
  const [integrations, setIntegrations] = useState<Integration[]>([]),
    [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [prompt, setPrompt] = useState(""),
    [asking, setAsking] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null),
    [previewProposal, setPreviewProposal] = useState(true),
    [exporting, setExporting] = useState(false);
  const [activeAsset, setActiveAsset] = useState<Asset | null>(null),
    [monitors, setMonitors] = useState<
      {
        name: string | null;
        position: { x: number; y: number };
        size: { width: number; height: number };
        scaleFactor: number;
      }[]
    >([]);
  const [photoAssetId, setPhotoAssetId] = useState("");
  const [recoveryStatus, setRecoveryStatus] = useState("");
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{ ok: boolean; error?: string }>("recovery-status", (e) => {
      setRecoveryStatus(
        e.payload.ok ? "Recovery saved" : "Recovery unavailable",
      );
      if (!e.payload.ok)
        setError(
          `Recovery copy could not be saved: ${e.payload.error}. Save the project explicitly.`,
        );
    }).then((f) => {
      if (disposed) f();
      else stop = f;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const [recipeCoping, setRecipeCoping] = useState(0.65),
    [recipeWidth, setRecipeWidth] = useState(7),
    [recipeStatus, setRecipeStatus] = useState("Ready to preview");
  const stale = render.image && render.revision !== doc.revision;
  const proposalStale = proposal !== null && proposal.revision !== doc.revision;
  const scene =
    proposal && previewProposal && !proposalStale
      ? proposal.scene
      : doc.project.scene;
  const busy = render.status === "running" || exporting;
  const protect = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    if (!native || detached) return;
    let allowClose = false,
      disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (allowClose || current().revision === current().saved_revision)
          return;
        event.preventDefault();
        if (
          await confirm(
            "This project has unsaved changes. Close without saving?",
            { title: "Unsaved project", kind: "warning" },
          )
        ) {
          allowClose = true;
          await getCurrentWindow().close();
        }
      })
      .then((f) => {
        if (disposed) f();
        else unlisten = f;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    void protect(async () => {
      await initialize();
      setIntegrations(await getIntegrations());
      if (native) setMonitors(await availableMonitors());
    });
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function saveFile(asNew = false) {
    let path = asNew ? null : doc.file;
    if (!path)
      path = await saveDialog({
        title: "Save Reality Workshop project",
        defaultPath: `${doc.project.name}.workshop`,
        filters: [{ name: "Workshop project", extensions: ["workshop"] }],
      });
    if (path) {
      await save(path);
      setNotice("Project saved, including reference images.");
    }
  }
  async function openFile() {
    if (
      doc.revision !== doc.saved_revision &&
      !(await confirm("Open another project and discard unsaved changes?", {
        title: "Unsaved project",
        kind: "warning",
      }))
    )
      return;
    const path = await open({
      title: "Open project",
      multiple: false,
      filters: [{ name: "Workshop project", extensions: ["workshop"] }],
    });
    if (typeof path === "string") {
      await load(path);
      setProposal(null);
      setActiveAsset(null);
      setNotice("Project opened");
    }
  }
  async function importPhoto() {
    const paths = await open({
      title: "Import reference photographs",
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (!paths) return;
    const assets: Asset[] = [];
    for (const path of typeof paths === "string" ? [paths] : paths)
      assets.push(await invoke<Asset>("import_image", { path }));
    const s = current();
    await commit(
      { ...s.project, assets: [...s.project.assets, ...assets] },
      "Import reference photographs",
      s.revision,
    );
    setWorkspace("Edit");
    setNotice(
      `${assets.length} reference image${assets.length === 1 ? "" : "s"} imported`,
    );
  }
  async function editScene(key: keyof SceneSettings, value: number | string) {
    const s = current();
    await commit(
      { ...s.project, scene: { ...s.project.scene, [key]: value } },
      `Adjust ${key.replaceAll("_", " ")}`,
      s.revision,
    );
  }
  async function renderScene() {
    if (proposal && previewProposal && !proposalStale)
      throw Error(
        "Apply or hide the proposal before rendering a saved scene revision.",
      );
    if (!view.current) throw Error("Open the Scene workspace to render.");
    setExporting(true);
    try {
      const revision = current().revision;
      const gltf = await view.current.export();
      await detach("render");
      await startRender(gltf, revision);
    } finally {
      setExporting(false);
    }
  }
  async function ask() {
    if (!prompt.trim()) return;
    setAsking(true);
    setProposal(null);
    try {
      const p = await invoke<Proposal>("agent_propose", {
        prompt,
        revision: doc.revision,
      });
      if (!validateScene(p.scene))
        throw Error("The proposal contains unsupported values");
      setProposal(p);
      setPreviewProposal(true);
    } finally {
      setAsking(false);
    }
  }
  async function applyProposal() {
    if (!proposal) return;
    await commit(
      { ...doc.project, scene: proposal.scene },
      "Apply design proposal",
      proposal.revision,
    );
    setProposal(null);
    setNotice("Proposal applied. Undo is available in every window.");
  }
  async function moveToMonitor(index: number) {
    const m = monitors[index];
    if (!m) return;
    const w = getCurrentWindow();
    await w.setSize(
      new PhysicalSize(
        Math.min(1300 * m.scaleFactor, m.size.width * 0.9),
        Math.min(850 * m.scaleFactor, m.size.height * 0.88),
      ),
    );
    await w.setPosition(
      new PhysicalPosition(
        m.position.x + 40 * m.scaleFactor,
        m.position.y + 60 * m.scaleFactor,
      ),
    );
    await w.setFocus();
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void protect(saveFile);
      } else if (
        e.key.toLowerCase() === "z" &&
        !(
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        )
      ) {
        e.preventDefault();
        void protect(() => history(e.shiftKey));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [doc]);

  const renderControls = (
    <>
      <button
        className="subtle"
        onClick={() => void protect(() => detach("wireframe"))}
      >
        <ExternalLink size={14} />
        Wireframe window
      </button>
      <button
        className="primary small"
        disabled={busy || !native}
        onClick={() => void protect(renderScene)}
      >
        {busy ? <LoaderCircle className="spin" size={15} /> : <Sun size={15} />}{" "}
        {busy ? "Rendering…" : "Render with Blender"}
      </button>
    </>
  );
  const params = (
    <div className="parameter-group">
      <Parameter
        label="Pool width"
        value={doc.project.scene.pool_width}
        min={2}
        max={12}
        onCommit={(v) => void protect(() => editScene("pool_width", v))}
      />
      <Parameter
        label="Pool length"
        value={doc.project.scene.pool_length}
        min={3}
        max={16}
        onCommit={(v) => void protect(() => editScene("pool_length", v))}
      />
      <Parameter
        label="Stone coping"
        value={doc.project.scene.coping}
        min={0.1}
        max={1.5}
        step={0.05}
        onCommit={(v) => void protect(() => editScene("coping", v))}
      />
      <Parameter
        label="Sun direction"
        value={doc.project.scene.sun_angle}
        min={5}
        max={175}
        step={1}
        unit="°"
        onCommit={(v) => void protect(() => editScene("sun_angle", v))}
      />
      <label className="color-row">
        Water color
        <input
          aria-label="Water color"
          type="color"
          value={doc.project.scene.water_color}
          onChange={(e) =>
            void protect(() => editScene("water_color", e.target.value))
          }
        />
        <code>{doc.project.scene.water_color}</code>
      </label>
    </div>
  );
  const assetGrid = (
    <div className="library-grid">
      {doc.project.assets.map((a) => (
        <button
          key={a.id}
          className="photo-card"
          onClick={() => {
            setPhotoAssetId(a.id);
            setWorkspace("Edit");
          }}
        >
          <img src={a.data_url} alt={a.name} />
          <span>{a.name}</span>
          <small>Original reference</small>
        </button>
      ))}
      <button className="import-tile" onClick={() => void protect(importPhoto)}>
        <Plus size={26} />
        <span>Import photographs</span>
        <small>PNG · JPEG · WebP</small>
      </button>
    </div>
  );

  return (
    <main className={`studio ${detached ? "detached" : ""}`}>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">⌘</span>
          <strong>Reality Workshop</strong>
          <span className="alpha">PHOTO V1</span>
        </div>
        <div className="project-title">
          {doc.project.name}
          <ChevronDown size={13} />
          <span
            className={`save-dot ${doc.revision !== doc.saved_revision ? "dirty" : ""}`}
          />
          <small>
            {doc.revision === doc.saved_revision ? "Saved" : "Unsaved"}
          </small>
        </div>
        <div className="title-actions">
          <IconButton
            title="New photo project"
            onClick={() =>
              void protect(async () => {
                if (
                  doc.revision !== doc.saved_revision &&
                  !(await confirm(
                    "Start a new project and discard unsaved changes?",
                    { title: "Unsaved project", kind: "warning" },
                  ))
                )
                  return;
                await invoke("new_project");
                setWorkspace("Edit");
                setProposal(null);
              })
            }
          >
            <Plus size={16} />
          </IconButton>
          <button
            className="subtle"
            onClick={() => void protect(() => saveFile(true))}
          >
            Save as…
          </button>
          <IconButton
            title="Open project"
            onClick={() => void protect(openFile)}
          >
            <FolderOpen size={16} />
          </IconButton>
          <IconButton
            title="Save project (⌘S)"
            onClick={() => void protect(() => saveFile())}
          >
            <Save size={16} />
          </IconButton>
          <IconButton
            title="Undo (⌘Z)"
            disabled={!doc.can_undo}
            onClick={() => void protect(() => history())}
          >
            <Undo2 size={16} />
          </IconButton>
          <IconButton
            title="Redo (⇧⌘Z)"
            disabled={!doc.can_redo}
            onClick={() => void protect(() => history(true))}
          >
            <Redo2 size={16} />
          </IconButton>
          <IconButton
            title="Engine connections"
            onClick={() => setShowSettings(true)}
          >
            <Settings2 size={16} />
          </IconButton>
        </div>
      </header>
      {!detached ? (
        <nav className="workspace-bar">
          {workspaces.map(([name, Icon]) => (
            <button
              key={name}
              className={workspace === name ? "active" : ""}
              onClick={() => {
                setWorkspace(name);
                setActiveAsset(null);
              }}
            >
              <Icon size={18} />
              {name}
            </button>
          ))}
          <div className="workspace-spacer" />
          <button
            className="capture"
            onClick={() =>
              setNotice(
                "iPhone capture is planned. Import existing photographs from the Library today.",
              )
            }
          >
            <Camera size={16} />
            Capture from iPhone<span className="planned">PLANNED</span>
          </button>
        </nav>
      ) : (
        <div className="detached-bar">
          <div>
            <span className="live-dot" />
            {detached === "wireframe"
              ? "Geometry viewport"
              : detached === "render"
                ? "Render studio"
                : workspace}
            <small>Shared project · revision {doc.revision}</small>
          </div>
          <div className="row">
            <select
              aria-label="Move window to display"
              defaultValue=""
              onChange={(e) =>
                void protect(() => moveToMonitor(Number(e.target.value)))
              }
            >
              <option value="" disabled>
                Move to display…
              </option>
              {monitors.map((m, i) => (
                <option value={i} key={i}>
                  {m.name || `Display ${i + 1}`}
                </option>
              ))}
            </select>
            <button
              className="subtle"
              onClick={() =>
                setPanel(panel === "properties" ? "partner" : "properties")
              }
            >
              <SlidersHorizontal size={14} />
              Controls
            </button>
          </div>
        </div>
      )}
      <div className="body-grid">
        {!detached && (
          <aside className="assets-panel">
            <SectionLabel
              action={
                <IconButton
                  title="Import reference images"
                  onClick={() => void protect(importPhoto)}
                >
                  <Plus size={15} />
                </IconButton>
              }
            >
              PROJECT
            </SectionLabel>
            <div className="asset-tiles">
              <button
                className="asset-tile"
                onClick={() => setWorkspace("Library")}
              >
                <div className="tile-art photos">
                  <Image size={36} />
                </div>
                <span>House photos</span>
                <small>{doc.project.assets.length} references</small>
              </button>
              <button
                className="asset-tile"
                onClick={() => {
                  setWorkspace("Scene");
                  setMode("wireframe");
                }}
              >
                <div className="tile-art scan">
                  <Boxes size={40} />
                </div>
                <span>Coastal scene</span>
                <small>Starter geometry</small>
              </button>
              <button
                className="asset-tile"
                onClick={() => {
                  setSelected("Pool");
                  setWorkspace("Scene");
                }}
              >
                <div className="tile-art pool">
                  <span />
                </div>
                <span>Pool study</span>
                <small>Editable dimensions</small>
              </button>
              <button
                className="asset-tile"
                onClick={() => setWorkspace("CAD")}
              >
                <div className="tile-art cad">
                  <Box size={36} />
                </div>
                <span>CAD objects</span>
                <small>FreeCAD adapter planned</small>
              </button>
            </div>
            <SectionLabel>SCENE</SectionLabel>
            <div className="object-list">
              {objects.map(([name, Icon]) => (
                <button
                  className={selected === name ? "selected" : ""}
                  key={name}
                  onClick={() => {
                    setSelected(name);
                    if (name === "Pool") setPanel("properties");
                  }}
                >
                  <ChevronRight size={12} />
                  <Icon size={17} />
                  <span>{name}</span>
                  <Eye size={14} />
                </button>
              ))}
            </div>
            <div className="project-foot">
              <span className="live-dot" />
              Shared across windows<small>Scene units · metres</small>
            </div>
          </aside>
        )}
        <section className="main-workspace">
          <div
            hidden={workspace !== "Edit" && workspace !== "Develop"}
            className="photo-workspace-mount"
          >
            <PhotoEditor
              key={doc.file ?? "unsaved"}
              selectedId={photoAssetId}
              onImport={() => void protect(importPhoto)}
            />
          </div>
          {workspace === "Scene" ? (
            <>
              <div className="canvas-toolbar">
                <div className="row">
                  <Box size={17} />
                  <strong>{selected}</strong>
                  <span className="divider" />
                  <button
                    className={mode === "wireframe" ? "chosen" : ""}
                    onClick={() => setMode("wireframe")}
                  >
                    Wireframe
                  </button>
                  <button
                    className={mode === "shaded" ? "chosen" : ""}
                    onClick={() => setMode("shaded")}
                  >
                    Shaded
                  </button>
                  <button
                    className={mode === "final" ? "chosen" : ""}
                    onClick={() => setMode("final")}
                  >
                    Final render
                  </button>
                </div>
                <div className="row">
                  <IconButton
                    title={
                      linked ? "Unlink cameras" : "Link cameras across windows"
                    }
                    onClick={() => setLinked(!linked)}
                  >
                    {linked ? <Link2 size={16} /> : <Unlink size={16} />}
                  </IconButton>
                  <IconButton
                    title="Reset camera"
                    onClick={() => view.current?.reset()}
                  >
                    <RotateCcw size={16} />
                  </IconButton>
                  <IconButton
                    title="Detach this viewport"
                    onClick={() =>
                      void protect(() =>
                        detach(mode === "wireframe" ? "wireframe" : "render"),
                      )
                    }
                  >
                    <ExternalLink size={16} />
                  </IconButton>
                </div>
              </div>
              <div className="canvas-area">
                <Viewport
                  ref={view}
                  settings={scene}
                  wireframe={mode === "wireframe"}
                  linked={linked}
                />
                {mode === "final" && render.image && (
                  <img
                    className="final-image"
                    alt={`Blender render of project revision ${render.revision}`}
                    src={render.image}
                  />
                )}
                <div className="canvas-caption">
                  <span className="live-dot" />
                  {mode === "final" && render.image
                    ? `Blender · revision ${render.revision}`
                    : mode === "wireframe"
                      ? "Interactive geometry"
                      : "Real-time shaded preview"}
                  {proposal && previewProposal && !proposalStale && (
                    <span className="amber">Proposal · not applied</span>
                  )}
                  {stale && mode === "final" && (
                    <span className="amber">
                      Scene has changed · render again
                    </span>
                  )}
                </div>
                <div className="orbit-help">
                  Drag to orbit <span>·</span> Scroll to zoom <span>·</span>{" "}
                  Right-drag to pan
                </div>
                {mode === "final" && !render.image && (
                  <div className="render-nudge">
                    <Sun size={18} />
                    <span>
                      {busy
                        ? "Blender is rendering in the background. Keep working in another window."
                        : "This is the live preview. Render with Blender for a finished image."}
                    </span>
                  </div>
                )}
              </div>
              <div className="render-toolbar">
                <span>
                  {linked ? (
                    <>
                      <Link2 size={13} />
                      Cameras linked
                    </>
                  ) : (
                    <>
                      <Monitor size={13} />
                      Independent camera
                    </>
                  )}
                </span>
                <div className="row">{renderControls}</div>
              </div>
              {!detached && (
                <div className="versions">
                  <div className="versions-tabs">
                    <strong>History</strong>
                    <button onClick={() => setWorkspace("Workflows")}>
                      Workflow
                    </button>
                    <button onClick={() => setPanel("properties")}>
                      Properties
                    </button>
                    <span>{doc.history.length} steps</span>
                  </div>
                  <div className="history-cards">
                    {doc.history.slice(-5).map((h, i) => (
                      <div
                        className={`history-card ${i === doc.history.slice(-5).length - 1 ? "current" : ""}`}
                        key={`${h}-${i}`}
                      >
                        <div className="mini-scene">
                          <Box size={23} />
                          <span>
                            {i === doc.history.slice(-5).length - 1
                              ? "CURRENT"
                              : "STEP"}
                          </span>
                        </div>
                        <span>{h}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : workspace === "Edit" ||
            workspace === "Develop" ? null : workspace === "Library" ? (
            <div className="library">
              <div className="page-heading">
                <div>
                  <small>PROJECT LIBRARY</small>
                  <h1>Your references, together.</h1>
                  <p>Original photographs travel with the project.</p>
                </div>
                <button
                  className="subtle"
                  onClick={() => void protect(() => detach("library"))}
                >
                  <ExternalLink size={16} />
                  Detach
                </button>
              </div>
              {assetGrid}
            </div>
          ) : workspace === "Workflows" ? (
            <div className="workflow-page">
              <div className="page-heading">
                <div>
                  <small>WORKFLOWS</small>
                  <h1>Make the process your own.</h1>
                  <p>
                    A first executable recipe using the same scene operations as
                    the editor.
                  </p>
                </div>
                <button
                  className="subtle"
                  onClick={() => void protect(() => detach("workflows"))}
                >
                  <ExternalLink size={16} />
                  Detach
                </button>
              </div>
              <div className="graph">
                <svg
                  className="graph-lines"
                  viewBox="0 0 900 400"
                  preserveAspectRatio="none"
                >
                  <path d="M220 200 C270 200 270 200 320 200 M570 200 C620 200 620 200 680 200" />
                </svg>
                <div className="node source-node">
                  <header>
                    <Box size={15} />
                    Scene input
                  </header>
                  <div>
                    <strong>{doc.project.name}</strong>
                    <small>Selected object: Pool</small>
                    <span className="node-port">
                      Revision {doc.revision}
                      <Circle size={10} />
                    </span>
                  </div>
                </div>
                <div className="node process-node">
                  <header>
                    <SlidersHorizontal size={15} />
                    Adjust pool
                  </header>
                  <div>
                    <Parameter
                      label="Width"
                      value={recipeWidth}
                      min={2}
                      max={12}
                      onCommit={setRecipeWidth}
                    />
                    <Parameter
                      label="Coping"
                      value={recipeCoping}
                      min={0.1}
                      max={1.5}
                      step={0.05}
                      onCommit={setRecipeCoping}
                    />
                  </div>
                </div>
                <div className="node output-node">
                  <header>
                    <Eye size={15} />
                    Review proposal
                  </header>
                  <div>
                    <strong>Editable preview</strong>
                    <small>Apply creates one undo step</small>
                    <button
                      className="primary small"
                      onClick={() => {
                        setProposal({
                          summary: `Workflow proposes a ${recipeWidth.toFixed(1)} m wide pool with ${recipeCoping.toFixed(2)} m coping.`,
                          scene: {
                            ...doc.project.scene,
                            pool_width: recipeWidth,
                            coping: recipeCoping,
                          },
                          revision: doc.revision,
                        });
                        setPreviewProposal(true);
                        setRecipeStatus("Preview ready in Scene");
                        setWorkspace("Scene");
                        setPanel("partner");
                      }}
                    >
                      Run recipe
                    </button>
                  </div>
                </div>
              </div>
              <div className="workflow-note">
                <GitBranch size={18} />
                <div>
                  <strong>{recipeStatus}</strong>
                  <p>
                    Preview → inspect → apply. General node authoring, Python
                    scripts, and batch image processing are planned.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="integration-page">
              <div className="integration-illustration">
                {workspace === "Paint" ? (
                  <Paintbrush size={56} />
                ) : workspace === "CAD" ? (
                  <Boxes size={56} />
                ) : (
                  <Layers size={56} />
                )}
              </div>
              <span className="eyebrow">
                {workspace.toUpperCase()} WORKSPACE
              </span>
              <h1>{hints[workspace]?.title}</h1>
              <p>{hints[workspace]?.description}</p>
              <div className="integration-status">
                <span className="status-dot" />
                {integrations.find((i) => i.name === hints[workspace]?.engine)
                  ?.available
                  ? "Application detected · editing adapter not connected"
                  : "Editing adapter planned"}
              </div>
              <div className="row">
                <button
                  className="subtle"
                  onClick={() => setShowSettings(true)}
                >
                  View connections
                </button>
                <button
                  className="primary"
                  onClick={() => setWorkspace("Scene")}
                >
                  Return to Scene
                </button>
              </div>
            </div>
          )}
        </section>
        {workspace !== "Edit" &&
          workspace !== "Develop" &&
          (!detached || panel === "properties") && (
            <aside className="partner-panel">
              <div className="partner-heading">
                <Sparkles size={21} />
                <strong>Design partner</strong>
                <span>Astra</span>
              </div>
              <div className="panel-tabs">
                <button
                  className={panel === "partner" ? "active" : ""}
                  onClick={() => setPanel("partner")}
                >
                  Collaborate
                </button>
                <button
                  className={panel === "properties" ? "active" : ""}
                  onClick={() => setPanel("properties")}
                >
                  Properties
                </button>
              </div>
              {panel === "properties" ? (
                <div className="properties-panel">
                  <div className="context-chip">
                    <Box size={14} />
                    Editing: Pool
                  </div>
                  <p className="muted">
                    Dimensions update every open scene window. The house stays
                    fixed.
                  </p>
                  {params}
                  <div className="hint-card">
                    <Monitor size={17} />
                    <p>
                      Keep this window on one display and detach the wireframe
                      or render onto another.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="context-row">
                    <span className="context-chip">
                      <Box size={13} />
                      Working on: <b>Pool</b>
                    </span>
                    <span className="context-chip">
                      Revision {doc.revision}
                    </span>
                  </div>
                  <div className="partner-scroll">
                    <div className="welcome">
                      <div className="avatar">
                        <Sparkles size={17} />
                      </div>
                      <div>
                        <strong>A shared canvas.</strong>
                        <p>
                          Describe a change to the pool. I can propose
                          dimensions, coping, water color, and sunlight for you
                          to inspect.
                        </p>
                        <small>
                          Uses your local Codex sign-in. Image generation is not
                          connected yet.
                        </small>
                      </div>
                    </div>
                    {!proposal && !asking && (
                      <div className="suggestions">
                        {[
                          "Make the pool wider, with narrow stone coping.",
                          "Try darker turquoise water and afternoon light.",
                        ].map((t) => (
                          <button key={t} onClick={() => setPrompt(t)}>
                            {t}
                            <ArrowUp size={13} />
                          </button>
                        ))}
                      </div>
                    )}
                    {asking && (
                      <div className="thinking">
                        <LoaderCircle className="spin" size={17} />
                        Preparing a design proposal…
                      </div>
                    )}
                    {proposal && (
                      <div className="proposal-card">
                        <div className="proposal-title">
                          <Sparkles size={16} />
                          <strong>Scene proposal</strong>
                          <span>PREVIEW</span>
                        </div>
                        <p>{proposal.summary}</p>
                        <div className="proposal-values">
                          <span>
                            Width<b>{proposal.scene.pool_width.toFixed(1)} m</b>
                          </span>
                          <span>
                            Length
                            <b>{proposal.scene.pool_length.toFixed(1)} m</b>
                          </span>
                          <span>
                            Coping<b>{proposal.scene.coping.toFixed(2)} m</b>
                          </span>
                        </div>
                        <div className="constraints">
                          <span>
                            <Check size={14} />
                            House geometry unchanged
                          </span>
                          <span>
                            <Check size={14} />
                            Camera stays in your control
                          </span>
                          <span>
                            <Check size={14} />
                            One reversible change
                          </span>
                        </div>
                        {proposalStale ? (
                          <p className="amber">
                            The scene changed after this proposal. Request a
                            fresh proposal before applying.
                          </p>
                        ) : (
                          <label className="toggle-row">
                            <input
                              type="checkbox"
                              checked={previewProposal}
                              onChange={(e) =>
                                setPreviewProposal(e.target.checked)
                              }
                            />
                            Show proposal in viewport
                          </label>
                        )}
                        <div className="proposal-actions">
                          <button
                            className="primary"
                            disabled={proposalStale}
                            onClick={() => void protect(applyProposal)}
                          >
                            Apply to scene
                          </button>
                          <button
                            className="subtle"
                            onClick={() => setProposal(null)}
                          >
                            Discard
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="partner-limit">
                      <span className="live-dot" />
                      Edits stay in your project.
                      <p>
                        Manual controls, workflow recipes and approved proposals
                        share one history.
                      </p>
                    </div>
                  </div>
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void protect(ask);
                    }}
                  >
                    <textarea
                      aria-label="Describe a design change"
                      placeholder="Describe a change to the pool…"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void protect(ask);
                        }
                      }}
                    />
                    <div>
                      <small>Codex App Server · ⌘↵</small>
                      <button
                        className="send"
                        aria-label="Send design request"
                        disabled={asking || !prompt.trim() || !native}
                      >
                        {asking ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <ArrowUp size={18} />
                        )}
                      </button>
                    </div>
                  </form>
                </>
              )}
            </aside>
          )}
      </div>
      <footer className="statusbar">
        <span>
          <span className="live-dot" />
          {native
            ? "Desktop workspace"
            : "Browser preview · open desktop to edit"}
        </span>
        <span>
          Revision {doc.revision} <span className="divider" />{" "}
          {doc.project.assets.length} references
          {recoveryStatus && <> · {recoveryStatus}</>}
          {doc.history[0] === "Recovered unsaved project" && (
            <> · Recovered unsaved work</>
          )}
        </span>
        <span>
          {busy
            ? "Blender working in background"
            : render.status === "complete"
              ? `Last render · r${render.revision}`
              : "Local project · no render yet"}
        </span>
      </footer>
      {(error || notice) && (
        <div
          className={`toast ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          <span>{error || notice}</span>
          <IconButton
            title="Dismiss message"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            <X size={16} />
          </IconButton>
        </div>
      )}
      {activeAsset && (
        <div className="modal-scrim" onClick={() => setActiveAsset(null)}>
          <div className="image-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <strong>{activeAsset.name}</strong>
              <IconButton
                title="Close image"
                onClick={() => setActiveAsset(null)}
              >
                <X size={19} />
              </IconButton>
            </header>
            <img src={activeAsset.data_url} alt={activeAsset.name} />
          </div>
        </div>
      )}
      {showSettings && (
        <div className="modal-scrim" onClick={() => setShowSettings(false)}>
          <section
            className="connections-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Engine connections"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <small>CONNECTED FOUNDATIONS</small>
                <h2>Engine connections</h2>
              </div>
              <IconButton
                title="Close connections"
                onClick={() => setShowSettings(false)}
              >
                <X size={20} />
              </IconButton>
            </header>
            <p>
              Application discovery and adapter readiness are separate. Nothing
              is installed automatically.
            </p>
            {integrations.map((i) => (
              <div className="connection" key={i.name}>
                <Box size={20} />
                <div>
                  <strong>{i.name}</strong>
                  <small>{i.capability}</small>
                </div>
                <span className={i.available ? "detected" : ""}>
                  {i.available ? "Detected" : "Not found"}
                </span>
              </div>
            ))}
            <p className="muted">
              Blender rendering and Codex proposals are wired in this build.
              Other engines are integration targets.
            </p>
            <button
              className="subtle"
              onClick={() =>
                void protect(async () =>
                  setIntegrations(await getIntegrations()),
                )
              }
            >
              Refresh discovery
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
