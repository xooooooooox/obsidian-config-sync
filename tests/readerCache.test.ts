import { describe, it, expect } from "vitest";
import { remoteReaderKey, ReaderCache, REUSE_MAX_AGE_MS } from "../src/external/readerCache";
import { Remote } from "../src/core/types";

describe("remoteReaderKey", () => {
  it("same git config → same key; changed url/branch/subdir/name → different keys", () => {
    const base: Remote = { type: "git", name: "r", url: "u", branch: "main", subdir: "s" };
    const k = remoteReaderKey(base);
    expect(remoteReaderKey({ ...base })).toBe(k);
    expect(remoteReaderKey({ ...base, url: "u2" })).not.toBe(k);
    expect(remoteReaderKey({ ...base, branch: "dev" })).not.toBe(k);
    expect(remoteReaderKey({ ...base, subdir: "s2" })).not.toBe(k);
    expect(remoteReaderKey({ ...base, name: "r2" })).not.toBe(k);
  });
  it("vault and git remotes never collide", () => {
    const vaultRemote: Remote = { type: "vault", name: "r", storePath: "/p" };
    const gitRemote: Remote = { type: "git", name: "r", url: "/p", branch: "main", subdir: "" };
    expect(remoteReaderKey(vaultRemote)).not.toBe(remoteReaderKey(gitRemote));
  });
});

describe("ReaderCache", () => {
  it("reuses within a generation and invalidates on bump", () => {
    const c = new ReaderCache<{ id: number }>(() => 0);
    const a = { id: 1 };
    c.store("k", a);
    expect(c.getReusable("k")).toBe(a);        // same generation → hit
    c.bumpGeneration();
    expect(c.getReusable("k")).toBeUndefined(); // new generation → miss
    const b = { id: 2 };
    c.store("k", b);
    expect(c.getReusable("k")).toBe(b);
  });
  it("clear() drops all entries", () => {
    const c = new ReaderCache<number>(() => 0);
    c.store("k", 7);
    c.clear();
    expect(c.getReusable("k")).toBeUndefined();
  });
  it("distinct keys are independent", () => {
    const c = new ReaderCache<number>(() => 0);
    c.store("a", 1);
    c.store("b", 2);
    expect(c.getReusable("a")).toBe(1);
    expect(c.getReusable("b")).toBe(2);
  });
  it("same-gen entry within REUSE_MAX_AGE_MS is reusable", () => {
    let now = 1_000_000;
    const c = new ReaderCache<number>(() => now);
    c.store("k", 7);
    now += REUSE_MAX_AGE_MS; // exactly at the boundary — inclusive
    expect(c.getReusable("k")).toBe(7);
  });
  it("same-gen entry older than REUSE_MAX_AGE_MS is not reusable", () => {
    let now = 1_000_000;
    const c = new ReaderCache<number>(() => now);
    c.store("k", 7);
    now += REUSE_MAX_AGE_MS + 1;
    expect(c.getReusable("k")).toBeUndefined();
  });
  it("gen mismatch is not reusable even when fresh", () => {
    const c = new ReaderCache<number>(() => 0);
    c.store("k", 7);
    c.bumpGeneration();
    expect(c.getReusable("k")).toBeUndefined();
  });
});
