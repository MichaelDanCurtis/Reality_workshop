import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  Box,
  Circle,
  Cylinder,
  Eye,
  EyeOff,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Maximize,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { current, detach, useProject } from "./store";
import { viewportDepthRange } from "./viewport-camera";
import type { Snapshot } from "./model";
import "./native-editor.css";
import "./spatial-editor.css";

export interface SpatialObject {
  id: string;
  name: string;
  kind: string;
  visible: boolean;
  position: number[];
  rotation: number[];
  dimensions: Record<string, number>;
  color: string;
  volume: number | null;
  valid: boolean;
  vertices: number[];
  triangles: number[];
}
export interface SpatialDocument {
  id: string;
  name: string;
  engine: "FreeCAD" | "Blender";
  version: string;
  file: string;
  unit: string;
  engine_version: string;
  objects: SpatialObject[];
  selected: string | null;
}
type Operation = Record<string, unknown>;
type Proposal = {
  summary: string;
  supported: boolean;
  operations: Operation[];
  base: number;
  document?: SpatialDocument;
};

export function ModelCanvas({
  document,
  selected,
  onSelect,
  wireframe,
  fit,
  focusId = null,
}: {
  document: SpatialDocument;
  selected: string | null;
  onSelect: (id: string) => void;
  wireframe: boolean;
  fit: number;
  focusId?: string | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    group: THREE.Group;
    renderer: THREE.WebGLRenderer;
    bounds: THREE.Sphere;
    draw: () => void;
    fitted: string | null;
    fit: number;
  } | null>(null);
  const onPick = useRef(onSelect);
  onPick.current = onSelect;
  useEffect(() => {
    const element = host.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#192226");
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
    camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    element.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const bounds = new THREE.Sphere(new THREE.Vector3(), -1);
    const visible = () => element.clientWidth > 0 && element.clientHeight > 0;
    const redraw = () => {
      if (!visible()) return;
      if (bounds.radius >= 0) {
        const { near, far } = viewportDepthRange(
          camera.position.distanceTo(controls.target),
          camera.position.distanceTo(bounds.center),
          bounds.radius,
        );
        if (camera.near !== near || camera.far !== far) {
          camera.near = near;
          camera.far = far;
          camera.updateProjectionMatrix();
        }
      }
      renderer.render(scene, camera);
    };
    // Coalesce pointer events and render only while the camera is changing.
    // OrbitControls emits change from update(); never draw twice for that event.
    let frame = 0;
    let updating = false;
    const requestDraw = () => {
      if (frame || updating || !visible()) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!visible()) return;
        updating = true;
        const moving = controls.update();
        updating = false;
        redraw();
        if (moving) requestDraw();
      });
    };
    controls.addEventListener("change", requestDraw);
    scene.add(new THREE.HemisphereLight(0xe8f7ff, 0x385258, 2.2));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(3, -5, 8);
    scene.add(light);
    const group = new THREE.Group();
    scene.add(group);
    runtime.current = {
      scene,
      camera,
      controls,
      group,
      renderer,
      bounds,
      draw: redraw,
      fitted: null,
      fit: -1,
    };
    const resize = new ResizeObserver(() => {
      const w = element.clientWidth,
        h = element.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      redraw();
    });
    resize.observe(element);
    let start = [0, 0];
    const down = (e: PointerEvent) => {
      start = [e.clientX, e.clientY];
    };
    const pick = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 5) return;
      const r = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          (-(e.clientY - r.top) / r.height) * 2 + 1,
        ),
        camera,
      );
      const hit = ray
        .intersectObjects(group.children)
        .find((h) => h.object.userData.id);
      if (hit) onPick.current(hit.object.userData.id as string);
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointerup", pick);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.removeEventListener("change", requestDraw);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtime.current = null;
    };
  }, []);
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    const dispose = () => {
      for (const child of [...r.group.children]) {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        r.group.remove(child);
      }
    };
    dispose();
    for (const o of document.objects.filter((o) => o.visible)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(o.vertices, 3),
      );
      g.setIndex(o.triangles);
      g.computeVertexNormals();
      const m = new THREE.MeshStandardMaterial({
        color: o.color,
        roughness: 0.65,
        metalness: 0.12,
        flatShading: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.userData.id = o.id;
      r.group.add(mesh);
    }
    new THREE.Box3().setFromObject(r.group).getBoundingSphere(r.bounds);
    r.draw();
    return dispose;
  }, [document]);
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    const objects = new Map(document.objects.map((o) => [o.id, o]));
    for (const child of r.group.children) {
      const mesh = child as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.MeshStandardMaterial
      >;
      const object = objects.get(mesh.userData.id);
      if (!object) continue;
      mesh.material.color.set(
        object.id === selected ? "#72d8cb" : object.color,
      );
      if (mesh.material.wireframe !== wireframe) {
        mesh.material.wireframe = wireframe;
        // Three uses a different normal shader for flat-shaded faces and lines.
        mesh.material.needsUpdate = true;
      }
    }
    r.draw();
  }, [document, selected, wireframe]);
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    if (r.fitted !== document.id || r.fit !== fit) {
      const focus =
        focusId && r.group.children.find((o) => o.userData.id === focusId);
      const bounds = new THREE.Box3().setFromObject(focus || r.group);
      if (!bounds.isEmpty()) {
        const center = bounds.getCenter(new THREE.Vector3()),
          size = Math.max(bounds.getSize(new THREE.Vector3()).length(), 0.01);
        r.controls.target.copy(center);
        r.camera.position
          .copy(center)
          .add(new THREE.Vector3(1.3, -1.8, 1.2).multiplyScalar(size));
        r.controls.update();
      }
      r.fitted = document.id;
      r.fit = fit;
    }
    // Explicit framing must also work in webviews with throttled animation frames.
    r.draw();
  }, [document.id, fit, focusId]);
  return (
    <div
      ref={host}
      className="spatial-canvas"
      role="img"
      aria-label={`${document.engine} model viewport. Drag to orbit, scroll to zoom.`}
    />
  );
}

