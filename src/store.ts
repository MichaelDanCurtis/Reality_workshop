import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  initial,
  type Snapshot,
  type Project,
  type RenderState,
  type Integration,
} from "./model";

const subscribers = new Set<() => void>();
let snapshot: Snapshot = initial;
let render: RenderState = { status: "idle", revision: 0 };
const renderSubscribers = new Set<() => void>();
export const native = isTauri();
function accept(s: Snapshot) {
  if (s.revision >= snapshot.revision) {
    snapshot = s;
    subscribers.forEach((f) => f());
  }
}
function acceptRender(s: RenderState) {
  render = { ...render, ...s };
  renderSubscribers.forEach((f) => f());
}
export const useProject = () =>
  useSyncExternalStore(
    (f) => {
      subscribers.add(f);
      return () => subscribers.delete(f);
    },
    () => snapshot,
  );
export const useRender = () =>
  useSyncExternalStore(
    (f) => {
      renderSubscribers.add(f);
      return () => renderSubscribers.delete(f);
    },
    () => render,
  );
export const current = () => snapshot;
let initPromise: Promise<void> | null = null;
export function initialize() {
  return (initPromise ??= (async () => {
    if (native) {
      await listen<Snapshot>("document-changed", (e) => accept(e.payload));
      await listen<RenderState>("render-changed", (e) =>
        acceptRender(e.payload),
      );
      const [s, r] = await Promise.all([
        invoke<Snapshot>("get_document"),
        invoke<RenderState>("get_render"),
      ]);
      accept(s);
      acceptRender(r);
    }
  })());
}
export async function commit(
  project: Project,
  label: string,
  base = snapshot.revision,
) {
  if (!native)
    throw Error("Open the desktop application to edit the shared project.");
  try {
    accept(await invoke<Snapshot>("commit_project", { project, base, label }));
  } catch (e) {
    accept(await invoke<Snapshot>("get_document"));
    throw e;
  }
}
export async function history(redo = false) {
  accept(await invoke<Snapshot>("history_step", { redo }));
}
export async function save(path: string) {
  accept(await invoke<Snapshot>("save_project", { path }));
}
export async function load(path: string) {
  accept(await invoke<Snapshot>("open_project", { path }));
}
export async function detach(kind: string) {
  if (!native)
    throw Error("Multiple native windows are available in the desktop app.");
  await invoke("detach_window", { kind });
}
export async function getIntegrations() {
  return native ? invoke<Integration[]>("integrations") : [];
}
export async function startRender(gltf: string, revision: number) {
  const result = await invoke<RenderState>("start_render", { gltf, revision });
  acceptRender(result);
  if (result.status === "failed") throw Error(result.error || "Render failed");
}
