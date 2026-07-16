# BRAT Beta Tab Implementation Plan

> Spec: docs/superpowers/specs/2026-07-17-brat-beta-tab-and-switch-order-design.md
> Executed inline (session pattern: core with TDD, UI verified live in the dev vault).

**Goal:** store-stable switch-list capture order, honest install-only messaging, BRAT id→repo
index, Beta settings tab, precise BRAT install.

## Global constraints

- Lint baseline 0 errors / 65 warnings; no hardcoded colors; all UI text sentence case.
- BRAT internals are feature-detected everywhere; failure falls back to guidance messages.
- `bratPluginIndex` syncs (no locked strip); resolution never runs during capture.

## Tasks

1. **switchList ordering** — `captureSwitchList` store-stable order (array + map);
   update tail-append tests; add excluded-in-place and byte-identity tests.
2. **Messaging** — `runStateAction` gains `hasStoreData`; failure guidance drops the settings
   clause when false; "installed the plugin only" only when the id is present afterwards.
   Tests: failed install-only carries no contradictory message.
3. **bratIndex core** — `src/core/bratIndex.ts`: `resolveBratIndex(current, repos, fetchManifest)`
   (fill + prune, failures leave unresolved); settings field `bratPluginIndex`.
   Tests with fake fetcher.
4. **Install path** — `installPlugin` in main.ts: index+BRAT → `betaPlugins.addPlugin(repo)`
   (feature-detected, verify id present after); else catalog; guidance messages per spec C4.
5. **Settings sectioning + Beta tab** — catalog: beta/community split takes the index and
   groups; community gains "Not installed on this device"; custom rules stop leaking synced
   plugin groups. SettingTab: Beta tab (BratIcon w/ flask fallback), map-note + ↻ Re-scan,
   three sections per 定稿 mockup v2.
6. **Live verify** — dev vault: forge BRAT pluginList, re-scan, Beta tab screenshot, community
   leak check, BRAT install smoke; full gates.
