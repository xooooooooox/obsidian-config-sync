// Obsidian tracks two independent community-plugin states: `enabledPlugins` — the persisted
// community-plugins.json list — and `plugins` — the currently loaded instances. They diverge:
// a non-persistent `enablePlugin(id)` (used by config-sync's apply cycle and the IOTO ecosystem)
// loads a plugin WITHOUT adding it to `enabledPlugins`, so a running plugin can be absent from the
// persisted set. Obsidian's own toggle reflects the loaded state, so "on" means loaded OR persisted.
export interface PluginEnabledView {
  enabledPlugins: Set<string>;
  plugins: Record<string, unknown>;
}

export function pluginRuntimeEnabled(reg: PluginEnabledView, id: string): boolean {
  return reg.enabledPlugins.has(id) || reg.plugins[id] !== undefined;
}
