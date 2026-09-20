import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Box,
  Code2,
  ExternalLink,
  Image,
  LoaderCircle,
  Play,
  Save,
  Sparkles,
  Workflow,
} from "lucide-react";
import { commit, current, detach, useProject } from "./store";
import type { NativeDocument } from "./engine-model";
import { ModelCanvas, type SpatialDocument } from "./SpatialEditor";
import type { DevelopedPhoto, DevelopSettings } from "./DevelopEditor";
import "./workflow-editor.css";

export interface WorkflowRecipe {
  id: string;
  name: string;
  source: string;
  selected: string;
  mode: "ai" | "script";
  instruction: string;
  script: string;
  positions: number[][];
}
type Review = {
  kind: "raster" | "spatial" | "photo";
  id: string;
  name: string;
  base: number;
  summary: string;
  operations: unknown[];
  document?: NativeDocument;
  model?: SpatialDocument;
  photos?: DevelopedPhoto[];
};
export function WorkflowEditor({ onStudy }: { onStudy: () => void }) {
  const state = useProject();
  const raster = state.project.native_documents ?? [],
    spatial = state.project.spatial_documents ?? [],
    photos = state.project.developed_photos ?? [];
  const sources = [
    ...raster.map((d) => ({
      id: d.id,
      name: d.name,
      engine: d.engine,
      kind: "raster",
    })),
    ...spatial.map((d) => ({
      id: d.id,
      name: d.name,
      engine: d.engine,
      kind: "spatial",
    })),
    ...photos.map((d) => ({
      id: d.id,
      name: d.name,
      engine: "darktable",
      kind: "photo",
    })),
    ...(photos.length > 1
      ? [
          {
            id: "all-photos",
            name: "All developed photographs",
            engine: "darktable",
            kind: "photo",
          },
        ]
      : []),
  ];
  const [sourceId, setSourceId] = useState(""),
    [picked, setPicked] = useState(""),
    [mode, setMode] = useState<"ai" | "script">("ai"),
    [instruction, setInstruction] = useState(""),
    [script, setScript] = useState("");
  const [name, setName] = useState("Untitled workflow"),
    [recipeId, setRecipeId] = useState(""),
    [positions, setPositions] = useState([
      [20, 28],
      [345, 28],
      [725, 28],
    ]);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [review, setReview] = useState<Review | null>(null);
  const drag = useRef<{
    node: number;
    x: number;
    y: number;
    start: number[];
  } | null>(null);
  const source = sourceId ? sources.find((s) => s.id === sourceId) : sources[0];
  const image = raster.find((d) => d.id === source?.id),
    model = spatial.find((d) => d.id === source?.id),
    photo =
      source?.id === "all-photos"
        ? photos[0]
        : photos.find((p) => p.id === source?.id);
  const targets =
    image?.layers.map((l) => ({ id: l.id, name: l.name })) ??
    model?.objects.map((o) => ({ id: o.id, name: o.name })) ??
    [];
  const selected = picked
    ? (targets.find((t) => t.id === picked)?.id ?? "")
    : (targets[0]?.id ?? "");
  async function protect(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }
  function sample() {
    if (image)
      return JSON.stringify(
        [{ kind: "opacity", layer: selected, value: 75 }],
        null,
        2,
      );
    if (model) {
      const object = model.objects.find((o) => o.id === selected);
      return JSON.stringify(
        [
          {
            kind: "transform",
            object: selected,
            position: object?.position ?? [0, 0, 0],
            rotation: object?.rotation ?? [0, 0, 0],
          },
        ],
        null,
        2,
      );
    }
    return JSON.stringify(
      photo?.settings ?? { exposure: 0, contrast: 0, saturation: 0, black: 0 },
      null,
      2,
    );
  }
  async function run() {
    if (!source)
      throw Error("Create or import a document in a workspace first.");
    if (mode === "ai" && source.kind !== "photo" && !selected)
      throw Error("Choose an existing layer or object for this recipe.");
    const base = current().revision;
    setReview(null);
    let summary = "Operation script preview",
      operations: unknown[] = [],
      settings: DevelopSettings | undefined;
    if (mode === "ai") {
      if (!instruction.trim()) throw Error("Describe the requested change.");
      const command =
        source.kind === "raster"
          ? "engine_propose"
          : source.kind === "spatial"
            ? "spatial_propose"
            : "develop_propose";
      const proposal = await invoke<{
        summary: string;
        supported: boolean;
        operations?: unknown[];
        settings?: DevelopSettings;
      }>(command, {
        id: photo?.id ?? source.id,
        base,
        prompt: instruction,
        layer: selected,
        selected: selected || null,
      });
      summary = proposal.summary;
      if (!proposal.supported) {
        setNotice(summary);
        return;
      }
      operations = proposal.operations ?? [];
      settings = proposal.settings;
    } else {
      const value = JSON.parse(script || sample());
      if (source.kind === "photo") settings = value;
      else {
        if (!Array.isArray(value))
          throw Error("Use a JSON array of native operations.");
        operations = value;
      }
    }
    if (source.kind === "raster") {
      const document = await invoke<NativeDocument>("engine_edit", {
        id: source.id,
        base,
        operations,
        label: "Workflow preview",
        preview: true,
      });
      setReview({
        kind: "raster",
        id: source.id,
        name: source.name,
        base,
        summary,
        operations,
        document,
      });
    } else if (source.kind === "spatial") {
      const model = await invoke<SpatialDocument>("spatial_edit", {
        id: source.id,
        base,
        operations,
        preview: true,
      });
      setReview({
        kind: "spatial",
        id: source.id,
        name: source.name,
        base,
        summary,
        operations,
        model,
      });
    } else {
      const ids =
        source.id === "all-photos" ? photos.map((p) => p.id) : [source.id];
      const output = await invoke<DevelopedPhoto[]>("develop_edit", {
        ids,
        settings,
        base,
        preview: true,
      });
      setReview({
        kind: "photo",
        id: source.id,
        name: source.name,
        base,
        summary,
        operations: [],
        photos: output,
      });
    }
  }
  async function apply() {
    if (!review) return;
    if (review.kind === "raster")
      await invoke("engine_edit", {
        id: review.id,
        operations: review.operations,
        base: review.base,
        label: "Apply workflow",
        preview: false,
      });
    else if (review.kind === "spatial")
      await invoke("spatial_edit", {
        id: review.id,
        operations: review.operations,
        base: review.base,
        preview: false,
      });
    else
      await invoke("develop_apply_preview", {
        version: review.photos![0].version,
        base: review.base,
      });
    setReview(null);
    setNotice(
      "Workflow applied. Undo restores the previous document revision.",
    );
  }
  async function saveRecipe() {
    const s = current();
    const recipe: WorkflowRecipe = {
      id: recipeId || crypto.randomUUID(),
      name,
      source: source?.id ?? "",
      selected,
      mode,
      instruction,
      script: script || sample(),
      positions,
    };
    const existing = s.project.workflows ?? [];
    await commit(
      {
        ...s.project,
        workflows: [...existing.filter((w) => w.id !== recipe.id), recipe],
      },
      "Save workflow",
      s.revision,
    );
    setRecipeId(recipe.id);
    setNotice("Workflow saved in this project.");
  }
  function load(id: string) {
    const recipe = state.project.workflows?.find((w) => w.id === id);
    if (!recipe) return;
    setRecipeId(id);
    setName(recipe.name);
    setSourceId(recipe.source);
    setPicked(recipe.selected);
    setMode(recipe.mode);
    setInstruction(recipe.instruction);
    setScript(recipe.script);
    setPositions(recipe.positions);
    setReview(null);
  }
  function begin(index: number, e: PointerEvent<HTMLElement>) {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = {
      node: index,
      x: e.clientX,
      y: e.clientY,
      start: positions[index],
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const point = [
      Math.max(0, Math.min(800, d.start[0] + e.clientX - d.x)),
      Math.max(0, Math.min(180, d.start[1] + e.clientY - d.y)),
    ];
    setPositions((p) => p.map((v, i) => (i === d.node ? point : v)));
  }
  const nodeHeader = (i: number, title: string, icon: ReactNode) => (
    <header
      onPointerDown={(e) => begin(i, e)}
      onPointerMove={move}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      {icon}
      {title}
      <span>↔</span>
    </header>
  );
  return (
    <div className="native-editor workflow-editor">
      <div className="native-document-tabs">
        <strong className="native-workspace-name">
          <Workflow size={17} />
          Workflow studio
        </strong>
        <span className="develop-muted">Input → operation → review</span>
        <span className="spatial-spacer" />
        <button onClick={onStudy}>Coastal study recipe</button>
        <button
          title="Detach this workspace"
          onClick={() =>
            void protect("Opening window…", async () => {
              await detach("workflows");
            })
          }
        >
          <ExternalLink size={16} />
        </button>
      </div>
      <div className="native-commandbar">
        <input
          aria-label="Workflow name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          disabled={!!busy || !!review || !name.trim() || !source}
          onClick={() => void protect("Saving workflow…", saveRecipe)}
        >
          <Save size={14} />
          Save recipe
        </button>
        <select
          aria-label="Saved workflow"
          value={recipeId}
          disabled={!!busy}
          onChange={(e) => load(e.target.value)}
        >
          <option value="">Saved recipes…</option>
          {state.project.workflows?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <span className="spatial-spacer" />
        <small>Native commands · shared undo</small>
      </div>
      <div className="workflow-scroll">
        <div
          className="workflow-stage"
          style={{
            height: Math.max(510, ...positions.map((p) => p[1] + 445)),
            width: Math.max(1060, ...positions.map((p) => p[0] + 310)),
          }}
        >
          <svg className="workflow-wires" aria-hidden="true">
            {[0, 1].map((i) => (
              <path
                key={i}
                d={
                  "M" +
                  (positions[i][0] + 290) +
                  "," +
                  (positions[i][1] + 135) +
                  " C" +
                  (positions[i][0] + 330) +
                  "," +
                  (positions[i][1] + 135) +
                  " " +
                  (positions[i + 1][0] - 40) +
                  "," +
                  (positions[i + 1][1] + 135) +
                  " " +
                  positions[i + 1][0] +
                  "," +
                  (positions[i + 1][1] + 135)
                }
              />
            ))}
          </svg>
          <section
            className="workflow-block"
            style={{ left: positions[0][0], top: positions[0][1] }}
          >
            {nodeHeader(0, "01  Project input", <Image size={15} />)}
            <div>
              <label>
                Document
                <select
                  aria-label="Workflow document"
                  value={source?.id ?? ""}
                  disabled={!!busy}
                  onChange={(e) => {
                    setSourceId(e.target.value);
                    setPicked("");
                    setScript("");
                    setReview(null);
                  }}
                >
                  <option value="" disabled>
                    Choose a document…
                  </option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.engine + " · " + s.name}
                    </option>
                  ))}
                </select>
              </label>
              {targets.length > 0 && (
                <label>
                  Layer or object
                  <select
                    aria-label="Workflow layer or object"
                    value={selected}
                    disabled={!!busy}
                    onChange={(e) => {
                      setPicked(e.target.value);
                      setScript("");
                      setReview(null);
                    }}
                  >
                    <option value="" disabled>
                      Choose a layer or object…
                    </option>
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p>
                The source stays intact until you apply the reviewed result.
              </p>
              <span className="workflow-port">
                {source?.engine ?? "No input"}
                <i />
              </span>
            </div>
          </section>
          <section
            className="workflow-block"
            style={{ left: positions[1][0], top: positions[1][1] }}
          >
            {nodeHeader(
              1,
              "02  Transform",
              mode === "ai" ? <Sparkles size={15} /> : <Code2 size={15} />,
            )}
            <div>
              <div className="workflow-mode">
                <button
                  className={mode === "ai" ? "active" : ""}
                  disabled={!!busy}
                  onClick={() => {
                    setMode("ai");
                    setReview(null);
                  }}
                >
                  Astra
                </button>
                <button
                  className={mode === "script" ? "active" : ""}
                  disabled={!!busy}
                  onClick={() => {
                    setMode("script");
                    setReview(null);
                  }}
                >
                  Operation script
                </button>
              </div>
              {mode === "ai" ? (
                <textarea
                  aria-label="Workflow AI instruction"
                  placeholder="Describe a supported edit…"
                  value={instruction}
                  maxLength={8000}
                  disabled={!!busy}
                  onChange={(e) => {
                    setInstruction(e.target.value);
                    setReview(null);
                  }}
                />
              ) : (
                <textarea
                  className="workflow-code"
                  aria-label="Workflow operation script"
                  spellCheck={false}
                  value={script || sample()}
                  maxLength={64000}
                  disabled={!!busy}
                  onChange={(e) => {
                    setScript(e.target.value);
                    setReview(null);
                  }}
                />
              )}
              <p>
                {mode === "ai"
                  ? "Astra proposes operations that the selected engine supports."
                  : "JSON operations use the same validated commands as the workspace tools. Arbitrary Python is not executed."}
              </p>
              <button
                className="primary"
                disabled={!!busy || !source}
                onClick={() =>
                  void protect("Running native workflow preview…", run)
                }
              >
                <Play size={14} />
                Run preview
              </button>
            </div>
          </section>
          <section
            className="workflow-block"
            style={{ left: positions[2][0], top: positions[2][1] }}
          >
            {nodeHeader(2, "03  Review & apply", <Box size={15} />)}
            <div>
              <strong>
                {review
                  ? "Native preview ready"
                  : busy
                    ? "Processing…"
                    : "Waiting for a preview"}
              </strong>
              <p>
                {review?.summary ??
                  "The engine produces a real document revision. Inspect it below before applying."}
              </p>
              {review && (
                <>
                  <button
                    className="primary"
                    disabled={!!busy || review.base !== state.revision}
                    onClick={() =>
                      void protect("Applying reviewed workflow…", apply)
                    }
                  >
                    Apply workflow
                  </button>
                  <button disabled={!!busy} onClick={() => setReview(null)}>
                    Discard
                  </button>
                  {review.base !== state.revision && (
                    <p>The project changed. Run a fresh preview.</p>
                  )}
                </>
              )}
              <span className="workflow-port">
                One reversible change
                <i />
              </span>
            </div>
          </section>
        </div>
        {review && (
          <div className="workflow-output">
            <div className="section-label">{review.name} · Preview only</div>
            {review.document && (
              <img
                src={review.document.preview}
                alt="Native workflow preview"
              />
            )}
            {review.model && (
              <div className="workflow-model">
                <ModelCanvas
                  document={review.model}
                  selected={review.model.selected}
                  onSelect={() => {}}
                  wireframe={false}
                  fit={0}
                />
              </div>
            )}
            {review.photos && (
              <div className="workflow-photo-output">
                {review.photos.map((p) => (
                  <figure key={p.id}>
                    <img src={p.preview} alt={p.name} />
                    <figcaption>{p.name}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="spatial-status">
        {busy ? (
          <>
            <LoaderCircle size={13} className="spin" />
            {busy}
          </>
        ) : error ? (
          <span role="alert">{error}</span>
        ) : (
          notice ||
          "Drag node headers to arrange the recipe. Saved recipes travel with the project."
        )}
        <span className="spatial-spacer" />
        Revision {state.revision}
      </div>
    </div>
  );
}
