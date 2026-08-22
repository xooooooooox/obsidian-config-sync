import { describe, expect, it } from "vitest";
import { resolveGitToken } from "../src/external/gitToken";
import { Remote } from "../src/core/types";

const store = (secrets: Record<string, string>) => ({
  getSecret: (id: string): string | null => (id in secrets ? secrets[id]! : null),
});

const gitRemote = (tokenId?: string, username?: string): Remote => {
  const r: Remote = { name: "kickstart", type: "git", url: "https://h/r.git", branch: "main" };
  if (tokenId !== undefined) r.tokenId = tokenId;
  if (username !== undefined) r.username = username;
  return r;
};

describe("resolveGitToken", () => {
  it("returns null for a vault remote", () => {
    expect(resolveGitToken(store({}), { name: "v", type: "vault", storePath: "/s" })).toBeNull();
  });

  it("returns null for a git remote without a token", () => {
    expect(resolveGitToken(store({}), gitRemote())).toBeNull();
  });

  it("returns the token held under the linked secret name, defaulting the username", () => {
    expect(resolveGitToken(store({ "gitlab-xozoz": "glpat-x" }), gitRemote("gitlab-xozoz"))).toEqual({
      username: "token",
      token: "glpat-x",
    });
  });

  it("sends the remote's own username when it has one", () => {
    expect(resolveGitToken(store({ "gitlab-xozoz": "glpat-x" }), gitRemote("gitlab-xozoz", "xozoz"))).toEqual({
      username: "xozoz",
      token: "glpat-x",
    });
  });

  it("throws the actionable copy when this device never linked that secret", () => {
    expect(() => resolveGitToken(store({}), gitRemote("gitlab-xozoz"))).toThrow(
      'No access token stored on this device for remote "kickstart". Link it once in Settings → Remotes.'
    );
  });

  it("treats an emptied secret as absent (the keychain has no delete)", () => {
    expect(() => resolveGitToken(store({ "gitlab-xozoz": "" }), gitRemote("gitlab-xozoz"))).toThrow(
      "No access token stored on this device"
    );
  });

  it("rejects a secret with an embedded newline that could forge credential-protocol lines", () => {
    expect(() =>
      resolveGitToken(store({ "gitlab-xozoz": "tok\nusername=EVIL" }), gitRemote("gitlab-xozoz"))
    ).toThrow('The access token linked to remote "kickstart" has a line break or surrounding whitespace');
  });

  it("rejects a secret with trailing whitespace", () => {
    expect(() => resolveGitToken(store({ "gitlab-xozoz": "glpat-x " }), gitRemote("gitlab-xozoz"))).toThrow(
      'The access token linked to remote "kickstart" has a line break or surrounding whitespace'
    );
  });
});
