# Bulk-install robustness: timeout + retry (0.28.0)

Real-vault finding 2026-07-18: a fresh-device bulk "install & enable" of ~55 community
plugins stalled mid-run (progress froze at one item), and the Apply button stayed disabled
through refresh + re-selection; only closing and reopening the Sync Center made it clickable
again, after which it stalled again with no error.

## Diagnosis

Two independent defects:

1. **No timeout on install network fetches.** `applyWithActions` installs items strictly
   sequentially (`ConfigSyncCore.ts:501` loop). Each install calls `installPlugin` →
   `requestUrl` (community catalog, `main.ts:611`) or BRAT's `beta.addPlugin`
   (`main.ts:642`). Obsidian's `requestUrl` has no timeout; a stalled connection never
   resolves or rejects, so the loop freezes on that item forever.
2. **`running` guard has no escape hatch.** The Apply button is disabled while
   `this.running` is true; `running` clears only in the `run()` `finally`, which runs only
   when the run promise settles. Defect 1 makes it never settle → button dead. `running` is
   a per-view-instance field (not session state), so recreating the view resets it — hence
   "close and reopen fixes it, then it stalls again".

Defect 2 is resolved transitively by fixing defect 1: once every item settles (success or
timed-out failure), the run always completes and `running` always clears. No separate
watchdog (YAGNI).

## Design

### New module `src/core/async.ts` (pure, unit-tested)

- `withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T>` — `Promise.race`
  of `work` against a timer that rejects with `new TimeoutError(label, ms)`. `requestUrl`
  can't be aborted, so the underlying request keeps running in the background but is
  detached and harmless.
- `retry<T>(fn: () => Promise<T>, opts: { attempts: number; onAttempt?: (n: number, err: Error) => void; retryable?: (err: Error) => boolean }): Promise<T>` —
  runs `fn`; on failure, if `retryable(err)` (default: always) and attempts remain, calls
  `onAttempt(nextN, err)` and retries; otherwise throws the last error. `attempts` is the
  total tries (3 = 1 + 2 retries).
- `class TimeoutError extends Error` — carries the label; always retryable.
- `class HttpStatusError extends Error` — carries `status`; `retryable` iff status is 0 or
  ≥ 500 (network / server), NOT for 4xx (definitive "not found" — retrying is pointless).

### Community-catalog download (`main.ts` install fetch closure, ~610-613)

Replace the `throw: true` fetch with a timeout+retry wrapper:

- `requestUrl({ url, throw: false })`, inspect `res.status`:
  - 2xx → return `res.arrayBuffer`.
  - 4xx → throw `HttpStatusError(status)` (not retryable → fails fast).
  - else (0 / 5xx) → throw `HttpStatusError(status)` (retryable).
- Wrap the single fetch in `withTimeout(…, 30_000, url)`, and the whole thing in
  `retry(…, { attempts: 3, retryable: isRetryable, onAttempt })`.
- `onAttempt(n, err)` emits an `onPhase` message so the runline shows progress instead of
  silence: `"download timed out — retrying (n/3)…"` (or the error's short reason).

This closure is `HttpGet` for `createInstaller`, so it covers both the one-time catalog
fetch and every per-plugin file download.

### BRAT install (`installViaBrat`, `main.ts:642`)

Wrap `beta.addPlugin(...)` in `withTimeout(…, 30_000, repo)` + `retry(attempts: 3,
onAttempt)`. `addPlugin` re-downloads and rewrites files, so it is idempotent and safe to
retry. A timeout/failure surfaces the existing "BRAT could not install" error, and the
outer `runStateAction` catch turns it into a `⚠ install failed` warning; the batch
continues.

### Behavior

- A stalled or dead plugin now fails after at most `30s × 3 = 90s` and becomes a
  `⚠ install failed` warning; the loop moves to the next item. The run always completes,
  `running` clears, the button re-enables, and the report lists which installs failed.
- Successful installs persist as before; a partial run is resumable by re-applying (only
  the still-missing items remain), unchanged.
- 30s/attempt and 3 attempts are the ceilings — fast networks are unaffected. Retry matches
  the repo rule "idempotent operations: retry with warnings, then raise the last error".

## Non-goals

Concurrent installs (perf, not correctness) stay deferred. No CSS changes.

## Testing

- `tests/async.test.ts`: `retry` succeeds after N-1 failures; throws the last error at the
  cap; skips retry when `retryable` returns false (4xx). `withTimeout` rejects with
  `TimeoutError` when work outlives `ms`; resolves with the value when work settles first.
  Use a controllable deferred + fake timers (no real waiting).
- Live dev-vault sanity: point one install at a 404 (fails fast, batch continues) and at a
  slow/unreachable host (times out, retries with phase messages, then continues). Confirm
  the Apply button re-enables after the run.
- Gates: npm test, lint 67-warning baseline, no hardcoded colors.
