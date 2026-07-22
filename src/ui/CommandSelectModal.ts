import { App, Command, FuzzySuggestModal } from "obsidian";

// Fuzzy-search over every registered command; used by the Quick commands settings section to
// add an entry. Mirrors FolderSelectModal's shape.
export class CommandSelectModal extends FuzzySuggestModal<Command> {
  constructor(app: App, private onChoose: (cmd: Command) => void) {
    super(app);
    this.setPlaceholder("Pick a command to add");
  }
  getItems(): Command[] {
    const registry = (this.app as unknown as { commands: { commands: Record<string, Command> } }).commands;
    return Object.values(registry.commands);
  }
  getItemText(cmd: Command): string {
    return cmd.name;
  }
  onChooseItem(cmd: Command): void {
    this.onChoose(cmd);
  }
}
