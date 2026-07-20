interface ButtonBuilder {
  setCta(): ButtonBuilder;
  setButtonText(text: string): ButtonBuilder;
  onClick(fn: () => void): ButtonBuilder;
}

export class Setting {
  setName(name: string): this {
    return this;
  }
  addButton(callback: (b: ButtonBuilder) => void): this {
    const builder: ButtonBuilder = {
      setCta() { return this; },
      setButtonText() { return this; },
      onClick() { return this; },
    };
    callback(builder);
    return this;
  }
}

export class Modal {
  titleEl = { addClass() {}, setText() {} };
  contentEl = { empty() {}, createDiv: () => ({}) };
  constructor(app: unknown) {}
  open(): void {}
  onClose(): void {}
}

export class App {}

// Minimal stand-ins so importing a UI module (e.g. for its pure helpers) doesn't throw on
// `class X extends <mocked base>` — no test drives these components, so they carry no behavior.
export class Plugin {}
export class PluginSettingTab {}
export class FuzzySuggestModal<T> {
  protected items: T[] = [];
}
export class ButtonComponent {}
export class DropdownComponent {}
export class ExtraButtonComponent {}
export class SearchComponent {}
export class TextComponent {}
export class ToggleComponent {}
export class Notice {}
export const Platform = { isMobile: false, isDesktop: true, isDesktopApp: true, isMobileApp: false };
export function setIcon(): void {}
