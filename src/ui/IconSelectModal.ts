import { App, FuzzyMatch, FuzzySuggestModal, getIconIds } from "obsidian";
import { IconChoice, iconChoices } from "../core/icons";
import { iconizePacks, renderIcon } from "./iconRender";

// Searchable icon picker — fuzzy over Obsidian's built-in icons plus iconize custom-pack icons, each
// suggestion rendered with a live preview. Mirrors CommandSelectModal's shape.
export class IconSelectModal extends FuzzySuggestModal<IconChoice> {
  constructor(app: App, private onChoose: (icon: string) => void) {
    super(app);
    this.setPlaceholder("Pick an icon");
  }
  getItems(): IconChoice[] {
    return iconChoices(getIconIds(), iconizePacks(this.app));
  }
  getItemText(choice: IconChoice): string {
    return choice.text;
  }
  renderSuggestion(match: FuzzyMatch<IconChoice>, el: HTMLElement): void {
    el.addClass("config-sync-iconpick");
    renderIcon(el.createSpan({ cls: "config-sync-iconpick-glyph" }), match.item.id, undefined, this.app);
    el.createSpan({ text: match.item.id });
    if (match.item.pack !== null) el.createSpan({ cls: "config-sync-iconpick-pack", text: match.item.pack });
  }
  onChooseItem(choice: IconChoice): void {
    this.onChoose(choice.id);
  }
}
