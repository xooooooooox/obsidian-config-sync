import type { SecretStorage } from "obsidian";
import { GitAuth, Remote } from "../core/types";

// Hosts that only accept personal access tokens ignore the username, so this is what a remote
// that never set one sends. A self-hosted GitLab does validate it — those remotes carry their own.
const TOKEN_USERNAME = "token";

// A git remote stores only the NAME of a keychain secret (`tokenId`); the secret itself is
// per-device and stays in Obsidian's keychain. The name lives in the remotes list, which
// selfPresetRules keeps device-local, so it reaches another device only if the user's own vault
// sync carries data.json across. A device that never linked that name has no token — a state to
// report, not to paper over.
export function resolveGitToken(storage: Pick<SecretStorage, "getSecret">, remote: Remote): GitAuth | null {
  if (remote.type !== "git" || remote.tokenId === undefined) return null;
  const secret = storage.getSecret(remote.tokenId);
  if (secret === null || secret === "") {
    throw new Error(`No access token stored on this device for remote "${remote.name}" — link it once in Settings → Remotes.`);
  }
  if (/[\r\n]/.test(secret) || secret !== secret.trim()) {
    throw new Error(`The access token linked to remote "${remote.name}" has a line break or surrounding whitespace — re-save that secret in Settings → Keychain without it.`);
  }
  return { username: remote.username ?? TOKEN_USERNAME, token: secret };
}
