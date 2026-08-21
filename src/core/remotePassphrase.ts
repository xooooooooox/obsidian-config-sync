import { Remote } from "./types";

// Which passphrase opens this remote's store. Three answers, because the three lead to different
// consequences downstream: `same-as-local` keeps every existing behaviour byte for byte (ciphertext
// travels verbatim, spec 3.9's default), `own` activates the each-side-its-own-key paths, and
// `missing` is a state the panel reports rather than papers over.
export type RemoteKey =
  | { kind: "same-as-local"; passphrase: string | null }
  | { kind: "own"; passphrase: string }
  | { kind: "missing"; secretId: string };

// Unlike `resolveGitToken`, absence does NOT throw. A token has no fallback — without one the
// transport simply cannot speak. A passphrase has one, and it is the road everybody is already on:
// this vault's own. Throwing on the unset case would make every vault that never encrypts anything
// start erroring the day this field exists.
//
// A NAMED entry this device does not hold is different: falling back would try our own secret
// against a store it was never meant for and read as "wrong passphrase" when the truth is "not
// linked here" — a worse answer than the honest one. An empty stored value counts as not held,
// the same reading resolveGitToken gives "".
export function resolveRemotePassphrase(
  storage: { getSecret(id: string): string | null },
  remote: Remote,
  local: string | null
): RemoteKey {
  if (remote.passphraseId === undefined) return { kind: "same-as-local", passphrase: local };
  const secret = storage.getSecret(remote.passphraseId);
  if (secret === null || secret === "") return { kind: "missing", secretId: remote.passphraseId };
  return { kind: "own", passphrase: secret };
}

// The key a COMPARISON opens the remote's copies with. `missing` opens nothing — null here is what
// sends every encrypted item to the honest "cannot: there" answer instead of trying a key that was
// never the right one.
export function remoteKeyPassphrase(key: RemoteKey): string | null {
  return key.kind === "missing" ? null : key.passphrase;
}
