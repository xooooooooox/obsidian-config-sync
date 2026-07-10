import { App, FuzzySuggestModal } from "obsidian";

export class FolderSelectModal extends FuzzySuggestModal<string> {
  constructor(app: App, private folders: string[], private onChoose: (f: string) => void) {
    super(app);
    this.setPlaceholder("Several stores found — pick one");
  }
  getItems(): string[] {
    return this.folders;
  }
  getItemText(f: string): string {
    return f;
  }
  onChooseItem(f: string): void {
    this.onChoose(f);
  }
}