function NumberEdit({
  label,
  value,
  unit,
  onCommit,
  disabled = false,
}: {
  label: string;
  value: number;
  unit?: string;
  onCommit: (n: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setDraft(String(Number(value.toFixed(3))));
  };
  return (
    <label className="spatial-number">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        step="0.1"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <small>{unit}</small>
    </label>
  );
}

export function SpatialEditor({
  engine,
  active,
  onStarter,
}: {
  engine: "FreeCAD" | "Blender";
  active: boolean;
  onStarter?: () => void;
}) {
  const project = useProject();
  const documents = (project.project.spatial_documents ?? []).filter(
    (d) => d.engine === engine,
  );
  const [id, setId] = useState<string | null>(null),
    [picked, setPicked] = useState<string | null>(null);
  const document = documents.find((d) => d.id === id) ?? documents[0];
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [panel, setPanel] = useState("properties"),
    [wireframe, setWireframe] = useState(false),
    [fit, setFit] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(""),
    [proposal, setProposal] = useState<Proposal | null>(null),
    [render, setRender] = useState<{ image: string; version: string } | null>(
      null,
    ),
    [showRender, setShowRender] = useState(false),
    [other, setOther] = useState("");
  const shown = proposal?.document ?? document;
  const selected =
    shown?.objects.find((o) => o.id === picked) ??
    shown?.objects.find((o) => o.id === shown.selected) ??
    shown?.objects.find((o) => o.visible);
  useEffect(() => {
    setProposal(null);
    setRender(null);
    setShowRender(false);
    setPicked(null);
  }, [document?.id]);
  async function protect(label: string, work: () => Promise<unknown>) {
    if (busy) return;
    setError("");
    setBusy(label);
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }
  async function edit(operations: Operation[]) {
    if (!document) return;
    setProposal(null);
    await invoke("spatial_edit", {
      id: document.id,
      base: current().revision,
      operations,
      preview: false,
    });
  }
  const operate = (op: Operation) =>
    void protect("Updating model…", () => edit([op]));
  async function openModel(path: string | null) {
    const before = current().project.spatial_documents ?? [];
    const opened = await invoke<Snapshot>("spatial_open", {
      engine,
      path,
      base: current().revision,
    });
    const newDoc = (opened.project.spatial_documents ?? []).find(
      (d) => !before.some((o) => o.id === d.id),
    );
    if (newDoc) setId(newDoc.id);
  }
  async function exportModel(ext: string) {
    if (!document) return;
    const path = await save({
      defaultPath: `${document.name}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (path)
      await invoke("spatial_export", {
        id: document.id,
        path,
        base: current().revision,
      });
  }
  const modelControls = !!document && !busy && !proposal?.document;
  return (
    <div className="native-editor spatial-editor" hidden={!active}>
      <div className="native-document-tabs">
        <strong className="native-workspace-name">
          <Box size={17} />
          {engine === "FreeCAD" ? "CAD studio" : "Scene studio"}
        </strong>
        <div className="native-tabs-scroll">
          {documents.map((d) => (
            <button
              key={d.id}
              disabled={!!busy}
              className={d.id === document?.id ? "active" : ""}
              onClick={() => setId(d.id)}
            >
              {d.name}
              <small>{engine === "FreeCAD" ? "FCSTD" : "BLEND"}</small>
            </button>
          ))}
        </div>
        <button
          title="Detach this workspace"
          onClick={() =>
            void protect("Opening window…", () =>
              detach(engine === "FreeCAD" ? "cad" : "scene3d"),
            )
          }
        >
          <ExternalLink size={16} />
        </button>
      </div>
      <div className="native-commandbar">
        <button
          disabled={!!busy}
          onClick={() => void protect("Creating model…", () => openModel(null))}
        >
          <Plus size={15} />
          New
        </button>
        <button
          disabled={!!busy}
          onClick={() =>
            void protect("Opening model…", async () => {
              const p = await open({
                multiple: false,
                filters: [
                  {
                    name: "Model",
                    extensions:
                      engine === "FreeCAD"
                        ? ["FCStd", "step", "stp", "brep"]
                        : ["blend", "glb", "gltf", "stl"],
                  },
                ],
              });
              if (p) await openModel(p);
            })
          }
        >
          <FolderOpen size={15} />
          Open…
        </button>
        <button
          disabled={!document || !!busy}
          onClick={() =>
            void protect("Saving native file…", () =>
              exportModel(engine === "FreeCAD" ? "FCStd" : "blend"),
            )
          }
        >
          <Save size={15} />
          Save {engine === "FreeCAD" ? "FCStd" : "BLEND"}
        </button>
        <button
          disabled={!document || !!busy}
          onClick={() =>
            void protect("Exporting model…", () => exportModel("stl"))
          }
        >
          Export STL
        </button>
        <button
          disabled={!document || !!busy}
          onClick={() =>
            void protect("Exporting model…", () =>
              exportModel(engine === "FreeCAD" ? "step" : "glb"),
            )
          }
        >
          Export {engine === "FreeCAD" ? "STEP" : "GLB"}
        </button>
        {onStarter && <button onClick={onStarter}>Coastal study</button>}
        <span className="spatial-spacer" />
        <span className="engine-badge">
          {engine}
          <small>{document?.engine_version}</small>
        </span>
      </div>
      {shown ? (
        <>
          <div className="native-optionsbar">
            <button
              className={!wireframe && !showRender ? "active" : ""}
              onClick={() => {
                setWireframe(false);
                setShowRender(false);
              }}
            >
              Solid
            </button>
            <button
              className={wireframe && !showRender ? "active" : ""}
              onClick={() => {
                setWireframe(true);
                setShowRender(false);
              }}
            >
              Wireframe
            </button>
            <button
              onClick={() => {
                setFocusId(null);
                setFit((n) => n + 1);
                setShowRender(false);
              }}
            >
              <Maximize size={14} />
              Frame model
            </button>
            <button
              disabled={!selected}
              onClick={() => {
                setFocusId(selected?.id ?? null);
                setFit((n) => n + 1);
                setShowRender(false);
              }}
            >
              Frame selected
            </button>
            {engine === "Blender" && (
              <>
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void protect("Rendering in Blender…", async () => {
                      const result = await invoke<{
                        image: string;
                        version: string;
                      }>("spatial_render", {
                        id: document.id,
                        base: current().revision,
                      });
                      setRender(result);
                      setShowRender(true);
                    })
                  }
                >
                  Render
                </button>
                {render && (
                  <button onClick={() => setShowRender(true)}>
                    View render
                  </button>
                )}
              </>
            )}
            <span className="spatial-spacer" />
            <small>
              {shown.unit === "mm" ? "Millimetres" : "Metres"} ·{" "}
              {shown.objects.length} objects
            </small>
          </div>
          <div className="spatial-grid">
            <div className="spatial-tools">
              {(
                [
                  ["box", Box],
                  ["cylinder", Cylinder],
                  ["sphere", Circle],
                ] as const
              ).map(([shape, Icon]) => (
                <button
                  key={shape}
                  disabled={!modelControls}
                  title={`Add ${shape}`}
                  aria-label={`Add ${shape}`}
                  onClick={() => operate({ kind: "add", shape })}
                >
                  <Icon size={20} />
                </button>
              ))}
            </div>
            <div className="spatial-view">
              {showRender && render ? (
                <div className="spatial-render">
                  <img src={render.image} alt="Blender render" />
                  <small>
                    {render.version === document.version
                      ? "Render matches this model"
                      : "Render of an earlier model revision"}
                  </small>
                </div>
              ) : (
                <ModelCanvas
                  document={shown}
                  selected={selected?.id ?? null}
                  onSelect={setPicked}
                  wireframe={wireframe}
                  fit={fit}
                  focusId={focusId}
                />
              )}
              <div className="spatial-view-help">
                {showRender && render
                  ? "Frozen render · choose Solid or Wireframe to orbit"
                  : "Drag to orbit · right-drag to pan · scroll to zoom"}
              </div>
            </div>
            <aside className="spatial-inspector">
              <div className="panel-tabs">
                <button
                  className={panel === "properties" ? "active" : ""}
                  onClick={() => setPanel("properties")}
                >
                  Objects & properties
                </button>
                <button
                  className={panel === "ai" ? "active" : ""}
                  onClick={() => setPanel("ai")}
                >
                  <Sparkles size={14} />
                  Astra
                </button>
              </div>
              {panel === "properties" ? (
                <>
                  <div className="section-label">
                    OBJECTS <span>{shown.objects.length}</span>
                  </div>
                  <div className="spatial-objects">
                    {shown.objects.map((o) => (
                      <div
                        className={o.id === selected?.id ? "selected" : ""}
                        key={o.id}
                      >
                        <button
                          disabled={!modelControls}
                          aria-label={`${o.visible ? "Hide" : "Show"} ${o.name}`}
                          onClick={() =>
                            operate({
                              kind: "visibility",
                              object: o.id,
                              visible: !o.visible,
                            })
                          }
                        >
                          {o.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                        </button>
                        <button onClick={() => setPicked(o.id)}>
                          <Box size={16} />
                          <span>
                            {o.name}
                            <small>{o.kind}</small>
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                  {selected && (
                    <div className="spatial-properties" key={selected.id}>
                      <label>
                        Name
                        <input
                          aria-label="Object name"
                          disabled={!modelControls}
                          key={selected.name}
                          defaultValue={selected.name}
                          onBlur={(e) => {
                            if (e.target.value !== selected.name)
                              operate({
                                kind: "rename",
                                object: selected.id,
                                name: e.target.value,
                              });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                      </label>
                      <div className="section-label">DIMENSIONS</div>
                      {Object.entries(selected.dimensions).map(
                        ([key, value]) => (
                          <NumberEdit
                            key={key}
                            label={key}
                            value={value}
                            unit={shown.unit}
                            disabled={!modelControls}
                            onCommit={(n) =>
                              operate({
                                kind: "dimensions",
                                object: selected.id,
                                values: { [key]: n },
                              })
                            }
                          />
                        ),
                      )}
                      {!Object.keys(selected.dimensions).length && (
                        <p>
                          Dimensions come from this object's source geometry.
                        </p>
                      )}
                      <div className="section-label">POSITION</div>
                      {["X", "Y", "Z"].map((axis, i) => (
                        <NumberEdit
                          key={axis}
                          label={`Position ${axis}`}
                          value={selected.position[i]}
                          unit={shown.unit}
                          disabled={!modelControls}
                          onCommit={(n) =>
                            operate({
                              kind: "transform",
                              object: selected.id,
                              position: selected.position.map((v, j) =>
                                i === j ? n : v,
                              ),
                              rotation: selected.rotation,
                            })
                          }
                        />
                      ))}
                      <div className="section-label">ROTATION</div>
                      {["X", "Y", "Z"].map((axis, i) => (
                        <NumberEdit
                          key={axis}
                          label={`Rotation ${axis}`}
                          value={selected.rotation[i]}
                          unit="°"
                          disabled={!modelControls}
                          onCommit={(n) =>
                            operate({
                              kind: "transform",
                              object: selected.id,
                              position: selected.position,
                              rotation: selected.rotation.map((v, j) =>
                                i === j ? n : v,
                              ),
                            })
                          }
                        />
                      ))}
                      {engine === "Blender" && (
                        <label>
                          Material color
                          <input
                            aria-label="Material color"
                            type="color"
                            value={selected.color}
                            disabled={!modelControls}
                            onChange={(e) =>
                              operate({
                                kind: "color",
                                object: selected.id,
                                color: e.target.value,
                              })
                            }
                          />
                        </label>
                      )}
                      {selected.volume !== null && (
                        <p>
                          Volume{" "}
                          {selected.volume.toLocaleString(undefined, {
                            maximumFractionDigits: 2,
                          })}{" "}
                          mm³ ·{" "}
                          {selected.valid ? "valid shape" : "check geometry"}
                        </p>
                      )}
                      <div className="section-label">COMBINE OBJECTS</div>
                      <select
                        aria-label="Second object"
                        value={other}
                        onChange={(e) => setOther(e.target.value)}
                      >
                        <option value="">Choose second object…</option>
                        {shown.objects
                          .filter((o) => o.id !== selected.id)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                      </select>
                      <div className="row">
                        <button
                          disabled={!modelControls || !other}
                          onClick={() =>
                            operate({
                              kind: "union",
                              object: selected.id,
                              other,
                            })
                          }
                        >
                          Union
                        </button>
                        <button
                          disabled={!modelControls || !other}
                          onClick={() =>
                            operate({ kind: "cut", object: selected.id, other })
                          }
                        >
                          Subtract
                        </button>
                        <button
                          disabled={!modelControls}
                          aria-label="Delete selected object"
                          onClick={() =>
                            operate({ kind: "delete", object: selected.id })
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="spatial-ai">
                  <Sparkles size={24} />
                  <h3>Your design partner</h3>
                  <p>
                    Describe a dimension, placement, material, or solid
                    operation. Inspect the model preview before applying.
                  </p>
                  <textarea
                    aria-label="Model instruction"
                    placeholder={
                      engine === "FreeCAD"
                        ? "Make this part 60 mm long…"
                        : "Make this object twice as tall…"
                    }
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={!!busy || !prompt.trim()}
                    onClick={() =>
                      void protect(
                        "Astra is preparing a proposal…",
                        async () => {
                          const result = await invoke<Proposal>(
                            "spatial_propose",
                            {
                              id: document.id,
                              base: current().revision,
                              prompt,
                              selected: selected?.id ?? null,
                            },
                          );
                          if (result.supported)
                            result.document = await invoke<SpatialDocument>(
                              "spatial_edit",
                              {
                                id: document.id,
                                base: result.base,
                                operations: result.operations,
                                preview: true,
                              },
                            );
                          setProposal(result);
                          setShowRender(false);
                        },
                      )
                    }
                  >
                    Preview with Astra
                  </button>
                  {proposal && (
                    <div className="spatial-proposal">
                      <strong>
                        {proposal.document
                          ? "Preview · not applied"
                          : "Proposal"}
                      </strong>
                      <p>{proposal.summary}</p>
                      {proposal.document && (
                        <>
                          <button
                            className="primary"
                            disabled={
                              !!busy || project.revision !== proposal.base
                            }
                            onClick={() =>
                              void protect("Applying proposal…", async () => {
                                await invoke("spatial_edit", {
                                  id: document.id,
                                  base: proposal.base,
                                  operations: proposal.operations,
                                  preview: false,
                                });
                                setProposal(null);
                              })
                            }
                          >
                            Apply
                          </button>
                          <button onClick={() => setProposal(null)}>
                            Discard
                          </button>
                          {project.revision !== proposal.base && (
                            <p>
                              The project changed. Generate a fresh preview.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {engine === "FreeCAD" && (
                <div className="spatial-properties">
                  <div className="section-label">CONTINUE IN SCENE</div>
                  <p>
                    Copy visible solids into Blender as a mesh, with millimetres
                    converted to metres. This CAD document keeps its dimensions
                    and features.
                  </p>
                  <button
                    disabled={!!busy || !!proposal?.document}
                    onClick={() =>
                      void protect("Copying solids to Scene…", async () => {
                        await invoke("spatial_transfer", {
                          id: document.id,
                          base: current().revision,
                        });
                      })
                    }
                  >
                    Copy to Scene
                  </button>
                </div>
              )}
            </aside>
          </div>
        </>
      ) : (
        <div className="spatial-empty">
          <Box size={42} />
          <h2>
            {engine === "FreeCAD"
              ? "Build a dimensioned part"
              : "Create a scene"}
          </h2>
          <p>
            {engine === "FreeCAD"
              ? "Create editable solids, combine them, and export a part for fabrication."
              : "Create or import meshes, shape your scene, and render it in Blender."}
          </p>
          <button
            className="primary"
            disabled={!!busy}
            onClick={() =>
              void protect("Creating model…", () => openModel(null))
            }
          >
            New {engine === "FreeCAD" ? "part" : "scene"}
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
        ) : (
          <>
            <span className="live-dot" />
            Native {engine} document · shared across windows
          </>
        )}
        <span className="spatial-spacer" />
        Revision {project.revision}
      </div>
    </div>
  );
}
