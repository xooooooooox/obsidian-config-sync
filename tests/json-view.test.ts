import { describe, expect, it } from "vitest";
import { classifyJsonKeys } from "../src/ui/jsonView";

describe("classifyJsonKeys", () => {
  it("labels each top-level key by rule/detection state", () => {
    const raw = JSON.stringify({ apiKey: "x", customEndpoint: "y", theme: "dark" });
    const out = classifyJsonKeys(raw, [{ pattern: "apiKey", action: "encrypt" }], ["apiKey", "customEndpoint"]);
    expect(out.find((k) => k.key === "apiKey")?.state).toBe("encrypt");
    expect(out.find((k) => k.key === "customEndpoint")?.state).toBe("detected");
    expect(out.find((k) => k.key === "theme")?.state).toBe("none");
  });
});
