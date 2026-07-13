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
