import { describe, expect, it } from "vitest";
import {
  placeRow,
  pillCounts,
  PILL_FATE_FOLD,
  FATE_PILL_FOLD,
  FATE_FOLD_ORDER,
  AVAILABILITY_FOLD_ORDER,
  FATE_FOLD_YIELDS_TO_AVAILABILITY,
  type FateFold,
} from "../src/ui/panelTaxonomy";
import { partitionSection, type PanelFilter, type RowBucket, type SectionKind } from "../src/ui/panelModel";
import { AVAILABILITY_FOLD_TEXT, type AvailabilityFoldKind } from "../src/ui/foldIcons";

// The panel's containment rules, pinned. Three surfaces have to agree about where a row lives: the
// filter pill that COUNTS it, the section that HOLDS it, the fold that FILES it. With nothing
// forcing agreement they drift, and a row the user opted this device out of gets counted by
// `Not synced here` while filed under `N not installed on this device`, so clicking the pill's
// number leads to a list with none of those words in it. These tests are the mechanism that keeps
// the three together, so they assert the WHOLE table, not the one case.

const BUCKETS: RowBucket[] = ["conflict", "apply", "capture", "locked", "ok", "excluded", "none"];
const AVAILABILITIES: SectionKind[] = ["main", "outdated", "disabled", "not-installed", "desktop-only"];
// The device relation's answer. `locked` folds only under a remote (see the block at the bottom),
// so every table below states the device placement and the remote one is asserted separately —
// a shared default would hide which relation each row is about.
const DEVICE = { foldLocked: false };

describe("placeRow — the full (fate × availability) table", () => {
  it("is total: every combination has exactly one home", () => {
    for (const bucket of BUCKETS) {
      for (const availability of AVAILABILITIES) {
        const at = placeRow(bucket, availability, DEVICE);
        expect(at.zone, `${bucket} × ${availability}`).toMatch(/^(active|fate|availability)$/);
        if (at.zone === "fate") expect(FATE_FOLD_ORDER).toContain(at.fold);
        if (at.zone === "availability") expect(AVAILABILITY_FOLD_ORDER).toContain(at.fold);
      }
    }
  });

  // Work stays where the work is: a plugin this run would install belongs at the top of its
  // section wearing its `not installed here` chip, never folded away behind the very fact that
  // makes it interesting.
  it("keeps every actionable bucket active, whatever this device can or can't do", () => {
    for (const bucket of ["conflict", "apply", "capture", "locked"] as const) {
      for (const availability of AVAILABILITIES) {
        expect(placeRow(bucket, availability, DEVICE), `${bucket} × ${availability}`).toEqual({ zone: "active" });
      }
    }
  });

  it("files an available non-active row by its own fate", () => {
    expect(placeRow("ok", "main", DEVICE)).toEqual({ zone: "fate", fold: "insync" });
    expect(placeRow("excluded", "main", DEVICE)).toEqual({ zone: "fate", fold: "excluded" });
    expect(placeRow("none", "main", DEVICE)).toEqual({ zone: "fate", fold: "nosettings" });
  });

  // "Nothing to do" yields to the fold that explains WHY there is nothing to do — that is what the
  // availability folds are for, notes and all.
  it("hands in-sync and no-settings rows to the availability fold when this device can't act", () => {
    for (const availability of AVAILABILITY_FOLD_ORDER) {
      expect(placeRow("ok", availability, DEVICE)).toEqual({ zone: "availability", fold: availability });
      expect(placeRow("none", availability, DEVICE)).toEqual({ zone: "availability", fold: availability });
    }
  });

  // THE REGRESSION. `excluded` is the user's own decision about this device, not a fact about the
  // machine, and the person looking for it searches with the words the pill used.
  it("never lets availability swallow a row the user opted this device out of", () => {
    for (const availability of AVAILABILITY_FOLD_ORDER) {
      expect(placeRow("excluded", availability, DEVICE), `excluded × ${availability}`).toEqual({
        zone: "fate",
        fold: "excluded",
      });
    }
  });

  it("derives its fate half from partitionSection, never a second copy of the bucket vocabulary", () => {
    for (const bucket of BUCKETS) {
      const at = placeRow(bucket, "main", DEVICE);
      const expected = partitionSection(bucket);
      expect(at.zone === "active" ? "active" : at.zone === "fate" ? at.fold : null).toBe(expected);
    }
  });
});

