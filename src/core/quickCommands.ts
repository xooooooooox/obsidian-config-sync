import { QuickEntry, isSeparator } from "./types";

export type QuickMenuEntry =
  | { kind: "separator" }
  | { kind: "command"; commandId: string; label: string; icon: string; disabled: boolean };

// Maps configured quick entries to ribbon-menu entries: commands carry a `disabled` flag when not
// registered on this device; separators are normalized (no leading/trailing/consecutive dividers,
// and the whole list collapses to [] when it holds no command). Obsidian-free.
export function quickMenuEntries(
  entries: QuickEntry[],
  isRegistered: (commandId: string) => boolean
): QuickMenuEntry[] {
  const mapped: QuickMenuEntry[] = entries.map((e) =>
    isSeparator(e)
      ? { kind: "separator" }
      : { kind: "command", commandId: e.commandId, label: e.label, icon: e.icon, disabled: !isRegistered(e.commandId) }
  );
  const out: QuickMenuEntry[] = [];
  for (const e of mapped) {
    if (e.kind === "separator") {
      const last = out[out.length - 1];
      if (last === undefined) continue; // no leading separator
      if (last.kind === "separator") continue; // collapse consecutive
    }
    out.push(e);
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last === undefined || last.kind !== "separator") break;
    out.pop(); // no trailing separator
  }
  return out.some((e) => e.kind === "command") ? out : [];
}
