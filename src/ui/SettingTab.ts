import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ExternalSource } from "../core/types";
import { parseExternalSources } from "../core/manifest";

export interface SettingsHost extends Plugin {
  settings: { rootPath: string; externalSources: ExternalSource[] };
  saveSettings(): Promise<void>;
}

export class ConfigSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Data folder")
      .setDesc("Vault-relative folder holding manifest.json, store.lock.json and store/. Synced by remotely-save like normal notes.")
      .addText((t) =>
        t.setValue(this.host.settings.rootPath).onChange(async (v) => {
          this.host.settings.rootPath = v.trim();
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("External sources")
      .setDesc(
        'JSON array, desktop import only. Example: [{"name":"main (local)","type":"local-path","path":"/abs/path/main.vault","root":"0-Extra/config-sync"},{"name":"main (git)","type":"git","remote":"git@host:group/repo.git","branch":"main","root":"0-Extra/config-sync"}]'
      )
      .addTextArea((t) => {
        t.inputEl.rows = 10;
        t.inputEl.cols = 60;
        t.setValue(JSON.stringify(this.host.settings.externalSources, null, 2));
        t.onChange(async (v) => {
          try {
            this.host.settings.externalSources = parseExternalSources(v);
            await this.host.saveSettings();
          } catch (e) {
            new Notice(`External sources not saved: ${(e as Error).message}`, 8000);
          }
        });
      });
  }
}
