import { describe, it, expect } from "vitest";
import { mergeDisclosure } from "../src/core/merge";
import { SyncGroup } from "../src/core/types";

const group = (name: string): SyncGroup => ({ name, path: `p/${name}`, type: "file", devices: "all" });

describe("mergeDisclosure", () => {
  it("counts files and real writes; definition identicals and kept definitions never enter", () => {
    const d = mergeDisclosure({
      addGroups: [group("iconize")],
      writeFiles: [{ rel: "configdir/plugins/iconize/data.json", content: "{}", name: "iconize" }],
      keptLocalGroups: ["local-only-rule"],
      keptLocalFiles: ["configdir/plugins/old/data.json"],
      identical: ["group:hotkeys", "group:dataview", "file:configdir/app.json"],
    });
    expect(d.add).toBe(2);
    expect(d.identicalFiles).toEqual(["file:configdir/app.json"]);
    expect(d.keptFiles).toEqual(["configdir/plugins/old/data.json"]);
    expect(d.count).toBe(4);
  });

  it("reports zero when the merge is definitions all the way down — the modal then hides its box", () => {
    const d = mergeDisclosure({ addGroups: [], writeFiles: [], keptLocalGroups: ["a", "b"], keptLocalFiles: [], identical: ["group:a", "group:b"] });
    expect(d.count).toBe(0);
  });
});
