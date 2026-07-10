import { Platform } from "obsidian";

interface ElectronDialog {
  showOpenDialog(options: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** Opens the system directory picker. Returns the chosen absolute path, or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!Platform.isDesktop) {
    throw new Error("Config Sync: the folder picker is desktop-only");
  }
  // @ts-expect-error electron is not available at compile time but is present at runtime in Obsidian desktop
  const electron = (await import("electron")) as unknown as { remote?: { dialog?: ElectronDialog } };
  const dialog = electron.remote?.dialog;
  if (dialog === undefined) {
    throw new Error("Config Sync: the Electron file dialog is unavailable in this Obsidian build");
  }
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  const first = result.filePaths[0];
  if (result.canceled || first === undefined) return null;
  return first;
}
