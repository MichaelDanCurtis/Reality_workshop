import { expect, test } from "vitest";
import { copyColorToPhotos } from "./photo-operations";
import { initial, neutralEdit } from "./model";
test("batch replaces color for forty photos while preserving crop, source and region edits", () => {
  const assets = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    name: `Photo ${i}.png`,
    data_url: "data:image/png;base64,AA==",
  }));
  const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
  const project = {
    ...initial.project,
    assets,
    photo_edits: { "0": { ...neutralEdit, crop, quarter_turns: 1 } },
  };
  const color = { exposure: 0.5, contrast: 10, saturation: -15, warmth: 20 };
  const next = copyColorToPhotos(
    project,
    assets.map((a) => a.id),
    color,
  );
  expect(Object.keys(next.photo_edits!)).toHaveLength(40);
  expect(next.photo_edits!["0"].crop).toEqual(crop);
  expect(next.photo_edits!["0"].quarter_turns).toBe(1);
  expect(next.photo_edits!["39"].color).toEqual(color);
  expect(next.assets).toBe(project.assets);
  expect(project.photo_edits["0"].color.exposure).toBe(0);
  expect(() => copyColorToPhotos(project, ["missing"], color)).toThrow();
});
