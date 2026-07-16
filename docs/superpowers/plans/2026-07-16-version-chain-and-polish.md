# Version Chain Completion + Polish — Plan (inline execution)

T1 lock adoption in applyImport (identical groups → remote lock entries; groupForStoreRel maps file:ids) + unit tests (identical-only pull carries version bump; local-kept groups keep local entries; B-newer adoption produces ahead).
T2 deepDiff host result gains lockDiffers (raw store.lock.json compare); remote detail line: diff empty && lockDiffers → "contents match — remote has newer version info; Pull refreshes it".
T3 captureItems: `void this.refreshLocalStatus()`; applyItems: keep self loadSettings await, then void refresh.
T4 refreshLocalStatus computes availability (loadLock + availabilityForGroup) → presented bucket counts stored; updateRibbonDot consumes them.
T5 passphrase badge: fix overlap (nowrap + flex placement in controlEl), verify narrow widths.
Gates per task; dev-vault smoke: identical-only pull lock bump end-to-end, hint text, progress completes, dot on forged ahead, badge layout; cut 0.23.7 after acceptance.
