// The vocabulary (spec 2026-08-11-v3-one-vocabulary-design.md §1): one concept, one word.
// `scope` is retired outright — it used to mean the settings area, the item category AND the
// sharing rule, in three different places, so every consumer had to know which one it was looking
// at. Each of those three is now its own named type below.

// "which devices something runs on" — the `device` axis. Named DeviceClass because a compiled
// group and a companion both carry one; the WORD in the data is `device`.
export type DeviceClass = "all" | "desktop" | "mobile";

export type SyncMode = "plain" | "fields" | "encrypted";

// "which family an item belongs to" (§1) — the values an item is STORED under (spec §7b). Structure
// carries this now: the settings document nests items by section instead of prefixing their ids, so
// two ids may legitimately collide across sections (a core and a community plugin that share a
// name).
export const STORAGE_SECTIONS = ["obsidian", "core", "community", "custom"] as const;
export type StorageSection = (typeof STORAGE_SECTIONS)[number];

// The PRESENTED section list (spec §7b): `beta` is not a family, it is an install source (BRAT),
// derived at runtime from each community item's own `bratRepo` field (bratIndex.ts's
// `bratRepoIndex`). It is a search value, a settings tab and a card badge — it
// is never a storage key, because an item that changed section (and therefore its identity) the
// day BRAT adopted it would be churn no benefit justifies. A beta plugin stores under `community`,
// exactly where its v2 key put it. registry.ts's `storageSection` is the ONE bridge between the
// two, and it is the only way to reach a StorageSection from a Section.
export const SECTIONS = ["obsidian", "core", "community", "beta", "custom"] as const;
export type Section = (typeof SECTIONS)[number];

export type ItemId = string;

// The one-string form of (section, id) — for the two places that genuinely cannot nest:
// localStorage keys and `thisDeviceItems`. INSIDE the document, section and id are already
// structural; a compound key there would be a second, disagreeable source of truth.
//
// Built from StorageSection, not Section, ON PURPOSE: a ref is an IDENTITY, and `beta` is a
// classification. A `beta/<id>` ref would name an item no reader can find (every reader resolves
// the community section), and would change the moment BRAT's list changed — a classification
// leaking into an identity is the exact defect class this release exists to end, so the type makes
// it unrepresentable rather than merely wrong.
export type ItemRef = `${StorageSection}/${ItemId}`;

export function itemRef(section: StorageSection, id: ItemId): ItemRef {
  return `${section}/${id}`;
}

// The inverse. Returns null for anything that isn't `<stored section>/<non-empty id>` — a ref
// reaches us from localStorage and from documents other builds write, so an unrecognised one is
// ignored where it is read rather than trusted or deleted (2.21.0 invariant II.2). A `beta/…` ref
// is unrecognised by that rule, which is the reading we want: it was never a legal identity.
export function parseItemRef(ref: string): { section: StorageSection; id: ItemId } | null {
  const cut = ref.indexOf("/");
  if (cut <= 0 || cut === ref.length - 1) return null;
  const section = ref.slice(0, cut);
  if (!(STORAGE_SECTIONS as readonly string[]).includes(section)) return null;
  return { section: section as StorageSection, id: ref.slice(cut + 1) };
}

// "who shares a value" (§1). A union, not an enum, because the class only exists for one of the
// three answers — the old flat RuleScope ("all" | "desktop" | "mobile" | "local") collapsed two
// orthogonal questions ("is this shared, and with whom?") into one list, which is why every
// consumer had to special-case "local" by hand.
export type Sharing = { kind: "everywhere" } | { kind: "per-class"; class: "desktop" | "mobile" } | { kind: "this-device" };

// A file-level rule cannot be this-device: a Plain file that shouldn't sync at all is expressed by
// the item's own sync toggle, not by a file-level rule. The union says so, so the old
// `Exclude<RuleScope, "local">` runtime guard has nothing left to guard.
export type FileSharing = Exclude<Sharing, { kind: "this-device" }>;

export const EVERYWHERE = { kind: "everywhere" } as const;

export function perClass(cls: "desktop" | "mobile"): { kind: "per-class"; class: "desktop" | "mobile" } {
  return { kind: "per-class", class: cls };
}

export const THIS_DEVICE = { kind: "this-device" } as const;

// The device class a per-class rule names, or null for the other two kinds — the reading almost
// every consumer wants ("is this value pinned to a class, and which?").
export function sharingClass(s: Sharing): "desktop" | "mobile" | null {
  return s.kind === "per-class" ? s.class : null;
}

export function isThisDevice(s: Sharing): boolean {
  return s.kind === "this-device";
}

export function sharingEquals(a: Sharing, b: Sharing): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "per-class" ? true : a.class === (b as { class: string }).class;
}

// Runtime narrowing for a value read off a document (invariant II.1/II.2): the compile-time type is
// a claim about JSON that builds we don't know have written, so a shape this build cannot read is
// ignored where it is used and left on disk exactly as found.
export function asSharing(v: unknown): Sharing | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === "everywhere") return EVERYWHERE;
  if (kind === "this-device") return THIS_DEVICE;
  if (kind !== "per-class") return undefined;
  const cls = (v as { class?: unknown }).class;
  return cls === "desktop" || cls === "mobile" ? perClass(cls) : undefined;
}

