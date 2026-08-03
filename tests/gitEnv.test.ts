import { describe, expect, it } from "vitest";
import { gitEnv } from "../src/external/gitSource";

describe("gitEnv", () => {
  it("appends the helper dirs to PATH on darwin", () => {
    const env = gitEnv({ PATH: "/usr/bin:/bin" }, "darwin");
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin");
  });

  it("does not duplicate a dir already on PATH", () => {
    const env = gitEnv({ PATH: "/opt/homebrew/bin:/usr/bin" }, "darwin");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/usr/local/bin");
  });

  it("leaves PATH untouched on win32", () => {
    const env = gitEnv({ PATH: "C:\\Windows;C:\\Git\\bin" }, "win32");
    expect(env.PATH).toBe("C:\\Windows;C:\\Git\\bin");
  });

  it("builds PATH from the helper dirs alone when the base has none", () => {
    const env = gitEnv({}, "linux");
    expect(env.PATH).toBe("/usr/local/bin:/opt/homebrew/bin");
  });

  it("always disables terminal prompts and never mutates the base", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(gitEnv(base, "darwin").GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitEnv(base, "win32").GIT_TERMINAL_PROMPT).toBe("0");
    expect(base.PATH).toBe("/usr/bin");
    expect(base.GIT_TERMINAL_PROMPT).toBeUndefined();
  });
});
