import { describe, expect, it } from "vitest";
import { renderSharingCycle } from "../src/ui/sharingCycle";
import { ruleIcon, ruleLabel, RULE_OPTIONS } from "../src/ui/enablementRow";
import { FIELD_SHARING_OPTIONS, sharingCycleTooltip, sharingIcon } from "../src/ui/itemCard";
import { EVERYWHERE, perClass, Sharing, THIS_DEVICE } from "../src/core/types";

// renderSharingCycle now serves TWO vocabularies over the same `Sharing` union — "where a file
// syncs" (five call sites, unchanged) and "which devices turn a plugin on" (the enablement row,
// spec §6.1/§7). The vocabulary is a parameter rather than a second copy of the control, so what
// needs proving is that the hooks are actually consulted AND that omitting them leaves the old
// shape byte-identical.
//
// There is no DOM in this suite (vitest runs on node, `obsidian` is aliased to a stub), so the
// element is a minimal stand-in carrying exactly the surface the renderer touches. The icon name is
// observable because tests/mock-obsidian.ts's setIcon records it onto the element.

interface FakeEl {
  cls: string;
  text: string;
  iconName?: string;
  attrs: Record<string, string>;
  classes: string[];
  children: FakeEl[];
  handlers: Record<string, ((e: unknown) => void)[]>;
  createSpan(o?: { cls?: string; text?: string }): FakeEl;
  setAttribute(k: string, v: string): void;
  addClass(c: string): void;
  addEventListener(k: string, fn: (e: unknown) => void): void;
}

function el(cls = "", text = ""): FakeEl {
  const node: FakeEl = {
    cls,
    text,
    attrs: {},
    classes: [],
    children: [],
    handlers: {},
    createSpan(o) {
      const child = el(o?.cls ?? "", o?.text ?? "");
      node.children.push(child);
      return child;
    },
    setAttribute(k, v) {
      node.attrs[k] = v;
    },
    addClass(c) {
      node.classes.push(c);
    },
    addEventListener(k, fn) {
      (node.handlers[k] ??= []).push(fn);
    },
  };
  return node;
}

function render(opts: Parameters<typeof renderSharingCycle>[1]): FakeEl {
  const cell = el();
  renderSharingCycle(cell as unknown as HTMLElement, opts);
  const trigger = cell.children[0];
  if (trigger === undefined) throw new Error("renderSharingCycle rendered nothing");
  return trigger;
}

const noop = (): void => {};

describe("renderSharingCycle — the file-sharing vocabulary is still the default", () => {
  // The regression guard for the five call sites that pass no hooks: same glyph, same tooltip, and
  // no visible label. If this changes, those five changed with it.
  it("uses sharingIcon and sharingCycleTooltip, and renders no text label", () => {
    for (const sharing of FIELD_SHARING_OPTIONS) {
      const trigger = render({ sharing, options: FIELD_SHARING_OPTIONS, disabled: false, onChange: noop });
      expect(trigger.iconName).toBe(sharingIcon(sharing));
      expect(trigger.attrs["aria-label"]).toBe(sharingCycleTooltip(sharing));
      expect(trigger.children).toEqual([]);
    }
  });

  it("still appends the note to the tooltip", () => {
    const trigger = render({ sharing: EVERYWHERE, options: FIELD_SHARING_OPTIONS, disabled: false, note: "a note", onChange: noop });
    expect(trigger.attrs["aria-label"]).toBe(sharingCycleTooltip(EVERYWHERE, "a note"));
  });
});

describe("renderSharingCycle — the enablement vocabulary reaches the settings card", () => {
  // Spec §7: `airplay` is reserved, and the fourth rule value is `Each device decides`, not "This
  // device". Producer-vs-producer — asserted against ruleIcon/ruleLabel, never a re-typed literal.
  it("takes its glyph from iconFor, so this-device renders users and never airplay", () => {
    for (const rule of RULE_OPTIONS) {
      const trigger = render({ sharing: rule, options: RULE_OPTIONS, disabled: false, iconFor: ruleIcon, labelFor: ruleLabel, onChange: noop });
      expect(trigger.iconName).toBe(ruleIcon(rule));
    }
    const thisDevice = render({ sharing: THIS_DEVICE, options: RULE_OPTIONS, disabled: false, iconFor: ruleIcon, labelFor: ruleLabel, onChange: noop });
    expect(thisDevice.iconName).toBe("users");
    expect(thisDevice.iconName).not.toBe(sharingIcon(THIS_DEVICE)); // "airplay" — the whole point of the hook
  });

  // §6.1: the fleet segment is icon + text. The icon-only shape is what the file-sharing cells keep.
  it("renders a visible label from labelFor", () => {
    const trigger = render({ sharing: THIS_DEVICE, options: RULE_OPTIONS, disabled: false, iconFor: ruleIcon, labelFor: ruleLabel, onChange: noop });
    expect(trigger.children.map((c) => c.text)).toEqual(["Each device decides"]);
  });

  // Round-9 ②: the two-segment row's fleet cell drops labelFor (icon-only) and instead opts into
  // the shared `▾` affordance every clickable segment carries — a separate hook from labelFor so
  // the plain file-sharing cells (which pass neither) stay byte-identical.
  it("chevron appends the shared ▾ affordance, off by default", () => {
    const bare = render({ sharing: THIS_DEVICE, options: RULE_OPTIONS, disabled: false, iconFor: ruleIcon, onChange: noop });
    expect(bare.children).toEqual([]);
    const withChevron = render({ sharing: THIS_DEVICE, options: RULE_OPTIONS, disabled: false, iconFor: ruleIcon, chevron: true, onChange: noop });
    expect(withChevron.children.map((c) => ({ cls: c.cls, text: c.text }))).toEqual([{ cls: "config-sync-tworow-chev", text: "▾" }]);
  });

  it("uses ariaLabel verbatim instead of the file-sharing tooltip", () => {
    const trigger = render({ sharing: THIS_DEVICE, options: RULE_OPTIONS, disabled: false, ariaLabel: "Which devices turn this plugin on — Each device decides", onChange: noop });
    expect(trigger.attrs["aria-label"]).toBe("Which devices turn this plugin on — Each device decides");
    expect(trigger.attrs["aria-label"]).not.toContain("Where it syncs");
  });

  it("still advances through the options it was given", () => {
    let landed: Sharing | null = null;
    const trigger = render({
      sharing: perClass("mobile"),
      options: RULE_OPTIONS,
      disabled: false,
      iconFor: ruleIcon,
      labelFor: ruleLabel,
      onChange: (v) => {
        landed = v;
      },
    });
    trigger.handlers["click"]?.[0]?.({});
    expect(landed).toEqual(THIS_DEVICE);
  });
});
