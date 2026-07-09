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

export async function resolveRootPath(customRootPath: string, mode: PkmMode, probe: PkmProbe): Promise<string> {
  const custom = customRootPath.trim();
  if (custom !== "") return custom;
  return defaultRootForMode(resolveEffectiveMode(mode, probe), probe);
}
