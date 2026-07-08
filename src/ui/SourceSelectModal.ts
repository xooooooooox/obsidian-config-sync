import { App, FuzzySuggestModal } from "obsidian";
import { ExternalSource } from "../core/types";

export class SourceSelectModal extends FuzzySuggestModal<ExternalSource> {
  constructor(app: App, private sources: ExternalSource[], private onChoose: (s: ExternalSource) => void) {
    super(app);
    this.setPlaceholder("Select an external source to import from");
  }

  getItems(): ExternalSource[] {
    return this.sources;
  }

  getItemText(s: ExternalSource): string {
    return `${s.name} (${s.type})`;
  }

  onChooseItem(s: ExternalSource): void {
    this.onChoose(s);
  }
}