// The property that actually broke: a fold-owning pill's number and the fold that speaks its words
// must describe the SAME rows. Stated over the whole table rather than over one example, so a
// future change to FATE_FOLD_YIELDS_TO_AVAILABILITY has to come here and say so out loud.
describe("pill ⇄ fold agreement", () => {
  const foldPills = Object.entries(PILL_FATE_FOLD) as [PanelFilter, FateFold][];

  it("gives every fold-owning pill a fold whose rows it counts", () => {
    for (const [pill, fold] of foldPills) {
      for (const availability of AVAILABILITIES) {
        // The fold a bucket lands in, asked of the placement rather than of partitionSection: the
        // `Can't compare` pill's fold exists only under a remote, and partitionSection is the
        // device relation's vocabulary alone.
        const foldOf = (b: RowBucket): FateFold | null => {
          const at = placeRow(b, "main", { foldLocked: true });
          return at.zone === "fate" ? at.fold : null;
        };
        const bucket = BUCKETS.find((b) => pillCounts(b, pill) && foldOf(b) === fold);
        expect(bucket, `no bucket for pill ${pill}`).toBeDefined();
        if (bucket === undefined) continue;
        const at = placeRow(bucket, availability, { foldLocked: true });
        // Either the pill's own fold holds it, or the taxonomy declared this fold yields — there is
        // no third outcome, and no silent one.
        if (at.zone === "fate") expect(at.fold).toBe(fold);
        else expect(FATE_FOLD_YIELDS_TO_AVAILABILITY[fold], `${pill} × ${availability} vanished`).toBe(true);
      }
    }
  });

  // A yielding fold is only acceptable because the fold it yields TO names the row in words of its
  // own. A fold with no text would be a hole.
  it("only yields to availability folds that have their own label", () => {
    for (const fold of FATE_FOLD_ORDER) {
      if (!FATE_FOLD_YIELDS_TO_AVAILABILITY[fold]) continue;
      for (const availability of AVAILABILITY_FOLD_ORDER) {
        expect(AVAILABILITY_FOLD_TEXT[availability](1).length).toBeGreaterThan(0);
      }
    }
  });

  it("counts a Not-synced-here row under exactly one pill", () => {
    const pills: PanelFilter[] = ["capture", "apply", "ok", "excluded", "none"];
    expect(pills.filter((p) => pillCounts("excluded", p))).toEqual(["excluded"]);
  });

  it("counts an unreadable row under the Can't compare pill and no other", () => {
    const pills: PanelFilter[] = ["capture", "apply", "ok", "excluded", "none", "locked"];
    expect(pills.filter((p) => pillCounts("locked", p))).toEqual(["locked"]);
  });
});

// The one thing the two relations answer differently. Under a remote an item nobody can open is not
// work — it folds; under the device relation it keeps the place it has always had, in the list.
describe("placeRow — Can't compare folds under a remote only", () => {
  it("folds an unreadable row away under a remote", () => {
    for (const availability of AVAILABILITIES) {
      expect(placeRow("locked", availability, { foldLocked: true })).toEqual({ zone: "fate", fold: "locked" });
    }
  });

  it("leaves the device relation's placement untouched", () => {
    for (const availability of AVAILABILITIES) {
      expect(placeRow("locked", availability, DEVICE)).toEqual({ zone: "active" });
    }
  });

  it("moves no other bucket when the fold is switched on", () => {
    for (const bucket of BUCKETS.filter((b) => b !== "locked")) {
      for (const availability of AVAILABILITIES) {
        expect(placeRow(bucket, availability, { foldLocked: true })).toEqual(placeRow(bucket, availability, DEVICE));
      }
    }
  });
});

describe("FATE_PILL_FOLD — one glyph per state across every surface", () => {
  // The header strip, the sidebar badges, the compact switcher, the fold lines and the card all
  // resolve their mark through this map; hand-written `✓`/`⊘`/`○` text is what let them disagree.
  it("maps each fate pill to the fold whose icon it must wear", () => {
    expect(FATE_PILL_FOLD).toEqual({ ok: "insync", excluded: "excluded", none: "nosettings", locked: "locked" });
  });

  it("agrees with partitionSection, so the badge and the fold can never name different states", () => {
    for (const bucket of ["ok", "excluded", "none"] as const) {
      expect(FATE_PILL_FOLD[bucket]).toBe(partitionSection(bucket));
    }
  });
});

describe("fold render order", () => {
  it("puts fate before availability — what happens, then why it can't", () => {
    expect(FATE_FOLD_ORDER).toEqual(["insync", "excluded", "nosettings", "locked"]);
    expect(AVAILABILITY_FOLD_ORDER).toEqual(["outdated", "disabled", "not-installed", "desktop-only"] as AvailabilityFoldKind[]);
  });
});
