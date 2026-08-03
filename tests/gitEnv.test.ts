import { describe, expect, it } from "vitest";
import { gitEnv, TOKEN_CREDENTIAL_ARGS, stripCredentialArgs } from "../src/external/gitSource";

describe("gitEnv", () => {
  it("appends the helper dirs to PATH on darwin", () => {
    const env = gitEnv({ PATH: "/usr/bin:/bin" }, "darwin", null);
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin");
  });

  it("does not duplicate a dir already on PATH", () => {
    const env = gitEnv({ PATH: "/opt/homebrew/bin:/usr/bin" }, "darwin", null);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/usr/local/bin");
  });

  it("leaves PATH untouched on win32", () => {
    const env = gitEnv({ PATH: "C:\\Windows;C:\\Git\\bin" }, "win32", null);
    expect(env.PATH).toBe("C:\\Windows;C:\\Git\\bin");
  });

  it("builds PATH from the helper dirs alone when the base has none", () => {
    const env = gitEnv({}, "linux", null);
    expect(env.PATH).toBe("/usr/local/bin:/opt/homebrew/bin");
  });

  it("always disables terminal prompts and never mutates the base", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(gitEnv(base, "darwin", null).GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitEnv(base, "win32", null).GIT_TERMINAL_PROMPT).toBe("0");
    expect(base.PATH).toBe("/usr/bin");
    expect(base.GIT_TERMINAL_PROMPT).toBeUndefined();
  });

  it("always tells git-credential-manager to never prompt", () => {
    expect(gitEnv({}, "darwin", null).GCM_INTERACTIVE).toBe("never");
    expect(gitEnv({}, "win32", null).GCM_INTERACTIVE).toBe("never");
  });

  it("exposes both credential fields to the inline helper via the environment only", () => {
    const env = gitEnv({}, "darwin", { username: "xozoz", token: "glpat-abc" });
    expect(env.CONFIG_SYNC_GIT_USER).toBe("xozoz");
    expect(env.CONFIG_SYNC_GIT_TOKEN).toBe("glpat-abc");
  });

  it("leaves both credential fields unset without auth", () => {
    const env = gitEnv({}, "darwin", null);
    expect(env.CONFIG_SYNC_GIT_USER).toBeUndefined();
    expect(env.CONFIG_SYNC_GIT_TOKEN).toBeUndefined();
  });
});

describe("TOKEN_CREDENTIAL_ARGS", () => {
  it("clears the configured helper list, then injects the env-reading helper", () => {
    expect(TOKEN_CREDENTIAL_ARGS).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!f() { printf '%s\\n' \"username=$CONFIG_SYNC_GIT_USER\" \"password=$CONFIG_SYNC_GIT_TOKEN\"; }; f",
    ]);
  });
});

describe("stripCredentialArgs", () => {
  it("removes the injected credential flags from a git error message", () => {
    const raw = `Command failed: git ${TOKEN_CREDENTIAL_ARGS.join(" ")} ls-remote --heads https://h/r.git main\nfatal: Authentication failed`;
    expect(stripCredentialArgs(raw)).toBe(
      "Command failed: git ls-remote --heads https://h/r.git main\nfatal: Authentication failed"
    );
  });

  it("leaves a message that never carried the flags untouched", () => {
    expect(stripCredentialArgs("Command failed: git fetch origin main")).toBe("Command failed: git fetch origin main");
  });
});
