// Config Sync's own keychain entries. Named here rather than at their use sites so the settings
// UI and the manifest validator can refuse to hand one of them to something else — the vault
// passphrase must never be offered to a git host as a password.
export const PASSPHRASE_SECRET_ID = "config-sync-passphrase";
