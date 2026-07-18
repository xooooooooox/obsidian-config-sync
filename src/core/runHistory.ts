import { GroupResult, hasChanges } from "./types";

export type RunKind = "capture" | "apply" | "pull" | "push" | "adopt";
export type RunStatus = "ok" | "warning" | "error";

export interface RunRecord {
  at: number; // ms epoch, stamped at record time
  kind: RunKind;
  remote: string | null; // set for pull/push only
  status: RunStatus; // worst of results
  changed: number; // items that did something
  issues: number; // items with status warning or error
  desc: string; // one-line human summary
  results: GroupResult[]; // full per-group detail for the detail view
}

// An item "did something" if it isn't a clean no-op: a non-ok status, real file changes, or a
// state action note (install/enable/update). Shared with the report pills so the counts agree.
export function isChanged(r: GroupResult): boolean {
  return r.status !== "ok" || hasChanges(r.changes) || r.stateNote !== undefined;
}

export function countChanged(results: GroupResult[]): number {
  return results.filter(isChanged).length;
}

const STATUS_RANK: Record<RunStatus, number> = { ok: 0, warning: 1, error: 2 };

export function worstStatus(results: GroupResult[]): RunStatus {
  let worst: RunStatus = "ok";
  for (const r of results) if (STATUS_RANK[r.status] > STATUS_RANK[worst]) worst = r.status;
  return worst;
}

const KIND_VERB: Record<RunKind, string> = {
  capture: "captured",
  apply: "applied",
  pull: "pulled",
  push: "pushed",
  adopt: "adopted",
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

// A single product-facing summary line: lead with the dominant problem when the run isn't
// clean, otherwise a concise success count.
export function runDesc(kind: RunKind, _remote: string | null, results: GroupResult[]): string {
  const issues = results.filter((r) => r.status !== "ok");
  if (issues.length > 0) {
    const notInCatalog = issues.filter((r) => r.messages.some((m) => m.includes("not in the community catalog"))).length;
    if (notInCatalog === issues.length) return `${plural(notInCatalog, "plugin")} not in the community catalog — install manually`;
    const failed = results.filter((r) => r.status === "error").length;
    if (failed > 0) return `${plural(failed, "item")} failed`;
    return `${plural(issues.length, "item")} need attention`;
  }
  const changed = countChanged(results);
  if (changed === 0) return "no changes";
  return `${plural(changed, "item")} ${KIND_VERB[kind]}`;
}

export function summarizeRun(at: number, kind: RunKind, remote: string | null, results: GroupResult[]): RunRecord {
  return {
    at,
    kind,
    remote,
    status: worstStatus(results),
    changed: countChanged(results),
    issues: results.filter((r) => r.status === "warning" || r.status === "error").length,
    desc: runDesc(kind, remote, results),
    results,
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");

// Local wall-clock, "YYYY-MM-DD HH:MM:SS".
export function formatRunTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Drop records beyond the count cap (newest kept) and older than the age cap. Input and output
// are newest-first. 0 = unlimited / forever.
export function pruneHistory(records: RunRecord[], maxCount: number, maxDays: number, nowMs: number): RunRecord[] {
  let out = records;
  if (maxDays > 0) {
    const cutoff = nowMs - maxDays * 86_400_000;
    out = out.filter((r) => r.at >= cutoff);
  }
  if (maxCount > 0 && out.length > maxCount) {
    out = out.slice(0, maxCount);
  }
  return out;
}
