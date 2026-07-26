# NIGHT LOG — tradie-invoices

Running log of autonomous/agent work sessions. Newest first.

---

## 2026-07-27 — v101.6 — trip auto-detect root cause + three field bugs (Opus 5)

Steven: *"The invoice app is still not 100%. Trip monitoring is not automatically coming
on either."* He was right, and the reason was not the one v101.3/v101.4 fixed. Diagnosed
from the **mirrored Firestore telemetry** (`users/{uid}/geolog/{date}` + `/data/*`), not
from guessing — his phone was unreachable (wireless debugging off; ping over Tailscale fine,
adbd not listening on any scanned port).

### What the telemetry actually said
- **The app's JS had not run since 2026-07-13 08:36 AEST** — 14 days. `App started (v101.5)`
  appears on 8, 9, 10 and 13 Jul, then nothing. Crucially, on *every one of those days* the
  log stops within a minute or two of the morning open. Nothing JS-side ran for the rest of
  any working day.
- **`mcn_trips` held exactly ONE trip** — a manual one from 6 Jul (`auto:false`). **Zero
  auto-detected trips, ever.** No "Trip auto-started", no "Trip logged", no "Trip discarded".
- **A stuck `activeDay`**: `{site:'Lds', start:'08:30', date:'2026-07-12', finish:null}` — still
  open. The Today tab had been showing a timer "running" for 360 hours.
- **`tripAutoDetect` was absent from the settings blob** → `!==false` → auto-detect *was* on.
  So the toggle was never the problem.
- Rural accuracy-rejection storm continues (9 Jul: 8 of 10 native geofence events rejected,
  acc 194m–1503m). Left alone deliberately — see Deferred.

### ROOT CAUSE (the real one)
`@capacitor-community/background-geolocation` stops its own foreground service when the host
Activity is destroyed:

```java
// BackgroundGeolocation.java
protected void handleOnDestroy() { if (service != null) service.stopService(); }
```

Steven's Moto Edge 50 Neo **destroys MainActivity the moment the app is backgrounded** — this
repo already recorded that behaviour in the v101.5 entry (`handleOnStop` → *App moved to
background* → `onActivityDestroyed` immediately) without connecting it to trip capture. So the
trip watcher only ever ran while he was looking at the screen, i.e. never while driving. That
is a perfect match for "zero trips ever" *and* "GeoLog goes silent after each morning open".

v101.4's fix (`addWatcher` returns the id synchronously, not a Promise) was **correct** —
confirmed against the plugin source (`@PluginMethod(returnType = RETURN_CALLBACK)`). It just
wasn't the binding constraint. The watcher did start; it was torn down minutes later.

Two things made this invisible for a month:
1. `_tripWatcherId` being set proves **nothing** — Capacitor returns the callback id even when
   the native side rejects the call (`addWatcher` → `call.reject("Service not running.")`).
   The v101.3 verification checked exactly that, in the foreground, where it genuinely works.
2. The watcher callback swallowed every error: `if (error || !location) return;`.

### The fix — `TripLogService`
Capture moves to an **app-owned foreground service**, mirroring the architecture that has
always kept the geofence layer alive: *native banks raw data → JS drains and reconstructs*.

- `TripLogService.java` — START_STICKY, `foregroundServiceType="location"`, fused provider at
  20s/25m high accuracy. Deliberately **dumb**: it appends `{lat,lng,acc,t}` to a 4000-entry
  SharedPreferences ring buffer and nothing else. All trip logic stays in the unit-tested JS
  pure block, and it never touches money or day records.
- `NativeGeoPlugin` gains `startTripLogging` / `stopTripLogging` / `getTripLoggingStatus` /
  `drainTripFixes` (atomic drain, same read-clear race fix as `drainPendingEvents`).
- `BootReceiver` restarts it after a reboot, and now **logs on entry** (it was a silent path).
- JS `setTripBgWatcher()` prefers the native service and **re-arms on resume** — the old code
  armed once per WebView load with no re-arm path at all. The plugin watcher stays as the
  fallback for an APK that predates the native methods, because JS ships by OTA ahead of the
  APK (that mismatch *was* the v92.1 Health bug).
- `applyBankedTripFixes()` replays the banked stream through the pure builder. Trip ids are
  derived from the start instant, so a re-drain can never double-log.

### Three more field bugs, same session
2. **Stuck activeDay** — `checkNearbySites()` gates auto-START on `!activeDay()`, so an
   activeDay that never got a finish blocks **every later day's auto-start**, silently and
   forever. `isStaleActiveDay()` (>20h, longer than any real shift) + `_sealStaleActiveDay()`
   send it to the review backlog on cold open and resume. **Never into `days[]`**, and
   `finish` is left unset — the app wasn't running when he left, so no honest end time exists
   and inventing one could bill hours he never worked.
3. **Silent failure / false green** — failures now hit the GeoLog, and Setup Health gained a
   **Trip logging** row sourced from real service state (`enabled` vs *actually* `running`).
   Never critical, so it can't block Start Day.