export function asFileSharing(v: unknown): FileSharing | undefined {
  const s = asSharing(v);
  return s === undefined || s.kind === "this-device" ? undefined : s;
}

// "how a device decides whether an on/off-list entry is on" (§2). Two orthogonal axes, not one
// enum: `device` says which device classes the entry belongs to, `force` pins its state outright.
// `force.where` is recorded but never read yet — the migration writes "everywhere" for every rule,
// preserving today's fleet-wide behaviour (C-#46 is explicitly out of scope, spec §8); the field
// exists so making that choice later is a change of value, not of shape.
export interface RunsOn {
  device: DeviceClass;
  force?: { state: "on" | "off"; where: "everywhere" | "this-device" };
}

export function runsOnEquals(a: RunsOn, b: RunsOn): boolean {
  if (a.device !== b.device) return false;
  if (a.force === undefined || b.force === undefined) return a.force === b.force;
  return a.force.state === b.force.state && a.force.where === b.force.where;
}

// Runtime narrowing, same rule as asSharing: an unrecognised device class or force shape is
// ignored at the point of use, never rewritten on disk.
export function asRunsOn(v: unknown): RunsOn | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const device = (v as { device?: unknown }).device;
  if (device !== "all" && device !== "desktop" && device !== "mobile") return undefined;
  const rawForce = (v as { force?: unknown }).force;
  if (rawForce === undefined) return { device };
  if (typeof rawForce !== "object" || rawForce === null) return undefined;
  const state = (rawForce as { state?: unknown }).state;
  const where = (rawForce as { where?: unknown }).where;
  if ((state !== "on" && state !== "off") || (where !== "everywhere" && where !== "this-device")) return undefined;
  return { device, force: { state, where } };
}

// Per-element sharing for a string-array key (spec §2's `perElement`): element value -> sharing; an
// element with no entry defaults to everywhere. Generalizes the switch-list mechanism to any
// string-array key, not just community-plugins.json / core-plugins.json / enabledCssSnippets.
export type PerElementSharing = Record<string, Sharing>;

export interface FieldRule {
  pattern: string; // key-name glob pattern
  sharing: Sharing;
  encrypted: boolean;
  locked?: boolean; // preset rule; cannot be removed in the UI
}

// Plain-mode whole-file rule (spec §2, D9). `sharing` cannot be this-device by construction.
export interface FileRule {
  sharing: FileSharing;
  encrypted: boolean;
}

export interface SyncGroup {
  name: string;
  // THE identity (spec §3/§4), minted by the compiler and by nobody else — registry.ts's
  // compileItems for an item's own file, itemKeys.ts's companionRef/carrierRef for the two things
  // that are not items. It keys the store lock, the device-local baselines and the device-local
  // opt-out list; `name` keeps its own three jobs (the store path's display label, the manifest's
  // uniqueness rule, the switch-list lookup) and is no longer an identity.
  //
  // Optional because a SyncGroup can also arrive from a hand-written legacy `config-sync.json` (see
  // manifest.ts's parseGroup), which has no item behind it. Such a group has no lock entry and no
  // baseline — it never had a stable identity to key one by — and that reads as never-captured,
  // which is what it always was.
  ref?: ItemRef;
  path: string; // real vault-relative path; may start with the {configDir} variable
  type: "file" | "folder";
  devices: DeviceClass;
  mode?: SyncMode; // absent = "plain"; "fields" only on file groups
  fields?: FieldRule[]; // key-name glob rules; only with mode "fields"
  // Whole-file encryption for a Plain single-file group (settingsFile only — never folder
  // members). Only meaningful when mode is absent or "plain"; manifest.ts rejects it otherwise.
  fileRule?: FileRule;
  // Per-element sharing maps for string-array keys under mode "fields" (spec §3, D3): key ->
  // element sharing map. A key listed here is governed exclusively by capturePerElementArray/
  // applyPerElementArray (src/core/perElement.ts) instead of the key's own {sharing, encrypted}
  // rule; manifest.ts rejects combining a perElement key with encrypted:true (encrypt stays
  // key-level, never per-element).
  perElement?: Record<string, PerElementSharing>;
  description?: string; // optional human-readable label, shown in the settings panel
  label?: string; // display name recorded at capture/enable; falls back through the resolver chain
  origin?: "discovered"; // rule created from the Discovered-files section; name/path are fixed by the file
}

export interface SyncManifest {
  version: 1;
  groups: SyncGroup[];
}

// Where a lock entry's version came from (spec §3). v2 encoded the KIND OF SOURCE in the field
// NAME — `sourcePluginVersion` / `sourceAppVersion` — so every reader had to know both names and
// try them in order. One object, one `kind`, and adding a third source later is a value change.
export interface LockSource {
  kind: "plugin" | "app";
  version: string;
}

