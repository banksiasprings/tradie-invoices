# NIGHT LOG — tradie-invoices

Running log of autonomous/agent work sessions. Newest first.

---

## 2026-07-02 — v101.2 — Work Log fragmentation fix (v89 idempotency guard restored inside pure builder per Fable diagnosis)

Source: `plans/v92.1_workday_fragmentation_fix.md` (Fable 5 diagnosis, one field incident).
Field incident: 2 Jul, Lucas Ranch, continuous 08:45–13:30 → Work Log showed 3 fragmented
"Unconfirmed" entries (10:15 no-finish $0, 11:45 no-finish $0, 13:15–13:30 $15).

- **Root cause:** `buildSessionsFromEvents()` (v90 commit `32f23a8`, `www/index.html:~2756`)
  force-seals the open session as a no-finish $0 fragment on every same-site same-day duplicate
  ENTER. Rural GMS fence flutter systematically produces those (garbage EXIT accuracy-rejected →
  fence re-arms → clean-accuracy re-ENTER accepted). v89's replay loop ignored exactly this case
  (`Enter ignored — timer already running`); the v90 rewrite dropped that idempotency guard. The
  1 Jul control day had the identical 17-event flutter but replayed ~50 min BEFORE v90 shipped, so
  v89's guard deduped it into one clean 09:37→16:50 session.
- **Fix (~9 lines):** restored the guard INSIDE the pure builder, scoped to same-site + same-date +
  no accepted EXIT between → the duplicate ENTER is ignored and returned in a new `ignored[]` (kept
  pure — no GeoLog/DB in the `__V90_BUILDER__` block). `reconstructAndReconcile()` logs each ignored
  event as `Enter ignored — session already open (…)` (v89 field-proven line). Doc comment updated.
- **Multi-entry capability preserved:** different-site splits, different-DAY splits, and accepted-exit
  re-entries (merge or second session) all behave exactly as v90 shipped — only the pathological
  same-site/same-day/no-exit duplicate ENTER is deduped. Proven by new tests 14/15/16.
- **Money byte-identical:** diff touches ONLY the builder block + one GeoLog call site + APP_VERSION
  + tests. Zero `logbookPct`/`taxSummary`/`kmByCat`/`dayTotals`/`generateInvoice` lines changed.
  Firestore rules unchanged.
- **Tests: 82/82 pure** (`test-sessions.js` 24 = 16 existing + 8 new incl. today-field + control-day
  regressions + multi-day/multi-site guards + post-exit-merge; `test-tax.js` 38; `test-trips.js` 20).
  Emulator regression: `test-money-math.sh` 7/7, `test-geo-stop.sh` 6/6. Live OTA end-to-end on the
  emulator (see below).
- **Existing DB records:** NO migration (per plan). The 3 broken 2 Jul rows live only in
  `mcn_unconfirmed` (review backlog) — structurally non-billable (invoice/stats read `mcn_days`
  only), never counted unless explicitly Confirmed. Cleanup = manual via the review UI (Reject the
  no-finish fragments; Adjust one to the real 08:45–13:30 + Confirm). Auto-repair deliberately NOT
  shipped (would need phantom-vs-legit heuristics for one day of one user's reviewable data).
- **Version:** `APP_VERSION` v101.1 → **v101.2** (point release → OTA **1.101.2** via deploy workflow).
  NOTE: brief said "v92.1" (the plan's filename convention) — bumping to 1.92.1 would be a semver
  REGRESSION under the live 1.101.1, so per the plan I shipped v101.2. capacitor.config left at
  1.101.0 (bumps on next APK; this is OTA-only, no native change — Java capture layer untouched).
- **Secondary findings S1/S2 (deferred, per plan "optional, fixer's discretion"):**
  - **S1 — dead `flag NOT set` check** in `_confirmDepartureThenStop._commit()` (`~3585`): checks
    `activeDay().finish` AFTER `autoStopTimer()`, but v90's seal-and-clear makes `activeDay()` null
    there, so a stale `…flag NOT set` ignore-line logs on every reconstructed stop. Harmless (noise
    only). Touches the stop path → left alone to keep this fix surgical.
  - **S2 — GeoLog UTC `date`** (`~3233`): `date` from `toISOString()` (UTC) while `time` is local →
    Brisbane entries before 10:00 misfile onto the previous day's mirror doc. One-liner
    (`date: todayStr()`) but out of this fix's scope; session records unaffected. Deferred.
- **Phone delivery:** OTA 1.101.2; phone was reachable via wireless adb this session — see report.

---

## 2026-07-02 — v101.1 — H1 (per-vehicle logbook %) + H2 (per-FY logbook %) fixed per audit

Source: `audits/v100_v101_overseer_review_2026-07-01.md` (two HIGH findings, logbook method only).

- **H1 — logbook business-use % was fleet-aggregate.** `logbookPct(trips(), …)` was fed the
  unfiltered fleet at 4 call sites (renderTaxExports, renderLogbook card, CSV export, PDF export).
  Now per-vehicle via a new pure `tripsOfVehicle(list,vehId,defaultVehId)`; `tripsForVehicle`
  refactored to delegate to it (behaviour-identical). The brief named 3 sites — the 4th
  (renderLogbook card, line ~8247) is the same bug and was internally inconsistent with the
  per-vehicle km line directly below it, so it's fixed too.
- **H2 — current logbook % applied to past FYs (invalid per ATO).** Exports used
  `activeLogbook()` (newest-as-of-today) regardless of the FY being exported. New pure
  `logbookForFy(logbooks,vehId,fy)` selects the logbook that COVERS the FY (started ≤ FY-end,
  5-yr validity overlaps FY). A FY with no covering logbook → **"insufficient data — no logbook
  coverage"** (no borrowed %, no fabricated $). CSV Business-use % row now names its basis
  (12-week window dates) → no more silent mixed-basis block. New impure glue `logbookClaimInfo(veh,fy)`.
- **Cents-per-km path byte-identical** — no money/`taxSummary`/`kmByCat`/invoice code touched.
- **Tests: 74/74 pure.** `test-tax.js` 38 (36 existing + 2 new H1/H2 regressions), `test-trips.js`
  20, `test-sessions.js` 16. Live headless round-trip in the running app confirmed A=80%/B=0%
  per-vehicle (fleet path would read 40%), FY25→60% / FY26→80% per-FY, and an insufficient-FY
  showing "n/a" for logbook while cents-per-km still claims $44.
- Version: `APP_VERSION` v101 → **v101.1** (point release → OTA 1.101.1 via deploy workflow).
- **Not done (out of scope / deferred):** the 7 Mediums (M1–M7) and 8 Lows in the audit remain
  open; APK field-install still pending (phone offline, same as v101).
