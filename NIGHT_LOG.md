# NIGHT LOG — tradie-invoices

Running log of autonomous/agent work sessions. Newest first.

---

## 2026-07-02 — v101.3 + v101.4 — three field fixes, all verified on Steven's phone (Opus 4.8)

Steven home with wireless adb + phone plugged. Three known problems, fixed + shipped +
verified on-device (Moto Edge 50 Neo) via Chrome DevTools Protocol. Shipped as two point
releases (v101.4 is a same-session follow-on to v101.3). **Money paths byte-identical**
(0 changed lines match `logbookPct|taxSummary|kmByCat|logbookForFy|tripsOfVehicle|dayTotals|
generateInvoice|cents_per_km|logbookClaim`); v101.2 `buildSessionsFromEvents` guard untouched;
`firestore.rules` unchanged. **82/82 pure** (38 tax + 20 trips + 24 sessions) at every step.

### Problem 1 — Settings Health "check unavailable" (NATIVE fix, no JS)
- **Root cause:** the phone's flashed APK predated the v92 `getHealthStatus`/`openHealthFix`
  native bridge — confirmed on-device: `Capacitor.Plugins.NativeGeo` had only the pre-v92
  methods, `getHealthStatus is not a function`, so `Health.run()` returned
  `bridgeUnavailable:true` → the yellow banner + 9× "Update the app to run this check". (OTA had
  pulled v101.2 JS overnight; native stayed old.)
- **Fix:** rebuilt the current-source APK (bridge already in `NativeGeoPlugin.java`) → flashed
  `adb install -r` (debug key matched, app data preserved). No JS change for this one.
- **On-device verify:** `getHealthStatus()` now returns a real object; `Health.run()` →
  `bridgeUnavailable:false`; card shows **"8 of 9 checks passing"** (amber "Minor warnings"),
  every row a real state. Screenshot `plans/v101.3-shots/shot_health.png`.
- **Bonus (no manual grant needed):** Background location already = **"Allow all the time"**,
  battery exempt, Doze exempt, Play services OK. Only advisory = Motorola app-kill list (soft
  WARN, non-blocking — Steven CAN tap "Tap to fix" to check Moto's autostart list, but nothing
  is required of him).

### Problem 2 — Analytics tab completely blank [FIXED, ~6-line rename]
- **Root cause (found + reproduced on-device):** the v100/v101 tax module added a SECOND
  top-level `function fyLabel(fy:string)` (line 8059) that **hoist-shadowed** the original
  `fyLabel(startYear:number)` (line 5146). `renderThisYear()` calls `fyLabel(numberYear)` →
  the string version does `fy.slice(0,4)` on a number → **throws at line 5188**, which aborts
  the whole `renderAnalytics()` (FY label, weekly hours, YTD, pace, past-FYs, hours-by-week
  chart, rate history — the entire screen). Went live on the phone only when it OTA-pulled
  v101.2 JS overnight → matches "worked yesterday, blank today". Steven's "cloud didn't pull"
  read was a misdiagnosis: data was present (48 days, 2 in the current FY), the render just threw.
  The bug was invisible because one call site wraps `renderAnalytics` in `try{}catch(_){}`.
- **Fix:** renamed the number-arg version → `fyLabelYr` and repointed its 5 stats call sites
  (5146 def + 5188/5258/5321/5338/5364). Tax-module `fyLabel` + its 9 call sites byte-identical.
- **On-device verify:** `showScreen('analytics')` no longer throws → **FY2026–27, 29.3h weekly,
  $615.00 YTD, "Behind by $313.50", 8 chart bars with heights, past FY $19,289, tiles $5.8k /
  $68 / $11.5k / 24.2**. Screenshot `plans/v101.3-shots/shot_analytics.png`.

### Problem 3 — Trip auto-detect manual-only [FIXED: default-ON + vehicle prompt + bg-watcher fix]
- **State found:** the v100 `TripDetector` was fully wired but the `tripAutoDetect` toggle
  defaulted OFF, and it silently auto-assigned the default vehicle with no prompt.
