import { describe, expect, it } from "vitest";
import { classifyRemoteFailure } from "../src/core/remoteFailure";

describe("classifyRemoteFailure", () => {
  it("classifies a missing token from resolveGitToken as no-token", () => {
    expect(
      classifyRemoteFailure(
        'No access token stored on this device for remote "my-repo" — link it once in Settings → Remotes.'
      )
    ).toBe("no-token");
  });
  it("classifies a credential prompt failure as auth", () => {
    expect(
      classifyRemoteFailure(
        "git fetch config-sync-import main failed in /v: fatal: could not read Username for 'https://git.example.com'"
      )
    ).toBe("auth");
  });
  it("classifies a broken credential helper as auth", () => {
    expect(classifyRemoteFailure("git: 'credential-manager' is not a git command. See 'git --help'.")).toBe("auth");
  });
  it("classifies ssh key rejection as auth", () => {
    expect(classifyRemoteFailure("Permission denied (publickey).")).toBe("auth");
  });
  it("classifies the runner's timeout marker as timeout", () => {
    expect(classifyRemoteFailure("git fetch config-sync-import main failed in /v: timed out after 60s")).toBe("timeout");
  });
  it("classifies anything else as other", () => {
    expect(classifyRemoteFailure("ENOENT: no such file or directory, scandir '/v/store'")).toBe("other");
  });
});
