import { describe, it, expect } from "vitest";
import { initial, validateScene } from "./model";
import { buildScene, disposeScene, poolPoints } from "./scene";
import * as THREE from "three";
describe("Scene contract", () => {
  it("rejects invalid agent values and accepts the starter scene", () => {
    expect(validateScene(initial.project.scene)).toBe(true);
    expect(validateScene({ ...initial.project.scene, pool_width: NaN })).toBe(
      false,
    );
    expect(
      validateScene({ ...initial.project.scene, water_color: "red;anything" }),
    ).toBe(false);
    expect(validateScene({ ...initial.project.scene, coping: 0 })).toBe(false);
  });
  it("changes pool geometry without changing the house", () => {
    const before = buildScene(initial.project.scene);
    const after = buildScene({ ...initial.project.scene, pool_width: 9 });
    const size = (s: THREE.Scene, name: string) =>
      new THREE.Box3()
        .setFromObject(s.getObjectByName(name)!)
        .getSize(new THREE.Vector3());
    expect(size(before, "House")).toEqual(size(after, "House"));
    expect(size(after, "Pool").x).toBeGreaterThan(size(before, "Pool").x);
    disposeScene(before);
    disposeScene(after);
  });
  it("wireframe hides expensive surface meshes but preserves scene content", () => {
    const s = buildScene(initial.project.scene, true);
    expect(s.getObjectByName("Pool")?.visible).toBe(false);
    expect(s.children.some((c) => c instanceof THREE.GridHelper)).toBe(true);
    disposeScene(s);
  });
  it("pool boundaries preserve the requested overall dimensions", () => {
    const pts = poolPoints(initial.project.scene);
    expect(
      Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)),
    ).toBe(6);
    expect(
      Math.max(...pts.map((p) => p.z)) - Math.min(...pts.map((p) => p.z)),
    ).toBe(9);
  });
});