// One lock entry per item (spec §3). The index signature is the carried tail (spec
// 2026-08-11-data-model-hardening.md §3.1, invariant II.1): parseStoreLock validates the named
// fields and keeps every other key exactly as it found it, so a field a NEWER build writes
// survives a parse here instead of being stripped and pushed back out to the fleet as a loss.
export interface StoreLockEntry {
  // This item's OWN provenance (spec 2026-08-11-data-model-hardening.md §6), so freshness stops
  // being a single whole-store timestamp. Both reach a reader through the carried tail rather than
  // through validation — read them with manifest.ts's lockEntryCapturedAt / lockEntryHash, never
  // off these fields, for the same reason `version` is read via storeLockVersion. `hash` is absent
  // by design on an item whose store copy is ciphertext; an absent value is never a difference.
  capturedAt?: string; // when THIS item was last captured into the store
  hash?: string; // fingerprint of this item's store content — the same canonical hash the direction baseline uses
  source?: LockSource;
  // What the ITEM is, independent of anything a user chose: `desktopOnly` means the plugin's own
  // manifest says it cannot run on mobile. 2.21.0 §6 deferred this partition because an older
  // reader threw on an entry it could not recognise; v3 is gated, so it lands here.
  innate?: { desktopOnly?: true };
  // Names, never behaviour. `elements` (v2's `memberLabels`) is id → display name, only on a
  // carrier entry — names for on/off-list elements that have no lock entry of their own (they are
  // never individually synced). Both are display, so status.ts never counts them as a difference.
  display?: { label?: string; elements?: Record<string, string> };
  [key: string]: unknown;
}

// section -> id -> entry (spec §3). Typed as a plain two-level record rather than
// `Record<StorageSection, …>`: the sections this build knows are the four StorageSections plus
// itemKeys.ts's `legacy` holding pen, and a section a NEWER build writes has to ride through the
// parse untouched like any other unknown key — carrying is an invariant at EVERY level (§3.1), and
// a required-key type would make the top level the one place it did not hold.
export type LockItems = Record<string, Record<string, StoreLockEntry>>;

export interface StoreLock {
  // The lock's FORMAT version (spec 2026-08-11-data-model-hardening.md §4.3). Absent = 1: a lock
  // written before that release has the flat `groups` shape and is converted on the way in. This
  // build writes 3. Declared here for the writers, but never trusted as a number on the way in — it
  // rides through parseStoreLock in the carried tail like any other key, so read it through
  // manifest.ts's storeLockVersion rather than off this field.
  version?: number;
  // The lineage watermark (§6): the remote state this store was last aligned to. Only a pull moves
  // it — that alignment is what makes status.ts's remoteLockAhead settle to false after a pull, and
  // it used to be smuggled into `capturedAt`, which had to carry both meanings at once. Absent = a
  // v1 lock, whose `capturedAt` still carries both; read it through manifest.ts's lockWatermark.
  syncedWatermark?: string;
  // DERIVED since v2: max(items[*][*].capturedAt), i.e. the newest moment any item in THIS store
  // was captured. It describes local content only — a pull recomputes it from the merged entries
  // and never copies the remote's value over it, which is what used to make it a watermark by
  // accident.
  capturedAt: string;
  // Was v2's flat `groups`, keyed by compiled group name (spec §3/§5). Reach an entry through
  // manifest.ts's lockEntry/lockEntryList, never by indexing two levels by hand: the nesting is one
  // fact, and two sites that spell it out are two sites that can disagree about it.
  items: LockItems;
  [key: string]: unknown; // carried the same way as an entry's unknown keys (§3.1)
}

export interface FileChanges {
  added: string[];
  updated: string[];
  deleted: string[];
}

export function hasChanges(c: FileChanges): boolean {
  return c.added.length > 0 || c.updated.length > 0 || c.deleted.length > 0;
}

export interface GroupResult {
  group: string;
  status: "ok" | "warning" | "error";
  filesWritten: string[];
  filesDeleted: string[];
  messages: string[];
  needsAppReload: boolean;
  changes: FileChanges;
  stateNote?: { kind: "ok" | "warn"; text: string };
}

// excludeSelf (either type): true = Config Sync's own settings (the self item's store copy)
// never travel to/from this remote — pull/push skip them and the comparison stops reporting
// them. Absent = false = the self item travels like any other (same-lineage stores).
// What the git transport answers a credential prompt with. The username matters: PAT-only hosts
// ignore it, a self-hosted GitLab validates it — so it is carried, never assumed at the edge.
export type GitAuth = { username: string; token: string };

export type Remote =
  | { name: string; type: "vault"; storePath: string; excludeSelf?: boolean } // storePath: absolute path of the store directory; leading ~ allowed
  | { name: string; type: "git"; url: string; branch: string; subdir?: string; excludeSelf?: boolean; tokenId?: string; username?: string }; // subdir: store folder inside the repo; absent = repo root. tokenId: name of the keychain secret holding the token — the token itself never enters data.json. username: sent alongside it; absent = "token", which PAT-only hosts ignore but a self-hosted GitLab validates

export type RibbonKey = "sync";
export type RibbonButtons = Record<RibbonKey, boolean>;
