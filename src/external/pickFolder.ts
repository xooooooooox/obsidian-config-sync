import { Platform } from "obsidian";

interface ElectronDialog {
  showOpenDialog(options: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** Opens the system directory picker. Returns the chosen absolute path, or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!Platform.isDesktop) {
    throw new Error("Config Sync: the folder picker is desktop-only");
  }
  // window.require, not import("electron"): esbuild keeps dynamic imports of externals
  // as native ESM import(), which the Electron renderer cannot resolve for bare specifiers.
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (req === undefined) {
    throw new Error("Config Sync: the folder picker needs the desktop app");
  }
  const electron = req("electron") as { remote?: { dialog?: ElectronDialog } };
  const dialog = electron.remote?.dialog;
  if (dialog === undefined) {
    throw new Error("Config Sync: the Electron file dialog is unavailable in this Obsidian build");
  }
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  const first = result.filePaths[0];
  if (result.canceled || first === undefined) return null;
  return first;
}
