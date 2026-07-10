import { App, FuzzySuggestModal } from "obsidian";
import { Remote } from "../core/types";

export class SourceSelectModal extends FuzzySuggestModal<Remote> {
  constructor(app: App, private remotes: Remote[], private onChoose: (r: Remote) => void) {
    super(app);
    this.setPlaceholder("Select a remote");
  }

  getItems(): Remote[] {
    return this.remotes;
  }

  getItemText(r: Remote): string {
    return `${r.name} (${r.type})`;
  }

  onChooseItem(r: Remote): void {
    this.onChoose(r);
  }
}
