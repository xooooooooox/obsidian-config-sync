import { setIcon } from "obsidian";

// The status-bar item's content model. Same sources and color semantics as the Sync Center
// header pills, and since 2.25.0 the same UNIT throughout: ↑ to capture, ↓ to apply, ⇡ to push,
// ⇣ to pull — all four are counts of ITEMS. How many remotes the last two are spread across is a
// different fact, and it lives in the hover (statusBarAriaLabel's `span`).
export type StatusBarSegmentKind = "up" | "down" | "push" | "pull";

export interface StatusBarSegment {
  kind: StatusBarSegmentKind;
  count: number;
  text: string;
}

const GLYPH: Record<StatusBarSegmentKind, string> = { up: "↑", down: "↓", push: "⇡", pull: "⇣" };

// Zero-count segments are hidden; push/pull additionally require the remote sub-toggle.
export function statusBarSegments(
  counts: { up: number; down: number },
  remote: { push: number; pull: number },
  showRemote: boolean
): StatusBarSegment[] {
  const seg = (kind: StatusBarSegmentKind, count: number): StatusBarSegment => ({ kind, count, text: `${GLYPH[kind]}${count}` });
  const out: StatusBarSegment[] = [];
  if (counts.up > 0) out.push(seg("up", counts.up));
  if (counts.down > 0) out.push(seg("down", counts.down));
  if (showRemote && remote.push > 0) out.push(seg("push", remote.push));
  if (showRemote && remote.pull > 0) out.push(seg("pull", remote.pull));
  return out;
}

// `span` describes what the push/pull NUMBERS are spread across. Those numbers are ITEMS (spec 5.5:
// one unit on this line, never "items" beside "remotes"), and an item count says nothing about how
// many remotes are involved — so that goes here, where a hover can carry it. A remote nobody could
// count is named rather than dropped: silence would read as "nothing waiting there".
export function statusBarAriaLabel(segments: StatusBarSegment[], span: { remotes: number; uncounted: number }): string {
  if (segments.length === 0 && span.uncounted === 0) return "Config Sync: all in sync";
  const phrase = (s: StatusBarSegment): string =>
    s.kind === "up"
      ? `${s.count} to capture`
      : s.kind === "down"
        ? `${s.count} to apply`
        : s.kind === "push"
          ? `${s.count} to push`
          : `${s.count} to pull`;
  const parts = segments.map(phrase);
  // `across N remotes` continues the remote phrase it qualifies ("4 to push across 2 remotes"), so
  // it joins the last part rather than becoming a segment of its own — a `·` there would read as a third
  // count. push/pull always sort last (statusBarSegments), so the last part IS that phrase.
  const remoteShowing = segments.some((s) => s.kind === "push" || s.kind === "pull");
  if (remoteShowing && span.remotes > 0 && parts.length > 0) {
    parts[parts.length - 1] = `${parts[parts.length - 1]} across ${span.remotes} remote${span.remotes === 1 ? "" : "s"}`;
  }
  if (span.uncounted > 0) parts.push(`${span.uncounted} remote${span.uncounted === 1 ? "" : "s"} can't be counted yet`);
  return `Config Sync: ${parts.join(" · ")}`;
}

// Thin DOM shell: rebuilds the item in place. Not unit-tested (repo policy: vitest covers pure
// logic only; DOM is stubbed) — verified via the dev-vault smoke.
export function renderStatusBarItem(el: HTMLElement, segments: StatusBarSegment[], span: { remotes: number; uncounted: number }): void {
  el.empty();
  el.toggleClass("is-clean", segments.length === 0);
  setIcon(el.createSpan({ cls: "config-sync-sb-icon" }), "refresh-cw");
  for (const s of segments) el.createSpan({ cls: `config-sync-sb-seg is-${s.kind}`, text: s.text });
  el.setAttribute("aria-label", statusBarAriaLabel(segments, span));
}