4. **GeoLog date was UTC while its time was local** — every Brisbane morning before 10:00 (the
   whole window in which the app gets opened) was filed under the *previous* day, in-app and
   in the Firestore mirror doc key. That is why 13 Jul 08:36 AEST reads as `2026-07-12`. It
   was actively corrupting the only field-diagnostic tool this project has.

### Verification
Tests written **first** (red phase confirmed on the missing markers).

- **Pure: 126/126** — 44 new (`test-triplog.js`) + 38 tax + 20 trips + 24 sessions. Was 82.
  Pins are named for the real records: Steven's actual stuck `activeDay` startTs, and the
  13 Jul 08:36 AEST entry.
- **Emulator integration: 10/10** (`test-triplog-service.sh`), including the A/B contrast that
  demonstrates the mechanism rather than asserting it:
  - trip logging ON → `am kill` **cannot** reclaim the process (foreground service protects it)
  - trip logging OFF → the process **is** reclaimed immediately ← what happened every day
  - `types=00000008` (FOREGROUND_SERVICE_TYPE_LOCATION), survives backgrounding, and **GPS
    fixes really are banked with the app backgrounded**
- **Live CDP: 35/35** against the real running app — reconstruction, idempotent replay,
  mid-drive carry, the stale-day seal (incl. *did not* land in `days[]`), Health row never
  critical, GeoLog local date.
- **Regression: money 7/7, geo-stop 6/6.** Money/tax paths **byte-identical** — 0 diff lines
  match the money/tax fn set.
- OTA live at **1.101.6**, checksum verified, bundle flat-rooted, carries all four fixes.
  APK www hash matches the repo exactly.

### Harness notes worth keeping
- `dumpsys activity services` needs **awk block-scanning**: `isForeground` sits well below the
  ServiceRecord header (so `grep -A2` misses it), and the `{}` in the record id breaks BRE
  matchers — note the shell's `grep` here is a **ugrep wrapper**, which made this fail silently.
- `am kill` is the right kill for this test — it is the *safe* reclaim the OS actually uses, and
  it refuses a process holding a foreground service. `force-stop` is user-initiated and proves
  nothing.
- Capgo reloads the WebView once on cold start, which tears down the JS context mid-eval — CDP
  tests must poll for readiness (`typeof APP_VERSION === 'string'`) before asserting.

### Deferred, with reasons
- **Boot-restart is NOT automated.** This emulator delivers neither `BOOT_COMPLETED` (protected;
  a real `adb reboot` produced no delivery to the package) nor `MY_PACKAGE_REPLACED` via
  `install -r` — the technique documented in `test-geo-scenarios.sh` has **bit-rotted** on this
  API level. The code follows the established pattern and rides the same receiver as the
  geofence re-registration; a blocked start is recorded and surfaced in Health, so if it does
  fail on the phone it is visible rather than silent. Cold-start + resume re-arming covers the
  same ground on every app open. **This also means the pre-existing geofence boot path is
  currently unverifiable on this emulator — worth a dedicated session.**
- **Accuracy-rejection storm** (8/10 geofence events rejected, rural fused location). A
  margin-aware gate (accept when `distM + acc < radius`, i.e. when the uncertainty can't change
  the verdict) would have accepted the real 07:00 enter that was rejected at 194m accuracy
  inside a 2900m fence. Deliberately **not** touched: it is native, it is the highest-risk area
  in the app (v89 was about false stops corrupting workdays), and it deserves its own session
  with field data. **This is the top follow-up.**
- **`test-health.js` is referenced in CLAUDE.md but does not exist in the repo** — 20 assertions
  described in the v92.1 entry, file absent. Either never committed or lost. Not recreated here.
- **Heartbeat feed** (`URGENT_ALERTS.txt`, stale since 2026-06-30): not a dead service — it was
  never a service. `run_monitor.sh` is a manual one-day field harness started by hand on 30 Jun
  via `run_in_background`; there is **no launchd job** for it. It also can't run today: it needs
  adb on `100.122.43.30:5555`, and the phone isn't listening.

### Note for Steven
Installing the APK brings back the permanent **"Trip log — Recording your km logbook"**
notification. That notification **is** the fix — it is what stops Android killing the tracker
when the phone goes in his pocket. Turning it off in Settings → Trip auto-detect turns trip
capture off with it. Work-site timing (geofences) is unaffected either way.

---

## 2026-07-02 — v101.5 — Settings toggles to show/hide Machine Hire + Building Supplies (Opus 4.8)

Steven doesn't use Machine Hire or Building Supplies and wanted them hidden from the Today
logging screen. Added two Settings toggles that **mirror the existing Extra Labor toggle
(`showExtraWorker`) exactly**. Pure-JS, OTA-only. Verified on Steven's phone (Moto Edge 50
Neo) via CDP. Commit `3e43217`, branch `main`. OTA live at **1.101.5**; phone confirmed
running v101.5 (screen had to be awake for the cold-launch `otaCheck` to apply — see lesson).

