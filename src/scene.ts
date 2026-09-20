import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import type { SceneSettings } from "./model";

export function poolPoints(s: SceneSettings, extra = 0) {
  return [
    [-0.85, -0.8],
    [-0.15, -1],
    [0.8, -0.75],
    [1, -0.15],
    [0.75, 0.65],
    [0.05, 1],
    [-0.9, 0.65],
    [-1, 0.05],
  ].map(
    ([x, z]) =>
      new THREE.Vector3(
        x * (s.pool_width / 2 + extra),
        0,
        z * (s.pool_length / 2 + extra),
      ),
  );
}
function poolShape(s: SceneSettings, extra = 0) {
  const curve = new THREE.CatmullRomCurve3(
    poolPoints(s, extra),
    true,
    "catmullrom",
    0.5,
  );
  return new THREE.Shape(
    curve.getPoints(80).map((p) => new THREE.Vector2(p.x, -p.z)),
  );
}
export function buildScene(s: SceneSettings, wireframe = false) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(wireframe ? "#182126" : "#b7ccd0");
  const root = new THREE.Group();
  scene.add(root);
  const mat = (color: string, roughness = 0.7) =>
    new THREE.MeshStandardMaterial({ color, roughness });
  const stone = mat("#d8ccb4"),
    wall = mat("#e9dfcb"),
    wood = mat("#654b38"),
    frame = mat("#353e3e"),
    grass = mat("#758668"),
    glass = new THREE.MeshPhysicalMaterial({
      color: "#88a3a9",
      roughness: 0.12,
      metalness: 0.2,
      transparent: true,
      opacity: 0.68,
    });
  function mesh(
    g: THREE.BufferGeometry,
    m: THREE.Material,
    pos: number[],
    name: string,
  ) {
    const o = new THREE.Mesh(g, m);
    o.position.set(pos[0], pos[1], pos[2]);
    o.name = name;
    o.castShadow = true;
    o.receiveShadow = true;
    root.add(o);
    return o;
  }
  function box(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    m: THREE.Material,
    name = "House",
  ) {
    return mesh(new THREE.BoxGeometry(w, h, d), m, [x, y, z], name);
  }
  box(38, 0.35, 37, 0, -0.3, 0, grass, "Terrain");
  box(27, 0.32, 28, 0, -0.07, 1, stone, "Terrace");
  box(13, 3.6, 6, -2, 1.9, -7, wall);
  box(13.8, 0.24, 7, -2, 3.85, -7, stone);
  box(8.8, 3.0, 5.6, -4, 5.4, -7, wall);
  box(10, 0.22, 6.8, -4, 7.03, -7, stone);
  box(12, 0.12, 2.7, -2, 3.92, -3, stone);
  box(11.8, 0.95, 0.07, -2, 4.5, -1.7, glass);
  for (let i = 0; i < 6; i++) {
    box(1.75, 2.8, 0.07, -7.2 + i * 2, 1.75, -3.97, glass);
    box(0.09, 3.05, 0.12, -8.1 + i * 2, 1.8, -3.9, frame);
  }
  for (let i = 0; i < 4; i++) {
    box(1.85, 2.5, 0.08, -7 + i * 2, 5.5, -4.17, glass);
    box(0.08, 2.7, 0.12, -8 + i * 2, 5.5, -4.1, frame);
  }
  for (let i = 0; i < 15; i++)
    box(0.08, 2.8, 0.1, 1.2 + i * 0.2, 1.6, -3.86, wood);
  for (let i = 0; i < 3; i++)
    box(6, 0.14, 1.2, -2, 0.12 + i * 0.13, -2.6 - i * 0.65, stone, "Steps");
  const outer = poolShape(s, s.coping);
  outer.holes.push(new THREE.Path(poolShape(s).getPoints()));
  const coping = mesh(
    new THREE.ShapeGeometry(outer, 64),
    stone,
    [2, 0.15, 6],
    "Pool deck",
  );
  coping.rotation.x = -Math.PI / 2;
  const water = mesh(
    new THREE.ShapeGeometry(poolShape(s), 64),
    new THREE.MeshPhysicalMaterial({
      color: s.water_color,
      roughness: 0.12,
      metalness: 0.15,
      clearcoat: 1,
    }),
    [2, 0.12, 6],
    "Pool",
  );
  water.rotation.x = -Math.PI / 2;
  const outlinePoints = new THREE.CatmullRomCurve3(
    poolPoints(s),
    true,
    "catmullrom",
    0.5,
  )
    .getPoints(100)
    .map((p) => p.add(new THREE.Vector3(2, 0.18, 6)));
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(outlinePoints),
    new THREE.LineBasicMaterial({ color: "#75ede1" }),
  );
  outline.userData.overlay = true;
  root.add(outline);
  for (const p of poolPoints(s)) {
    const o = mesh(
      new THREE.SphereGeometry(0.085, 12, 8),
      mat("#bafff5"),
      [p.x + 2, 0.2, p.z + 6],
      "Control",
    );
    o.userData.overlay = true;
  }
  // Terraced garden and furniture, all editable geometry rather than a background image.
  for (let i = 0; i < 3; i++) {
    box(1.1, 0.18, 2.5, -6.5 + i * 1.65, 0.48, 3, wood, "Lounger");
    box(1.02, 0.13, 2.35, -6.5 + i * 1.65, 0.65, 3, wall, "Cushion");
    box(0.1, 0.45, 2.3, -7 + i * 1.65, 0.2, 3, frame, "Lounger");
  }
  for (const [x, z, h] of [
    [-12, -4, 7],
    [10, -8, 8],
    [12, 8, 6],
    [-12, 12, 7],
  ]) {
    mesh(
      new THREE.CylinderGeometry(0.13, 0.24, h, 9),
      wood,
      [x, h / 2, z],
      "Palm",
    );
    for (let k = 0; k < 9; k++) {
      const leaf = new THREE.Shape();
      leaf.moveTo(0, 0);
      leaf.quadraticCurveTo(1.5, 0.7, 3.5, 0);
      leaf.quadraticCurveTo(1.5, -0.5, 0, 0);
      const o = mesh(
        new THREE.ShapeGeometry(leaf),
        new THREE.MeshStandardMaterial({
          color: "#46624b",
          side: THREE.DoubleSide,
        }),
        [x, h, z],
        "Palm",
      );
      o.rotation.set(-0.9, (k * Math.PI * 2) / 9, 0.35);
    }
  }
  for (const [x, z] of [
    [8, -1],
    [-10, 0],
    [10, 12],
  ]) {
    mesh(
      new THREE.CylinderGeometry(0.6, 0.43, 0.9, 24),
      wall,
      [x, 0.45, z],
      "Planter",
    );
    mesh(new THREE.SphereGeometry(0.8, 16, 10), grass, [x, 1.25, z], "Plant");
  }
  const ocean = mesh(
    new THREE.PlaneGeometry(350, 220),
    new THREE.MeshStandardMaterial({
      color: "#527f91",
      roughness: 0.24,
      metalness: 0.2,
    }),
    [0, -1, -110],
    "Ocean",
  );
  ocean.rotation.x = -Math.PI / 2;
  scene.add(new THREE.HemisphereLight("#edf6ff", "#64714f", 2.1));
  const sun = new THREE.DirectionalLight("#fff3dc", 3.2);
  sun.position.set(
    Math.cos((s.sun_angle * Math.PI) / 180) * 25,
    28,
    Math.sin((s.sun_angle * Math.PI) / 180) * 25,
  );
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -25,
    right: 25,
    top: 25,
    bottom: -25,
    far: 100,
  });
  sun.shadow.bias = -0.001;
  scene.add(sun);
  if (wireframe) {
    const objects: THREE.Mesh[] = [];
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) objects.push(o);
    });
    for (const o of objects) {
      if (o.name === "Ocean") {
        o.visible = false;
        continue;
      }
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(o.geometry, 20),
        new THREE.LineBasicMaterial({
          color: o.name === "Pool" ? "#72e4db" : "#5e7c83",
        }),
      );
      line.position.copy(o.position);
      line.rotation.copy(o.rotation);
      root.add(line);
      o.visible = false;
    }
    const grid = new THREE.GridHelper(44, 44, "#38515b", "#26373e");
    grid.position.y = -0.2;
    scene.add(grid);
  }
  return scene;
}
export function disposeScene(scene: THREE.Scene) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geometries.add(m.geometry);
    if (m.material)
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((v) =>
        materials.add(v),
      );
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}
export async function exportScene(
  settings: SceneSettings,
  camera: THREE.PerspectiveCamera,
) {
  const scene = buildScene(settings);
  scene.userData.sun_angle = settings.sun_angle;
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (o.userData.overlay) toRemove.push(o);
  });
  toRemove.forEach((o) => o.removeFromParent());
  const cam = camera.clone();
  cam.name = "StudioCamera";
  scene.add(cam);
  try {
    return JSON.stringify(
      await new GLTFExporter().parseAsync(scene, { binary: false }),
    );
  } finally {
    disposeScene(scene);
  }
}
