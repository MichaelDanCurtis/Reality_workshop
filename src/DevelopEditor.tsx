import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Download,
  ExternalLink,
  Image,
  LoaderCircle,
  Plus,
  Sparkles,
  Star,
} from "lucide-react";
import { commit, current, detach, useProject } from "./store";
import type { Snapshot } from "./model";
import "./native-editor.css";
import "./develop-editor.css";

export interface DevelopSettings {
  exposure: number;
  contrast: number;
  saturation: number;
  black: number;
}
export interface DevelopedPhoto {
  id: string;
  version: string;
  name: string;
  source: string;
  sidecar: string;
  settings: DevelopSettings;
  preview: string;
  original_preview: string;
  rating: number;
  tags: string[];
}
const neutral: DevelopSettings = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  black: 0,
};
type Preview = {
  photos: DevelopedPhoto[];
  settings: DevelopSettings;
  base: number;
  summary: string;
  ids: string[];
};
type AiProposal = {
  summary: string;
  supported: boolean;
  settings: DevelopSettings;
  base: number;
};

export function DevelopEditor({
  active,
  library = false,
  selectedId,
  onOpen,
  references,
  onMarkup,
}: {
  active: boolean;
  library?: boolean;
  selectedId?: string | null;
  onOpen?: (id: string) => void;
  references?: ReactNode;
  onMarkup?: () => void;
}) {
  const project = useProject();
  const photos = project.project.developed_photos ?? [];
  const [id, setId] = useState<string | null>(selectedId ?? null),
    [selected, setSelected] = useState<string[]>([]);
  const photo = photos.find((p) => p.id === id) ?? photos[0];
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [rating, setRating] = useState(0),
    [before, setBefore] = useState(false),
    [panel, setPanel] = useState("adjustments");
  const [settings, setSettings] = useState<DevelopSettings>(
      photo?.settings ?? neutral,
    ),
    [preview, setPreview] = useState<Preview | null>(null),
    [prompt, setPrompt] = useState("");
  const visible = photos.filter(
    (p) =>
      p.rating >= rating &&
      (p.name + " " + p.tags.join(" "))
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const targets = selected.length ? selected : photo ? [photo.id] : [];
  const shown = preview?.photos.find((p) => p.id === photo?.id) ?? photo;
  useEffect(() => {
    if (selectedId) setId(selectedId);
  }, [selectedId]);
  useEffect(() => {
    setSettings(preview?.settings ?? photo?.settings ?? neutral);
    setBefore(false);
  }, [photo?.id, photo?.version]);
  async function protect(label: string, work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }
  async function importPhotos(assetIds: string[] = []) {
    const paths = assetIds.length
      ? []
      : await open({
          multiple: true,
          filters: [
            {
              name: "Photographs and RAW",
              extensions: [
                "png",
                "jpg",
                "jpeg",
                "tif",
                "tiff",
                "webp",
                "dng",
                "cr2",
                "cr3",
                "nef",
                "nrw",
                "arw",
                "raf",
                "rw2",
                "orf",
                "pef",
                "srw",
                "raw",
              ],
            },
          ],
        });
    if (!paths && !assetIds.length) return;
    const old = new Set(photos.map((p) => p.id));
    const s = await invoke<Snapshot>("develop_import", {
      paths: paths ?? [],
      assetIds,
      base: current().revision,
    });
    const added = s.project.developed_photos?.find((p) => !old.has(p.id));
    if (added) {
      setId(added.id);
      setSelected([]);
      setPreview(null);
    }
  }
  async function prepare(
    next: DevelopSettings,
    summary: string,
    base = current().revision,
    ids = targets,
  ) {
    const results = await invoke<DevelopedPhoto[]>("develop_edit", {
      ids,
      settings: next,
      base,
      preview: true,
    });
    setPreview({ photos: results, settings: next, base, summary, ids });
    setBefore(false);
  }
  async function metadata(
    p: DevelopedPhoto,
    patch: Partial<Pick<DevelopedPhoto, "rating" | "tags">>,
  ) {
    const s = current();
    await commit(
      {
        ...s.project,
        developed_photos: (s.project.developed_photos ?? []).map((v) =>
          v.id === p.id ? { ...v, ...patch } : v,
        ),
      },
      "Organize photographs",
      s.revision,
    );
  }
  const selectPhoto = (p: DevelopedPhoto) => {
    setId(p.id);
    if (library) onOpen?.(p.id);
  };
  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );
  const thumbnail = (p: DevelopedPhoto) => {
    const candidate = preview?.photos.find((v) => v.id === p.id) ?? p;
    return (
      <div
        key={p.id}
        className={
          "develop-tile " +
          (p.id === photo?.id ? "active " : "") +
          (selected.includes(p.id) ? "checked" : "")
        }
      >
        <input
          aria-label={"Select " + p.name}
          type="checkbox"
          checked={selected.includes(p.id)}
          disabled={!!busy || !!preview}
          onChange={() => toggle(p.id)}
        />
        <button disabled={!!busy} onClick={() => selectPhoto(p)}>
          <img src={candidate.preview} alt={p.name} />
          <strong>{p.name}</strong>
          <small>
            {p.tags.join(" · ") || p.source.split(".").at(-1)?.toUpperCase()}
          </small>
        </button>
        <div className="develop-stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              disabled={!!busy}
              aria-label={"Rate " + p.name + " " + n + " stars"}
              onClick={() =>
                void protect("Saving rating…", () =>
                  metadata(p, { rating: p.rating === n ? 0 : n }),
                )
              }
            >
              <Star size={12} fill={p.rating >= n ? "currentColor" : "none"} />
            </button>
          ))}
        </div>
      </div>
    );
  };
  return (
    <div
      className={
        "native-editor develop-editor " + (library ? "develop-library" : "")
      }
      hidden={!active}
    >
      <div className="native-document-tabs">
        <strong className="native-workspace-name">
          <Image size={17} />
          {library ? "Photo library" : "Develop studio"}
        </strong>
        <span className="develop-muted">{photos.length} photographs</span>
        <span className="spatial-spacer" />
        {onMarkup && <button onClick={onMarkup}>Photo markup</button>}
        <button
          title="Detach this workspace"
          onClick={() =>
            void protect("Opening window…", () =>
              detach(library ? "library" : "develop"),
            )
          }
        >
          <ExternalLink size={16} />
        </button>
      </div>
      <div className="native-commandbar">
        <button
          disabled={!!busy}
          onClick={() =>
            void protect("Developing imported photographs…", () =>
              importPhotos(),
            )
          }
        >
          <Plus size={15} />
          Import photos or RAW
        </button>
        {project.project.assets.length > 0 && (
          <select
            aria-label="Develop project reference"
            disabled={!!busy}
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id)
                void protect("Developing project reference…", () =>
                  importPhotos([id]),
                );
            }}
          >
            <option value="">Add a project reference…</option>
            {project.project.assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <button
          disabled={!targets.length || !!busy}
          onClick={() =>
            void protect("Exporting full-resolution photographs…", async () => {
              const folder = await open({ directory: true, multiple: false });
              if (folder) {
                const out = await invoke<string>("develop_export", {
                  ids: targets,
                  folder,
                  base: current().revision,
                });
                setNotice("Exported photographs and edit recipes to " + out);
              }
            })
          }
        >
          <Download size={15} />
          Export {targets.length > 1 ? targets.length : "PNG"}
        </button>
        <button
          disabled={!photo || !!busy || !!preview}
          onClick={() =>
            void protect("Opening developed image in Edit…", async () => {
              await invoke("develop_to_edit", {
                id: photo.id,
                base: current().revision,
              });
              setNotice("The developed image is ready in the Edit workspace.");
            })
          }
        >
          Copy to Edit
        </button>
        <span className="spatial-spacer" />
        <span className="engine-badge">
          darktable <small>Native development</small>
        </span>
      </div>
      <div className="native-optionsbar">
        <input
          aria-label="Find photographs"
          placeholder="Find a name or tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Minimum photo rating"
          value={rating}
          onChange={(e) => setRating(Number(e.target.value))}
        >
          <option value={0}>All ratings</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}+ stars
            </option>
          ))}
        </select>
        <button
          disabled={!!busy || !!preview}
          onClick={() => setSelected(visible.map((p) => p.id))}
        >
          Select visible
        </button>
        {selected.length > 0 && (
          <button
            disabled={!!busy || !!preview}
            onClick={() => setSelected([])}
          >
            Clear selection
          </button>
        )}
        <span className="spatial-spacer" />
        <small>
          {selected.length
            ? selected.length + " selected"
            : visible.length + " photographs"}
        </small>
      </div>
      {library ? (
        <div className="develop-library-content">
          <div className="develop-gallery">{visible.map(thumbnail)}</div>
          {photos.length === 0 && (
            <div className="develop-library-empty">
              <Image size={30} />
              <h2>Your photographs, together.</h2>
              <p>
                Import originals or RAW files, rate and tag a collection, then
                open a photograph in Develop.
              </p>
            </div>
          )}
          {references && (
            <>
              <div className="section-label">PROJECT REFERENCES</div>
              {references}
            </>
          )}
        </div>
      ) : photo && shown ? (
        <>
          <div className="develop-workbench">
            <div className="develop-photo">
              <div className="develop-photo-title">
                <strong>{photo.name}</strong>
                <button
                  className={before ? "active" : ""}
                  onClick={() => setBefore((v) => !v)}
                >
                  {before ? "Show edited" : "Compare original"}
                </button>
              </div>
              <img
                src={before ? photo.original_preview : shown.preview}
                alt={
                  photo.name +
                  " — " +
                  (before ? "original development" : "darktable preview")
                }
              />
              <small>
                {before
                  ? "Original development"
                  : preview?.photos.some((p) => p.id === photo.id)
                    ? "Native preview · not applied"
                    : "Native darktable development"}
              </small>
            </div>
            <aside className="develop-inspector">
              <div className="panel-tabs">
                <button
                  className={panel === "adjustments" ? "active" : ""}
                  onClick={() => setPanel("adjustments")}
                >
                  Adjustments
                </button>
                <button
                  className={panel === "ai" ? "active" : ""}
                  onClick={() => setPanel("ai")}
                >
                  <Sparkles size={14} />
                  Astra
                </button>
              </div>
              {panel === "adjustments" ? (
                <div className="develop-controls">
                  <div className="section-label">LIGHT & COLOR</div>
                  {(
                    [
                      {
                        key: "exposure",
                        label: "Exposure",
                        min: -5,
                        max: 5,
                        step: 0.1,
                        unit: "EV",
                        scale: 1,
                      },
                      {
                        key: "contrast",
                        label: "Contrast",
                        min: -1,
                        max: 1,
                        step: 0.01,
                        unit: "%",
                        scale: 100,
                      },
                      {
                        key: "saturation",
                        label: "Saturation",
                        min: -1,
                        max: 1,
                        step: 0.01,
                        unit: "%",
                        scale: 100,
                      },
                      {
                        key: "black",
                        label: "Black level",
                        min: -0.1,
                        max: 0.1,
                        step: 0.001,
                        unit: "",
                        scale: 1,
                      },
                    ] as const
                  ).map((c) => (
                    <label key={c.key}>
                      <span>
                        {c.label}
                        <b>
                          {(settings[c.key] * c.scale).toFixed(
                            c.key === "black"
                              ? 3
                              : c.key === "exposure"
                                ? 1
                                : 0,
                          )}{" "}
                          {c.unit}
                        </b>
                      </span>
                      <input
                        aria-label={c.label}
                        type="range"
                        min={c.min}
                        max={c.max}
                        step={c.step}
                        disabled={!!busy}
                        value={settings[c.key]}
                        onChange={(e) => {
                          setSettings({
                            ...settings,
                            [c.key]: Number(e.target.value),
                          });
                          setPreview(null);
                        }}
                      />
                    </label>
                  ))}
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      void protect(
                        "Preparing " + targets.length + " native previews…",
                        () =>
                          prepare(
                            settings,
                            "Apply this color recipe to " +
                              targets.length +
                              " photographs.",
                          ),
                      )
                    }
                  >
                    Preview{" "}
                    {targets.length > 1
                      ? targets.length + " photographs"
                      : "adjustments"}
                  </button>
                  <button
                    disabled={!!busy}
                    onClick={() => {
                      setSettings(neutral);
                      setPreview(null);
                    }}
                  >
                    Reset controls
                  </button>
                  <div className="section-label">ORGANIZE</div>
                  <label>
                    Tags
                    <input
                      aria-label="Photo tags"
                      key={photo.id + ":" + photo.tags.join()}
                      defaultValue={photo.tags.join(", ")}
                      placeholder="Architecture, concepts…"
                      disabled={!!busy}
                      onBlur={(e) => {
                        const tags = [
                          ...new Set(
                            e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          ),
                        ];
                        if (tags.join() !== photo.tags.join())
                          void protect("Saving tags…", () =>
                            metadata(photo, { tags }),
                          );
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                  </label>
                  <p>
                    Originals are copied into the project. The native edit
                    recipe stays separate and travels with your export.
                  </p>
                </div>
              ) : (
                <div className="develop-controls">
                  <Sparkles size={24} />
                  <h3>Your photo design partner</h3>
                  <p>
                    Describe the light and color you want. Review darktable's
                    result before applying it to the photograph or selected
                    group.
                  </p>
                  <textarea
                    aria-label="Photo design instruction"
                    placeholder="Lift the exposure while keeping the colors restrained…"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={!!busy || !prompt.trim()}
                    onClick={() =>
                      void protect(
                        "Astra is preparing native photo previews…",
                        async () => {
                          const result = await invoke<AiProposal>(
                            "develop_propose",
                            { id: photo.id, base: current().revision, prompt },
                          );
                          if (result.supported) {
                            setSettings(result.settings);
                            await prepare(
                              result.settings,
                              result.summary,
                              result.base,
                            );
                          } else setNotice(result.summary);
                        },
                      )
                    }
                  >
                    Preview with Astra
                  </button>
                </div>
              )}
              {preview && (
                <div className="develop-review">
                  <strong>Review {preview.photos.length} photographs</strong>
                  <p>{preview.summary}</p>
                  <button
                    className="primary"
                    disabled={!!busy || preview.base !== project.revision}
                    onClick={() =>
                      void protect(
                        "Applying native photo adjustments…",
                        async () => {
                          await invoke("develop_apply_preview", {
                            version: preview.photos[0].version,
                            base: preview.base,
                          });
                          setPreview(null);
                        },
                      )
                    }
                  >
                    Apply
                  </button>
                  <button disabled={!!busy} onClick={() => setPreview(null)}>
                    Discard
                  </button>
                  {preview.base !== project.revision && (
                    <p>The project changed. Prepare a fresh preview.</p>
                  )}
                </div>
              )}
            </aside>
          </div>
          <div className="develop-filmstrip">{visible.map(thumbnail)}</div>
        </>
      ) : (
        <div className="spatial-empty">
          <Image size={42} />
          <h2>A home for your digital negatives</h2>
          <p>
            Import a photograph or RAW file to develop it using darktable, with
            the same project, review, and undo controls as the rest of the
            suite.
          </p>
          <button
            className="primary"
            disabled={!!busy}
            onClick={() =>
              void protect("Developing imported photographs…", () =>
                importPhotos(),
              )
            }
          >
            Import photographs
          </button>
        </div>
      )}
      <div className="spatial-status">
        {busy ? (
          <>
            <LoaderCircle size={13} className="spin" />
            {busy}
          </>
        ) : error ? (
          <span role="alert">{error}</span>
        ) : notice ? (
          <span>{notice}</span>
        ) : (
          <>
            <span className="live-dot" />
            Native darktable edits · original files preserved
          </>
        )}
        <span className="spatial-spacer" />
        Revision {project.revision}
      </div>
    </div>
  );
}
