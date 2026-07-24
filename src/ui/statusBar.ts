import { setIcon } from "obsidian";

// The status-bar item's content model. Same sources and color semantics as the Sync Center
// header pills: ↑ to capture, ↓ to apply, ⇡ push / ⇣ pull are per-remote direction counts.
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

export function statusBarAriaLabel(segments: StatusBarSegment[]): string {
  if (segments.length === 0) return "Config Sync — all in sync";
  const phrase = (s: StatusBarSegment): string =>
    s.kind === "up" ? `${s.count} to capture` : s.kind === "down" ? `${s.count} to apply` : `${s.kind} ${s.count}`;
  return `Config Sync — ${segments.map(phrase).join(" · ")}`;
}

// Thin DOM shell: rebuilds the item in place. Not unit-tested (repo policy: vitest covers pure
// logic only; DOM is stubbed) — verified via the dev-vault smoke.
export function renderStatusBarItem(el: HTMLElement, segments: StatusBarSegment[]): void {
  el.empty();
  el.toggleClass("is-clean", segments.length === 0);
  setIcon(el.createSpan({ cls: "config-sync-sb-icon" }), "refresh-cw");
  for (const s of segments) el.createSpan({ cls: `config-sync-sb-seg is-${s.kind}`, text: s.text });
  el.setAttribute("aria-label", statusBarAriaLabel(segments));
}
