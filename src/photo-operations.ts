import { type Project, type ColorAdjustments, neutralEdit } from "./model";
export function copyColorToPhotos(
  project: Project,
  ids: string[],
  color: ColorAdjustments,
): Project {
  const edits = { ...project.photo_edits };
  for (const id of new Set(ids)) {
    if (!project.assets.some((a) => a.id === id))
      throw Error("A selected photo no longer exists");
    edits[id] = { ...(edits[id] ?? neutralEdit), color: { ...color } };
  }
  return { ...project, photo_edits: edits };
}
