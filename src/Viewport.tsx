import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { emit, listen } from "@tauri-apps/api/event";
import { buildScene, disposeScene, exportScene } from "./scene";
import type { SceneSettings } from "./model";
import { native } from "./store";

export interface ViewportHandle {
  export: () => Promise<string>;
  reset: () => void;
}
export const Viewport = forwardRef<
  ViewportHandle,
  { settings: SceneSettings; wireframe: boolean; linked: boolean }
>(({ settings, wireframe, linked }, ref) => {
  const mount = useRef<HTMLDivElement>(null);
  const engine = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    scene: THREE.Scene;
    draw: () => void;
  } | null>(null);
  const current = useRef({ settings, wireframe, linked });
  current.current = { settings, wireframe, linked };
  const [error, setError] = useState("");
  useImperativeHandle(
    ref,
    () => ({
      export: async () => {
        if (!engine.current) throw Error("Viewport is unavailable");
        return exportScene(current.current.settings, engine.current.camera);
      },
      reset: () => {
        const e = engine.current;
        if (e) {
          e.camera.position.set(23, 18, 26);
          e.controls.target.set(0, 1, 1);
          e.controls.update();
          e.draw();
        }
      },
    }),
    [],
  );
  useEffect(() => {
    if (!mount.current) return;
    const host = mount.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (e) {
      setError(String(e));
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    host.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 600);
    camera.position.set(23, 18, 26);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1, 1);
    controls.minDistance = 8;
    controls.maxDistance = 95;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.update();
    const initialScene = buildScene(
      current.current.settings,
      current.current.wireframe,
    );
    const draw = () => {
      const e = engine.current;
      if (e) renderer.render(e.scene, camera);
    };
    engine.current = { renderer, camera, controls, scene: initialScene, draw };
    const source = crypto.randomUUID();
    let applying = false;
    let lastSent = 0;
    const onChange = () => {
      draw();
      if (
        native &&
        current.current.linked &&
        !applying &&
        performance.now() - lastSent > 40
      ) {
        lastSent = performance.now();
        void emit("camera-changed", {
          source,
          position: camera.position.toArray(),
          target: controls.target.toArray(),
        });
      }
    };
    controls.addEventListener("change", onChange);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (native)
      void listen<{ source: string; position: number[]; target: number[] }>(
        "camera-changed",
        ({ payload: p }) => {
          if (p.source === source || !current.current.linked) return;
          applying = true;
          camera.position.fromArray(p.position);
          controls.target.fromArray(p.target);
          controls.update();
          draw();
          applying = false;
        },
      ).then((f) => {
        if (disposed) f();
        else unlisten = f;
      });
    const observer = new ResizeObserver(() => {
      const w = host.clientWidth,
        h = host.clientHeight;
      if (w && h) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        draw();
      }
    });
    observer.observe(host);
    draw();
    return () => {
      disposed = true;
      unlisten?.();
      observer.disconnect();
      controls.dispose();
      if (engine.current) disposeScene(engine.current.scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    const e = engine.current;
    if (e) {
      const next = buildScene(settings, wireframe);
      disposeScene(e.scene);
      e.scene = next;
      e.draw();
    }
  }, [
    settings.pool_width,
    settings.pool_length,
    settings.coping,
    settings.water_color,
    settings.sun_angle,
    wireframe,
  ]);
  return (
    <div
      ref={mount}
      className="viewport"
      role="img"
      aria-label={
        wireframe
          ? "Interactive wireframe of coastal house and pool"
          : "Interactive shaded coastal house and pool"
      }
    >
      {error && (
        <div className="empty-state">GPU viewport could not start: {error}</div>
      )}
    </div>
  );
});
