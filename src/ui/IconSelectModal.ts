import { App, FuzzyMatch, FuzzySuggestModal, getIconIds, setIcon } from "obsidian";

// Searchable icon picker (Commander-style) — fuzzy over every registered icon id, each suggestion
// rendered with a live preview. Mirrors FolderSelectModal/CommandSelectModal's shape.
export class IconSelectModal extends FuzzySuggestModal<string> {
  constructor(app: App, private onChoose: (icon: string) => void) {
    super(app);
    this.setPlaceholder("Pick an icon");
  }
  getItems(): string[] {
    return getIconIds();
  }
  getItemText(id: string): string {
    return id;
  }
  renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
    el.addClass("config-sync-iconpick");
    setIcon(el.createSpan({ cls: "config-sync-iconpick-glyph" }), match.item);
    el.createSpan({ text: match.item });
  }
  onChooseItem(id: string): void {
    this.onChoose(id);
  }
}
