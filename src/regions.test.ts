import { expect, test } from "vitest";
import { normalizedPoint, polygonArea } from "./regions";

test("photo coordinates stay aligned across display sizes and clamp pen excursions", () => {
  expect(
    normalizedPoint(
      150,
      100,
      { left: 50, top: 50, width: 400, height: 200 },
      0.8,
    ),
  ).toEqual(
    normalizedPoint(
      300,
      200,
      { left: 100, top: 100, width: 800, height: 400 },
      0.8,
    ),
  );
  expect(
    normalizedPoint(-10, 300, { left: 0, top: 0, width: 100, height: 100 }, 2),
  ).toEqual({ x: 0, y: 1, pressure: 1 });
});
test("a click or straight line is not an editable area", () => {
  expect(
    polygonArea([
      { x: 0, y: 0, pressure: 0.5 },
      { x: 0.5, y: 0.5, pressure: 0.5 },
      { x: 1, y: 1, pressure: 0.5 },
    ]),
  ).toBe(0);
  expect(
    polygonArea([
      { x: 0, y: 0, pressure: 0.5 },
      { x: 1, y: 0, pressure: 0.5 },
      { x: 1, y: 1, pressure: 0.5 },
    ]),
  ).toBe(0.5);
});
