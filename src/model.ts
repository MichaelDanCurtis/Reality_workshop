export interface SceneSettings {
  pool_width: number;
  pool_length: number;
  coping: number;
  water_color: string;
  sun_angle: number;
}
export interface Asset {
  id: string;
  name: string;
  data_url: string;
}
export interface RegionPoint {
  x: number;
  y: number;
  pressure: number;
}
export interface PhotoRegion {
  id: string;
  asset_id: string;
  instruction: string;
  points: RegionPoint[];
  adjustments?: ColorAdjustments;
}
export interface ColorAdjustments {
  exposure: number;
  contrast: number;
  saturation: number;
  warmth: number;
}
export interface PhotoEdit {
  color: ColorAdjustments;
  quarter_turns: number;
  flip_x: boolean;
  crop: { x: number; y: number; width: number; height: number } | null;
}
export const neutralColor: ColorAdjustments = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
};
export const neutralEdit: PhotoEdit = {
  color: neutralColor,
  quarter_turns: 0,
  flip_x: false,
  crop: null,
};
export interface Project {
  schema: number;
  name: string;
  scene: SceneSettings;
  assets: Asset[];
  regions?: PhotoRegion[];
  photo_edits?: Record<string, PhotoEdit>;
}
export interface Snapshot {
  project: Project;
  revision: number;
  saved_revision: number;
  can_undo: boolean;
  can_redo: boolean;
  history: string[];
  file: string | null;
}
export interface RenderState {
  status: string;
  revision: number;
  image?: string | null;
  error?: string | null;
}
export interface Integration {
  name: string;
  available: boolean;
  path: string | null;
  capability: string;
}
export interface Proposal {
  summary: string;
  scene: SceneSettings;
  revision: number;
}
export const initial: Snapshot = {
  project: {
    schema: 3,
    name: "Coastal house",
    scene: {
      pool_width: 6,
      pool_length: 9,
      coping: 0.45,
      water_color: "#42b9be",
      sun_angle: 45,
    },
    assets: [],
  },
  revision: 0,
  saved_revision: 0,
  can_undo: false,
  can_redo: false,
  history: ["Starter scene"],
  file: null,
};
export function validateScene(s: SceneSettings): boolean {
  return (
    Number.isFinite(s.pool_width) &&
    s.pool_width >= 2 &&
    s.pool_width <= 12 &&
    Number.isFinite(s.pool_length) &&
    s.pool_length >= 3 &&
    s.pool_length <= 16 &&
    Number.isFinite(s.coping) &&
    s.coping >= 0.1 &&
    s.coping <= 1.5 &&
    /^#[0-9a-f]{6}$/i.test(s.water_color) &&
    Number.isFinite(s.sun_angle) &&
    s.sun_angle >= 5 &&
    s.sun_angle <= 175
  );
}
