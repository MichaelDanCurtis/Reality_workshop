import type { RegionPoint } from "./model";
export function normalizedPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  pressure: number,
): RegionPoint {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return {
    x: clamp((x - rect.left) / Math.max(1, rect.width)),
    y: clamp((y - rect.top) / Math.max(1, rect.height)),
    pressure: clamp(pressure),
  };
}
export function polygonArea(points: RegionPoint[]): number {
  return (
    Math.abs(
      points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + p.x * q.y - q.x * p.y;
      }, 0),
    ) / 2
  );
}
