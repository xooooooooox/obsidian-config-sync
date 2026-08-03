export type RemoteFailureKind = "no-token" | "auth" | "timeout" | "other";

const AUTH_PATTERNS = [/could not read username/i, /authentication failed/i, /permission denied/i, /credential/i];

// Pure classification of a remote-compare failure message. "no-token" is our own refusal before
// git runs at all; "timeout" keys on the marker the git runner appends when it kills a stalled
// child; "auth" on the common git/ssh phrasings.
export function classifyRemoteFailure(message: string): RemoteFailureKind {
  if (/no access token stored on this device/i.test(message)) return "no-token";
  if (message.includes("timed out after")) return "timeout";
  if (AUTH_PATTERNS.some((p) => p.test(message))) return "auth";
  return "other";
}
