export type Engine = "GIMP" | "Krita";
export interface NativeLayer {
  id: string;
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  mode: string;
  depth: number;
  mask: boolean;
  locked: boolean;
}
export interface NativeDocument {
  id: string;
  engine: Engine;
  version: string;
  name: string;
  file: string;
  preview: string;
  width: number;
  height: number;
  layers: NativeLayer[];
  selected: string | null;
  selection: boolean;
  selection_preview?: string | null;
  engine_version: string;
  presets: string[];
}
export interface EnginePoint {
  x: number;
  y: number;
  pressure: number;
}
export type EngineOperation = { kind: string; [key: string]: unknown };
export interface EngineProposal {
  summary: string;
  supported: boolean;
  operations: EngineOperation[];
  base: number;
  id: string;
}
export function canvasPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  pressure: number,
): EnginePoint {
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    pressure: Math.max(0.01, Math.min(1, pressure)),
  };
}
export function rectanglePoints(a: EnginePoint, b: EnginePoint): EnginePoint[] {
  return [
    a,
    { x: b.x, y: a.y, pressure: 1 },
    b,
    { x: a.x, y: b.y, pressure: 1 },
  ];
}
