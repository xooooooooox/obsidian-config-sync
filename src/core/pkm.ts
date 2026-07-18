import { FileIO } from "./io";

export type PkmMode = "auto" | "ioto" | "default";

export interface PkmProbe {
  io: FileIO;
  configDir: string;
  isPluginEnabled(id: string): boolean;
}

export const DEFAULT_ROOT = "config-sync";
export const IOTO_FALLBACK_ROOT = "0-Extra/config-sync";

export function resolveEffectiveMode(mode: PkmMode, probe: PkmProbe): "ioto" | "default" {
  if (mode === "auto") {
    return probe.isPluginEnabled("ioto-update") ? "ioto" : "default";
  }
  return mode;
}

export async function defaultRootForMode(effective: "ioto" | "default", probe: PkmProbe): Promise<string> {
  if (effective === "default") return DEFAULT_ROOT;
  const settingsPath = `${probe.configDir}/plugins/ioto-settings/data.json`;
  if (!(await probe.io.exists(settingsPath))) return IOTO_FALLBACK_ROOT;
  try {
    const data = JSON.parse(await probe.io.read(settingsPath)) as Record<string, unknown>;
    const extra = data.extraFolder;
    if (typeof extra === "string" && extra.trim() !== "") {
      return `${extra.trim().replace(/\/+$/, "")}/config-sync`;
    }
  } catch {
    // spec-mandated fallback: an unreadable ioto-settings file must not break the plugin
  }
  return IOTO_FALLBACK_ROOT;
}

// The first candidate root that already holds a store (store.lock.json), or null.
export async function discoverStoreRoot(candidates: string[], hasStore: (root: string) => Promise<boolean>): Promise<string | null> {
  for (const root of candidates) {
    if (await hasStore(root)) return root;
  }
  return null;
}

export async function resolveRootPath(customRootPath: string, mode: PkmMode, probe: PkmProbe): Promise<string> {
  const custom = customRootPath.trim();
  if (custom !== "") return custom; // deliberate choice wins — no discovery override

  // Auto/empty: PKM auto-detection is circular on a fresh device (ioto-update is enabled only
  // after adopt), so it can point at the wrong root. Prefer wherever a store actually lives,
  // trying the mode default first, then the known default + IOTO placements.
  const modeDefault = await defaultRootForMode(resolveEffectiveMode(mode, probe), probe);
  const iotoRoot = await defaultRootForMode("ioto", probe);
  const candidates = [...new Set([modeDefault, DEFAULT_ROOT, iotoRoot])];
  const found = await discoverStoreRoot(candidates, (root) => probe.io.exists(`${root}/store.lock.json`));
  return found ?? modeDefault; // no store anywhere → mode default (first capture creates it there)
}
