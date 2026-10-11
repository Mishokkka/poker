# Performance work in 1.7.8

This release applies the behavior-preserving fixes from the performance audit. It deliberately does not change table rules, controls, templates, CSS, visible history limits, Actor-selection UX, or bot decision policy.

## Applied

- **PERF-001:** live table state and the capped 100-hand archive are stored separately. Ordinary mutations write compact live state only; the archive is written only when completed-hand history changes. Public mutation traffic is a changed-table delta instead of a full all-table snapshot.
- **PERF-002:** Table, Lobby, and History applications receive granular invalidation metadata and skip unrelated full renders.
- **PERF-003:** an open History application rerenders only when that table's history changes or the table is deleted. The visible history UI itself is unchanged.
- **PERF-004:** the 6/7-card evaluator now classifies the best hand directly instead of allocating every five-card combination. Monte Carlo iteration counts and bot policy are unchanged.
- **PERF-005:** `REQUEST_STATE` returns a full snapshot only to the requesting client. It no longer causes a public broadcast to all clients.
- **PERF-006:** independent private hole-card deliveries start in parallel, while `Promise.all` preserves the existing barrier that all private deliveries complete before the public hand update.
- **PERF-007:** bursty `updateUser` events are coalesced into one pending 250 ms host-role refresh.
- **PERF-009:** table countdown DOM references are cached for the lifetime of a render, and the 4 Hz interval is created only while a future deadline exists.
- **PERF-010:** a clean current-schema host startup does not rewrite unchanged table settings. Migration, active-hand rollback, normalization, and restarted automatic-next deadlines still mark live state dirty and are persisted.

## Intentionally not changed

- **PERF-008 (Actor-heavy SeatDialog):** preserving the current native Actor dropdown requires enumerating every eligible Actor and showing every balance. Search, paging, virtualization, or a lazy picker would change UX. No permanent cache was added because reliable invalidation would require additional Actor/ownership/currency hooks and could produce stale choices.
- **PERF-011 (ledger):** the ledger is capped at 500 entries and is not on the per-action poker hot path. Changing its persistence model is not justified without runtime evidence.
- **PERF-012 (CSS paint/layout risks):** templates and CSS were left unchanged. The audit classified these costs as runtime-unverified, and removing filters/shadows or changing the timer animation would alter visuals.
- **MICRO / NOT WORTH IT findings:** not applied. They do not remove meaningful work and would only increase regression surface.

## Regression verification

- Existing regression suite remains green.
- Added direct-vs-previous evaluator equivalence tests on targeted edge cases plus 20,000 deterministic random 6/7-card hands.
- Added tests for legacy embedded-history migration, cold-history persistence, clean startup, targeted refresh, changed-table deltas, client-side history patch merging, granular invalidation, and parallel private delivery.
- Handlebars templates and CSS are unchanged from 1.7.7.

The test environment is Node, not a running Foundry/Electron client. Chromium paint/layout and real multiplayer RTT still require in-Foundry profiling if runtime-specific evidence is needed.