### The pattern mirrored (for future reference)
- **Extra Labor toggle** lives in the **"Standard Rate"** settings card (`index.html` ~line
  1873): a `.toggle-row` `#s-show-extra-worker` → `saveExtraWorkerPref()`; setting
  `S().showExtraWorker` (DEFAULTS `showExtraWorker:false`); gated on the Today tab by
  `applyTradeVisibility()` via `showExtra = !emp && (S().showExtraWorker||false)` toggling
  `idle-extra-worker-row` / `active-extra-worker-row` / `me-extra-worker-card`; loaded into
  the checkbox in `loadSettings()` (~5465).

### What changed (all in `www/index.html`, +46/−7 lines, 3 files incl. 2 capacitor configs)
- **DEFAULTS:** `showMachineHire:false`, `showBuildingSupplies:false` — identical default to
  `showExtraWorker` (per brief: mirror the default, don't invent policy). Default OFF = hidden,
  which is also exactly what Steven wants.
- **Settings UI:** two new `.toggle-row`s (`#s-show-machine-hire`, `#s-show-building-supplies`)
  in the same Standard Rate card, right after Extra worker billing. Same widget + copy pattern.
- **Save fns:** `saveMachineHirePref()` / `saveBuildingSuppliesPref()` mirror
  `saveExtraWorkerPref()` (read checkbox → `DB.set('settings',s)` → `applyTradeVisibility()` →
  `CloudSync.pushAll()`).
- **`applyTradeVisibility()`:** machine rows now gated `hasMachines && showMachineHire`
  (idle/active/me-machine-row); materials sections gated by `showMaterials = !emp &&
  showBuildingSupplies` — **using the CORRECT element IDs** `materials-idle-section` /
  `materials-active-section` (+ new `materials-me-section` id added to the Manual-Entry
  materials card). *Note:* the old materials line referenced non-existent IDs
  `idle-/active-materials-section` and was a silent no-op; fixing the IDs to gate the toggle
  also (as a natural consequence) restores the originally-intended employee-mode hide.
- **`loadSettings()`:** populate the two new checkboxes from settings.
- **Capgo builtin `version` → 1.101.5** (root + android assets) per the v82 cache-trap rule.

### Non-negotiables held
- **Money/tax paths byte-identical** — 0 diff lines match
  `logbookPct|taxSummary|kmByCat|logbookForFy|tripsOfVehicle|dayTotals|generateInvoice|
  cents_per_km|logbookClaim`. v101.2 `buildSessionsFromEvents` guard + v101.4 trip
  watcher/auto-detect untouched. `firestore.rules` unchanged.
- **Data preserved** — the toggle only hides the input; `machinesLib`/`materialsLib` records
  are never touched. Turning it back ON restores everything.

### Verification
- **Pure:** 82/82 (`test-tax.js` 38 + `test-trips.js` 20 + `test-sessions.js` 24). Full inline
  JS re-parsed clean (both main app `<script>` blocks).
- **Local preview (CDP):** seeded 1 machine + 1 material, both ON → all 6 surfaces
  (machine idle/active/me + materials idle/active/me) `block`; both OFF → all `none`; back ON →
  `block`. `machinesLib`/`materialsLib` intact across the cycle.
- **On Steven's phone (CDP against the live WebView):** APP_VERSION **v101.5**, both toggles
  present. His real state: `showMachineHire`/`showBuildingSupplies` unset → default `false` →
  Machine Hire + Building Supplies **already hidden** on Today out of the box (what he asked
  for). His **5 machines** (Excavator, Grader, Bobcat, Dozer, Tractor) preserved. Ran the
  OFF→ON→OFF cycle via the real save fns: before all 6 `none` → ON all 6 `block` → OFF all 6
  `none`, machines stayed 5 throughout. `showExtraWorker:true` unaffected. Left in the
  hidden/OFF state Steven wants.

### Lesson (reinforces the phone-OTA-cold-launch memory)
The phone would NOT apply the OTA on cold launch while its **screen was asleep / another app
held the foreground** — the invoice activity `handleOnStop`→`App moved to background`→
`onActivityDestroyed` immediately, so the startup `otaCheck()` never ran the JS. **Waking the
screen + `wm dismiss-keyguard` + `am start -n .../.MainActivity`** brought it truly to
foreground, `otaCheck()` ran, and v101.5 applied on that launch. Also: **CapacitorUpdater
plugin calls invoked from a CDP-injected eval never resolve** (`current()`/`list()` hang) — so
you can't drive the OTA from CDP; use the app's own cold-launch `otaCheck` (screen awake) or an
APK reinstall. CDP is fine for reading `APP_VERSION`/DOM/localStorage.

### Deferred / notes
- No APK rebuild needed (pure JS; OTA carried it). Capgo builtin bumped to 1.101.5 so the
  *next* APK stays in step (v82 rule). Native `versionCode` still 3 (unchanged — no native build).
- Visual screenshot skipped: Steven's phone was actively showing a different Claude session
  (auragold), so grabbing the invoice app's foreground would have interrupted him — the CDP DOM
  evidence above is authoritative.

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
