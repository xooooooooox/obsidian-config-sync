import { describe, it, expect } from "vitest";
import { directionFlows, intersectDirection, RemoteDirection } from "../src/core/types";

describe("directionFlows", () => {
  it("maps each of the four positions to the two flags", () => {
    expect(directionFlows("both")).toEqual({ push: true, pull: true });
    expect(directionFlows("push")).toEqual({ push: true, pull: false });
    expect(directionFlows("pull")).toEqual({ push: false, pull: true });
    expect(directionFlows("none")).toEqual({ push: false, pull: false });
  });
});

describe("intersectDirection", () => {
  it("is the intersection of the two direction SETS, not a max/min on an order", () => {
    // push and pull are incomparable: their intersection is empty, not one of them
    expect(intersectDirection("push", "pull")).toBe("none");
    expect(intersectDirection("pull", "push")).toBe("none");
  });

  it("lets an item widen nothing and a key narrow anything", () => {
    expect(intersectDirection("both", "pull")).toBe("pull");
    expect(intersectDirection("pull", "both")).toBe("pull");
    expect(intersectDirection("none", "both")).toBe("none");
    expect(intersectDirection("push", "push")).toBe("push");
  });

  it("is commutative for every pair", () => {
    const all: RemoteDirection[] = ["both", "push", "pull", "none"];
    for (const a of all) {
      for (const b of all) {
        expect(intersectDirection(a, b)).toBe(intersectDirection(b, a));
      }
    }
  });
});
