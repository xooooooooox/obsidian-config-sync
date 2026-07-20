# Fix: Apply/Capture button state desyncs from a running batch

## Bug

During a long batch (real repro: "Apply 72 items" installing not-installed
plugins), the button flips from "Applying…" back to "↓ Apply N items" **greyed
out** while the run is still going (a manual ↻ shows N shrinking). Root cause:
`renderActionBar` (`src/ui/SyncCenterView.ts`) builds the button from the current
staged count + `this.running` (disabled) — it has no notion of the in-flight
progress, which `run()` pushes onto the button imperatively via `onProgress`
(`btn.setButtonText("Applying done/total…")`). Any re-render during the run
replaces the live progress button with a fresh "Apply N items" (disabled) one, and
progress updates then land on the detached old button.

Re-renders fire mid-run from: **reactive** triggers — installing/enabling 72
plugins raises `active-leaf-change` and `refreshLocalStatus → notifySyncCenter →
notifyExternalChange`, each calling `reload()`; and **manual** — the ↻ button.

## Fix (A + B)

### A. Suppress reactive re-renders while running

A run's UI (button label, progress bar, runline) is updated imperatively; a
reactive rebuild in the middle only destroys it. While `this.running`, skip the
reactive re-render paths in `src/ui/SyncCenterView.ts`:

- `notifyExternalChange()`: `if (this.running) return;` before `void this.reload();`.
- the `active-leaf-change` handler: `if (leaf === this.leaf && !this.running) void this.reload();`.
- `evaluateCompact()`: still track the width (`this.compact = compact`) but only
  `this.render(...)` when `!this.running`.

`run()`'s `finally` already calls `reload()` after the run, so the panel refreshes
to its true idle state once the batch finishes. This removes the mid-apply rebuild
(the automatic desync) and the churn from config-sync's own writes.

### B. Render the running state (survives any rebuild)

So that a rebuild that *does* happen (e.g. the user hits ↻) still shows the correct
button rather than "Apply N items", make the action bar render-derived from the
in-flight progress:

- New field `private activeRun: { verb: "Capturing" | "Applying"; done: number; total: number } | null = null;`.
- New pure helper in `src/ui/panelModel.ts`:
  ```ts
  export function runProgressLabel(verb: "Capturing" | "Applying", done: number, total: number): string {
    return `${verb === "Capturing" ? "↑" : "↓"} ${verb} ${done}/${total}…`;
  }
  ```
- `run()`: set `this.activeRun = { verb, done: 0, total: payload.length }` at the
  start; in `onProgress` set `this.activeRun = { verb, done, total }` and
  `btn.setButtonText(runProgressLabel(verb, done, total))` (replacing the current
  `` `${verb} ${done}/${total}…` `` — now arrow-prefixed for consistency); in the
  `finally`, `this.activeRun = null`.
- `renderActionBar`: when building each button, if `this.activeRun` matches that
  button's verb (`"Capturing"` → capture button, `"Applying"` → apply button), set
  its text to `runProgressLabel(this.activeRun.verb, done, total)` and add the
  `is-busy` class, instead of the idle "↑ Capture N items" / "↓ Apply N items". Both
  buttons stay disabled via the existing `this.running || …` check.

With A the common case never rebuilds (bar + runline stay live); with B any rebuild
that slips through still shows the live progress on the button, so the state can no
longer desync to "Apply N items".

## Testing

- **`tests/panelModel.test.ts`** — `runProgressLabel`: `("Applying", 5, 72)` →
  `"↓ Applying 5/72…"`; `("Capturing", 0, 3)` → `"↑ Capturing 0/3…"`.
- Gates: `npm test`, `npx eslint .` 0/67, no hardcoded colors, `npm run build` clean.
- Live (dev vault): start a multi-item apply, then trigger a `reload()` mid-run
  (call the view's ↻ / `notifyExternalChange` via `obsidian-cli eval`) and assert
  the apply button text stays `↓ Applying done/total…` (not `↓ Apply N items`) and
  disabled; after the run, the footer returns to idle.

## Non-goals

- No change to the apply/capture core logic, the progress bar shimmer, or the
  runline. Purely the view's re-render gating + button state derivation.
- The progress bar fill and runline are not made fully render-derived (they reset on
  a rare mid-run rebuild); the button — the primary indicator — carries the state.
