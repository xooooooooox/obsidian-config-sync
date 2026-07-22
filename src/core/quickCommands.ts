import { QuickCommand } from "./types";

export interface QuickCommandEntry {
  commandId: string;
  label: string;
  icon: string;
  disabled: boolean; // command not registered on this device
}

// Maps configured quick commands to menu entries, marking any command that is not currently
// registered as disabled. `isRegistered` wraps app.commands so this stays Obsidian-free.
export function quickCommandEntries(
  list: QuickCommand[],
  isRegistered: (commandId: string) => boolean
): QuickCommandEntry[] {
  return list.map((qc) => ({
    commandId: qc.commandId,
    label: qc.label,
    icon: qc.icon,
    disabled: !isRegistered(qc.commandId),
  }));
}
