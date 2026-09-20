import { describe, expect, it } from "vitest";
import { viewportDepthRange } from "./viewport-camera";

describe("native viewport depth precision", () => {
  it("keeps the whole coastal scene visible after framing a small feature and zooming out", () => {
    const close = viewportDepthRange(3, 115, 208);
    const distant = viewportDepthRange(150, 180, 208);
    expect(close.near).toBeLessThan(3);
    expect(distant.near).toBeGreaterThan(close.near);
    expect(close.far).toBeGreaterThan(115 + 208);
    expect(distant.far).toBeGreaterThan(180 + 208);
    expect(distant.far).toBeLessThan(1000);
    // Three's logarithmic fragment depth, quantized to a 24-bit depth buffer.
    const depth = (z: number) =>
      Math.round(
        (Math.log2(1 + z) / Math.log2(1 + distant.far)) * (2 ** 24 - 1),
      );
    for (const z of [3, 50, 150, 300]) {
      expect(depth(z + 0.01) - depth(z)).toBeGreaterThan(20);
    }
  });

  it("does not clip millimetre CAD parts or the front of an enclosing model", () => {
    for (const scale of [0.001, 1, 1000]) {
      const range = viewportDepthRange(
        0.15 * scale,
        0.15 * scale,
        0.04 * scale,
      );
      expect(range.near).toBeGreaterThan(0);
      expect(range.near).toBeLessThan(0.11 * scale);
      expect(range.far).toBeGreaterThan(0.19 * scale);
    }
    const boundary = viewportDepthRange(20, 10.001, 10);
    expect(boundary.near).toBeLessThan(0.001);
    expect(boundary.far).toBeGreaterThan(20.001);
  });
});
