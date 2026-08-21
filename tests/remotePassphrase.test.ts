import { describe, expect, it } from "vitest";
import { resolveRemotePassphrase } from "../src/core/remotePassphrase";
import { Remote } from "../src/core/types";

const REMOTE: Remote = { name: "work", type: "vault", storePath: "/tmp/store" };

function storage(secrets: Record<string, string>): { getSecret(id: string): string | null } {
  return { getSecret: (id) => secrets[id] ?? null };
}

describe("resolveRemotePassphrase", () => {
  it("falls back to this vault's own passphrase when the remote never named one", () => {
    expect(resolveRemotePassphrase(storage({}), REMOTE, "local-pw")).toEqual({ kind: "same-as-local", passphrase: "local-pw" });
  });

  // The overwhelmingly common case, and the one that must not start reporting anything: a vault
  // with no encrypted items at all has no passphrase either.
  it("carries a missing local passphrase through as the same answer, not as a problem", () => {
    expect(resolveRemotePassphrase(storage({}), REMOTE, null)).toEqual({ kind: "same-as-local", passphrase: null });
  });

  it("uses the remote's own passphrase when this device holds it", () => {
    const remote: Remote = { ...REMOTE, passphraseId: "work-pass" };
    expect(resolveRemotePassphrase(storage({ "work-pass": "their-pw" }), remote, "local-pw")).toEqual({ kind: "own", passphrase: "their-pw" });
  });

  // A named entry this device does not hold is a state to report, not one to paper over by
  // silently trying the local passphrase — that would send our own secret's key at a store it was
  // never meant for, and read as "wrong passphrase" when the truth is "not linked here".
  it("reports a named entry this device doesn't hold, rather than falling back", () => {
    const remote: Remote = { ...REMOTE, passphraseId: "work-pass" };
    expect(resolveRemotePassphrase(storage({}), remote, "local-pw")).toEqual({ kind: "missing", secretId: "work-pass" });
  });

  it("treats an empty stored secret as no secret at all", () => {
    const remote: Remote = { ...REMOTE, passphraseId: "work-pass" };
    expect(resolveRemotePassphrase(storage({ "work-pass": "" }), remote, "local-pw")).toEqual({ kind: "missing", secretId: "work-pass" });
  });
});