- **Fix 3a (default-ON):** `DEFAULTS.tripAutoDetect:true` + `!==false` at the 3 read sites
  (5465 / 8033 / 8968). `!==false` preserves an explicit user opt-out (`DB.def` does NOT merge
  defaults into an existing settings object, so an unset flag now reads ON).
- **Fix 3b (vehicle prompt):** new `maybePromptTripVehicle()` (called from `initTripLog` on cold
  start + resume, 1.5s delay). If auto-detect banked a trip while backgrounded, a modal asks
  **"🚗 Trip auto-detected — Started at HH:MM · X km · Y min. Which vehicle was this?"** with a
  button per vehicle + **Not now** + **Discard trip**. Handles both the live in-progress trip
  ("still driving") and a recently-completed (<6h) untagged auto-trip. "Already prompted"
  tracked in a **local-only** `mcn_tripVehPrompted` key (not synced, NOT part of the trip
  schema) → trip capture/merge/storage untouched. Manual Start/Add unaffected (auto:false).
- **Fix 3c (v101.4 — bg watcher never started):** on-device the watcher wouldn't start —
  `@capacitor-community/background-geolocation`'s `addWatcher` is a **callback method**, so the
  Capacitor proxy returns the watcher id **synchronously as a string**, NOT a Promise.
  `setTripBgWatcher` chained `.then()` on that string → threw every call (silently caught) →
  background trip capture never ran. **Dormant pre-v101.3** (trip watcher was default-OFF; the
  geofence-fallback watcher is gated behind NativeGeo-unavailable, i.e. never runs on this
  phone) — but default-ON activated it, so it directly blocked the "auto-start in the
  background" the request centres on → in-scope. Fixed `setTripBgWatcher` to accept a sync
  string id OR a Promise (defensive). **Only `setTripBgWatcher` touched** — the geofence-
  fallback site left byte-identical (don't touch the work-site geo path).
- **On-device verify:** toggle reads ON (`tripAutoDetect` unset → effective ON); seeded a
  completed auto-trip → prompt renders ("City · 205VVN" / Not now / Discard); **Assign** sets
  `vehicle_id`+`edited_by_user`+marks seen+closes; **Discard** removes the trip+closes;
  `TripDetector._begin` → active auto-trip → prompt shows "still driving". After v101.4:
  `window._tripWatcherId` = a real id on cold start, `BackgroundGeolocationService`
  `isForeground=true` with notification **"Trip log — Logging your trip."** (superseded a stray
  FGS notification my investigation had left). Screenshot `plans/v101.3-shots/shot_tripprompt.png`.
  **Expected side-effect Steven will see:** a persistent "Trip log — Logging your trip."
  notification whenever auto-detect is ON (Android FGS requirement for background location) —
  turn it off in Settings → Trip auto-detect to remove it.

### Ship state
- Commits `3fb1098` (v101.3) + `5d2e440` (v101.4) on `main`, pushed.
- OTA **live at 1.101.4** (deploy workflow parsed `v101.4` → semver + checksum + bundle).
- APK rebuilt (`InvoicePDF-latest.apk`, builtin 1.101.4 + v101.4 www + health bridge) + flashed.
- **Phone now running:** APP_VERSION v101.4 · OTA bundle 1.101.4 (auto-pulled on cold launch,
  id unzHlgTx90) · Capgo native builtin 1.101.4 · health bridge present · trip bg-watcher live.
  Gradle `versionName=1.2 / versionCode=3` unchanged (tracks Play releases separately, by design).
- **localStorage safety:** snapshotted the phone's 18 mcn_* keys before flashing; verified
  Steven's real data intact after all tests (48 days, 2 invoices, 1 vehicle, 0 trips, no test
  artifacts).
- **Deferred / not chased (per brief):** the audit's "auto-detect OFF toggle doesn't stop
  foreground detection" Medium (not touched — my default-ON + bg-watcher work didn't close it);
  the geofence-fallback `addWatcher` `.then` bug (identical shape, but dormant behind
  NativeGeo-present — left byte-identical to protect the work-site path). Recurring-route
  auto-learn + Xero → later, unchanged.

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
