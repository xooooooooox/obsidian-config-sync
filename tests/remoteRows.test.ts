import { describe, it, expect } from "vitest";
import { remoteFlowFor, remoteRowStatuses } from "../src/core/remoteRows";
import { RemoteDiffEntry } from "../src/core/status";

const entry = (group: string, kinds: ("added" | "updated" | "deleted")[]): RemoteDiffEntry => ({
  group,
  files: kinds.map((kind, i) => ({ itemRel: `f${i}.json`, kind, local: null, remote: null })),
});

describe("remoteFlowFor", () => {
  it("reads the whole-store state as one direction for the whole list", () => {
    expect(remoteFlowFor("remote-newer")).toBe("pull");
    expect(remoteFlowFor("remote-older")).toBe("push");
  });

  it("treats every undecided state as pull — the additive one", () => {
    // Pull never removes local files; push mirror-deletes. When the store cannot say which side is
    // ahead, the safe reading is the one that cannot destroy anything.
    expect(remoteFlowFor("same")).toBe("pull");
    expect(remoteFlowFor("unknown")).toBe("pull");
    expect(remoteFlowFor("no-store")).toBe("pull");
  });
});

describe("remoteRowStatuses", () => {
  const local = ["appearance", "hotkeys", "dataview"];

  it("gives a changed item the direction the whole store is in", () => {
    const pull = remoteRowStatuses({ entries: [entry("hotkeys", ["updated"])], flow: "pull", localGroupNames: local });
    expect(pull.find((s) => s.group === "hotkeys")?.state).toBe("store-newer");
    const push = remoteRowStatuses({ entries: [entry("hotkeys", ["updated"])], flow: "push", localGroupNames: local });
    expect(push.find((s) => s.group === "hotkeys")?.state).toBe("local-changed");
  });

  it("folds the file kinds into the same FileChanges shape the device relation uses", () => {
    const [row] = remoteRowStatuses({
      entries: [entry("hotkeys", ["added", "updated", "updated", "deleted"])],
      flow: "pull",
      localGroupNames: local,
    });
    expect(row?.changes).toEqual({ added: ["f0.json"], updated: ["f1.json", "f2.json"], deleted: ["f3.json"] });
  });

  it("calls every local item the comparison did not mention in sync", () => {
    const rows = remoteRowStatuses({ entries: [entry("hotkeys", ["updated"])], flow: "pull", localGroupNames: local });
    expect(rows.filter((s) => s.state === "in-sync").map((s) => s.group).sort()).toEqual(["appearance", "dataview"]);
  });

  it("keeps an entry with no local counterpart — the remote has items this device does not", () => {
    const rows = remoteRowStatuses({ entries: [entry("themes", ["added"])], flow: "pull", localGroupNames: local });
    expect(rows.find((s) => s.group === "themes")?.state).toBe("store-newer");
    expect(rows).toHaveLength(4);
  });

  it("drops the store-metadata pseudo-entry, which is bookkeeping and never an item", () => {
    const rows = remoteRowStatuses({ entries: [entry("", ["updated"])], flow: "pull", localGroupNames: local });
    expect(rows.every((s) => s.group !== "")).toBe(true);
  });

  it("says nothing changed when the comparison found nothing", () => {
    const rows = remoteRowStatuses({ entries: [], flow: "pull", localGroupNames: local });
    expect(rows.every((s) => s.state === "in-sync")).toBe(true);
    expect(rows).toHaveLength(3);
  });
});
