/** Keep clipping tied to the current camera, not the last object that was framed. */
export function viewportDepthRange(
  focusDistance: number,
  sceneDistance: number,
  sceneRadius: number,
) {
  const radius = Math.max(sceneRadius, 1e-6);
  const focus = Math.max(focusDistance, radius * 1e-6, 1e-6);
  const outside = sceneDistance - radius;
  const near = Math.max(
    1e-7,
    Math.min(focus * 0.01, outside > 0 ? outside * 0.5 : Infinity),
  );
  return { near, far: Math.max(near * 2, sceneDistance + radius * 1.05) };
}
