import { describe, expect, it } from "vitest";
import { canvasPoint, rectanglePoints } from "./engine-model";
describe("native canvas input", () => {
  it("maps the same point consistently at different zooms and clamps captured pen movement", () => {
    expect(
      canvasPoint(
        300,
        250,
        { left: 100, top: 150, width: 400, height: 200 },
        0.3,
      ),
    ).toEqual({ x: 0.5, y: 0.5, pressure: 0.3 });
    expect(
      canvasPoint(
        500,
        350,
        { left: 100, top: 150, width: 800, height: 400 },
        0.3,
      ),
    ).toEqual({ x: 0.5, y: 0.5, pressure: 0.3 });
    expect(
      canvasPoint(
        -10,
        999,
        { left: 100, top: 150, width: 400, height: 200 },
        0,
      ),
    ).toEqual({ x: 0, y: 1, pressure: 0.01 });
  });
  it("keeps rectangle corners inside the same image when drawn backwards", () => {
    const p = rectanglePoints(
      { x: 0.8, y: 0.9, pressure: 1 },
      { x: 0.2, y: 0.1, pressure: 1 },
    );
    expect(p.map((p) => [p.x, p.y])).toEqual([
      [0.8, 0.9],
      [0.2, 0.9],
      [0.2, 0.1],
      [0.8, 0.1],
    ]);
  });
});
