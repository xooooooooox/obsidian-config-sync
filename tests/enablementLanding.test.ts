import { describe, expect, it } from "vitest";
import { SyncCenterView } from "../src/ui/SyncCenterView";
import { ConfigSyncSettingTab } from "../src/ui/SettingTab";
import { EVERYWHERE, perClass, Sharing, THIS_DEVICE } from "../src/core/types";

// Spec §6.5 case 3 + §6.6: landing the FLEET segment on `Each device decides` while this device has
// no exception yet must seed one from the element's real current state (host.leaveToThisDevice),
// and BOTH entrances must do it — the settings card's cycle and the Sync Center's rule menu.
//
// This drives the two production methods directly (bracket access past `private`, the same pattern
// tests/settingtab-commit.test.ts and tests/emptyVerbDegradation.test.ts already use) rather than
// the pure predicate they share: the predicate was already right in the abstract, and the defect
// this closes was a caller that never asked it. The two are asserted with the SAME table, so a
// change to one entrance that is not made to the other fails here.

const LIST = "community-plugins";
const ELEMENT = "remotely-save";

interface Calls {
  rules: Sharing[];
  seeded: number;
  followed: number;
}

function stubHost(exception: "on" | "off" | null): { host: Record<string, unknown>; calls: Calls } {
  const calls: Calls = { rules: [], seeded: 0, followed: 0 };
  return {
    calls,
    host: {
      // Enough of both host surfaces for the landing path; nothing here renders.
      enablementRuleFor: () => EVERYWHERE,
      setEnablementRule: async (_l: string, _e: string, s: Sharing) => {
        calls.rules.push(s);
      },
      deviceElementFor: () => exception,
      leaveToThisDevice: async () => {
        calls.seeded += 1;
      },
      followTheDefault: async () => {
        calls.followed += 1;
      },
      setDeviceElement: async () => {},
      itemRefForGroup: () => null,
      deviceOptedOut: () => false,
      companionParentOf: () => null,
      notifyExternalChange: () => {},
    },
  };
}

type Landing = (list: string, elementId: string, rule: Sharing) => Promise<void>;

// The two production entrances, named by the surface a user would be looking at.
const entrances: { name: string; build: (host: Record<string, unknown>) => Landing }[] = [
  {
    name: "the Sync Center's rule menu",
    build: (host) => {
      const view = new SyncCenterView({} as never, host as never) as unknown as { setRuleWithLanding: Landing };
      return (l, e, r) => view.setRuleWithLanding(l, e, r);
    },
  },
  {
    name: "the settings card's fleet cycle",
    build: (host) => {
      const tab = new ConfigSyncSettingTab({} as never, host as never) as unknown as { setRuleWithLanding: Landing };
      return (l, e, r) => tab.setRuleWithLanding(l, e, r);
    },
  },
];

describe.each(entrances)("$name — landing on Each device decides", ({ build }) => {
  it("writes the rule and seeds the exception from the element's real state", async () => {
    const { host, calls } = stubHost(null);
    await build(host)(LIST, ELEMENT, THIS_DEVICE);
    expect(calls.rules).toEqual([THIS_DEVICE]);
    expect(calls.seeded).toBe(1); // …so the local segment shows On here / Off here, never a default that isn't there
  });

  it("never overwrites an exception this device already has", async () => {
    for (const existing of ["on", "off"] as const) {
      const { host, calls } = stubHost(existing);
      await build(host)(LIST, ELEMENT, THIS_DEVICE);
      expect(calls.rules).toEqual([THIS_DEVICE]);
      expect(calls.seeded).toBe(0);
    }
  });

  it("leaves every other rule value alone — they have a default to follow, so nothing is frozen", async () => {
    for (const rule of [EVERYWHERE, perClass("desktop"), perClass("mobile")]) {
      const { host, calls } = stubHost(null);
      await build(host)(LIST, ELEMENT, rule);
      expect(calls.rules).toEqual([rule]);
      expect(calls.seeded).toBe(0);
      expect(calls.followed).toBe(0); // the fleet write never touches the local layer
    }
  });
});
