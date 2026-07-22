// Pure icon-catalog helpers for the Quick commands icon picker. Obsidian-free: the picker passes in
// Obsidian's built-in icon ids and iconize's loaded packs; this composes them into one choice list.

export interface IconPack {
  name: string;
  prefix: string;
  icons: { name: string; prefix: string }[];
}

export interface IconChoice {
  id: string; // stored icon id: a built-in id, or an iconize prefix+name (e.g. "FeSyncFeishu")
  text: string; // fuzzy-search haystack
  pack: string | null; // null = Obsidian built-in; else the iconize pack name (shown as a tag)
}

// Built-in ids first, then every icon from custom iconize packs. The "lucide-icons" pack is dropped —
// Obsidian already provides Lucide, so keeping it would list every Lucide glyph twice.
export function iconChoices(builtinIds: string[], packs: IconPack[]): IconChoice[] {
  const builtin: IconChoice[] = builtinIds.map((id) => ({ id, text: id, pack: null }));
  const custom: IconChoice[] = [];
  for (const pack of packs) {
    if (pack.name === "lucide-icons") continue;
    for (const icon of pack.icons) {
      const id = icon.prefix + icon.name;
      custom.push({ id, text: `${pack.name} ${icon.name} ${id}`, pack: pack.name });
    }
  }
  return [...builtin, ...custom];
}
