# v100/v101 Overseer Review — Trip Log MVP + ATO Tax Exports

**Date:** 2026-07-02 (covers v100 + v101, shipped 2026-07-01/02)
**Reviewer:** Claude (adversarial read-only audit; see model note in Coverage)
**Scope:** `www/index.html` v100 module (~7365–8017) + v101 module (~8019–8470), `firestore.rules`, diff `d6332c8..HEAD` (v92.1 → v101), pure test suites (run fresh)
**Constraint honoured:** read-only — no code modified, no commits; this report file is the only write.

---

## 1. Executive summary

**The v100/v101 code is safe for Steven's current use (single vehicle, current FY, cents-per-km method) but has 2 High findings that make the LOGBOOK method not tax-ready, plus 7 Medium concerns — none touching invoice money paths.**

- Invoice/day money paths are **provably untouched**: all 16 diff hunks between v92.1 and v101 land outside `dayTotals`/`generateInvoice`/`saveDay`/the v90 queue, and the entire trip/tax module contains zero references to the days store (verified by grep over lines 7365–8470).
- The cents-per-km core math (5,000 km cap, commute exclusion, FY boundaries, divide-by-zero guards) is **correct** — verified by code read + 36/36 passing pure tests, re-run during this audit.
- The **logbook method** has two real correctness bugs: the business-use % is computed across ALL vehicles (H1) and the current logbook's % is applied to past FYs' expenses, which the ATO does not allow (H2). Fix both before Steven (or anyone) relies on a logbook-method figure.
- Firestore rules are clean — everything v100/v101 added is owner-scoped; no public-read paths were introduced.

---

## 2. Ranked findings

### HIGH

#### H1 — Logbook business-use % is computed from ALL vehicles' trips
The three places that compute the logbook % all pass the **unfiltered** trip list:
- `www/index.html:8183` (renderTaxExports): `var bizPct=lb?logbookPct(trips(),lb.start_date):sum.businessPct;`
- `www/index.html:8305` (CSV export): `var bizPct=lb?logbookPct(trips(),lb.start_date):sum.businessPct;`
- `www/index.html:8360` (PDF export): same expression.

An ATO logbook is **per vehicle**. With two vehicles (Steven: ute + likely a personal car eventually), one vehicle's business km inflates the other's logbook %, producing a wrong — and over-claimed — expense figure. The code is even internally inconsistent: `renderLogbook` at `www/index.html:8249` correctly filters the *displayed km* to the vehicle (`kmByCat(tripsForVehicle(inWindow,veh.id))`) while showing the *unfiltered* % two lines above it (`:8247`). Latent today (one vehicle), wrong the day a second vehicle is added — silently.

**Fix (one-liner ×3):** `logbookPct(tripsForVehicle(trips(),veh.id), lb.start_date)`.

#### H2 — Current logbook % applied to past-FY expenses (invalid per ATO) + mixed bases in one summary block
`activeLogbook(vehId)` (`www/index.html:8140-8145`) selects the latest logbook that hasn't expired **as of today** — it ignores the FY being exported. In the CSV/PDF (`:8305`, `:8360`), that % is then multiplied by `expensesInFy(veh.expenses, fy)` for **whatever FY the user selected**. A logbook is valid for the year it's kept plus the following four — it can NOT be applied retroactively to an earlier FY. Exporting FY 2024-25 next year with a logbook started in 2026 would produce an invalid claim figure presented as authoritative.

Compounding it: in the same CSV summary block, `Business-use %` (logbook-window basis, possibly cross-FY, all vehicles per H1) sits directly under `Business km` / `Total km` rows computed on a different basis (selected FY + vehicle) — `www/index.html:8315-8318`. An accountant dividing the km rows will get a different % than the row below them, with no explanation.

**Fix:** only use logbook % when `lb.start_date <= fyEndDate(fy)`; otherwise fall back to `sum.businessPct`; and label the % row with its basis (e.g. `Business-use % (12-wk logbook 5 Jan – 29 Mar 2026)`).

### MEDIUM

#### M1 — Deleting a vehicle leaves stale `tax_prefs.vehicle_id`; UI then shows a different vehicle than the math uses
`deleteVehicle()` (`www/index.html:7739-7745`) never clears `taxPrefs().vehicle_id` (or that vehicle's logbooks). Afterwards `_taxVehId()` (`:8118`) still returns the dead id → `_taxVeh()` is null → rate silently falls back to `S().travelKmRate||0.88` (`:8117`) and `tripsForVehicle(trips(), deadId)` (`:8122-8128`) selects only trips explicitly stamped with the deleted vehicle. Meanwhile the vehicle `<select>` (`:8197-8198`) has no matching option so the browser **displays the first live vehicle as selected**. Result: the screen says "Ute", the export computes the deleted vehicle's trips at a fallback rate.
**Fix:** in `deleteVehicle()`, if `taxPrefs().vehicle_id===_editVehicleId`, `setTaxPrefs({vehicle_id:null})` (and consider pruning its logbooks).

#### M2 — Auto-detect toggle OFF does not stop foreground auto trip detection
`saveTripAutoDetectPref()` (`www/index.html:7765`): `TripDetector._enabled=true; // detector always processes fixes; toggle controls the bg watcher`. `TripDetector.onFix` is fed by the always-on foreground GPS stream via `checkNearbySites` (`:3371`), so with the toggle OFF, driving with the app open still auto-creates trips (`_begin` at `:7554`). The Settings toggle is framed as opting into auto-detect; in reality it only gates the background watcher (`window.setTripBgWatcher`, `:8873`). **Unclear whether intentional — needs Steven's read.** If unintended: gate `_begin()` (not `onFix`) on `S().tripAutoDetect` so manual Start/Stop still works.

#### M3 — Trip deletion is silent; edits leave no before-value — thin audit trail for a tax record
`deleteTrip()` (`www/index.html:7966-7970`) removes the trip with a `confirm()` and nothing else — no GeoLog entry, no tombstone; the Firestore mirror is overwritten by the same `setTrips` sync, so the record is gone everywhere. Category/vehicle/notes edits (`tagTrip` `:7924-7930`, `setTripCategory` `:7958-7963`, `setTripVehicle` `:7964`, `setTripNotes` `:7965`) reliably stamp `edited_by_user:true` (good, and it syncs — `setTrips`→`DB.set('trips')`→ the patched `DB.set` at `:826-835` pushes since `'trips'` is in `SYNC_KEYS` `:461`) but retain no prior value. For an ATO-facing logbook, deleted business km leave zero trace. **Fix (cheap):** `GeoLog.add('info','Trip deleted: '+t.date+' '+t.distance_km+'km '+t.category)` in `deleteTrip`, and consider a `mcn_trips_deleted` tombstone array.

#### M4 — One rate per vehicle across all FYs: historic exports use today's rate
`vehicleRate()` (`www/index.html:8117`) reads a single `cents_per_km`. Exporting FY 2023-24 (rate $0.85) applies today's $0.88. Mitigated by the UI note "ATO rates change yearly…" (`:8229-8230`), but the export itself gives no warning when `fy !== currentFy()`. **Fix:** per-FY rate map on the vehicle, or a warning row in the CSV/PDF summary for past-FY exports.

#### M5 — Summary block vs detail rows can disagree inside one CSV/PDF when a category filter is set
By design (commented, `www/index.html:8300-8301`), the summary uses `sel` (all categories) while rows use `_taxExportRows()` (category-filtered, `:8289-8294`). PDF weekly pages likewise iterate `rows` (`:8410`) under a summary built from `sel` (`:8358`). An accountant summing the Distance column gets a total ≠ the "Total km" line, with nothing in the file saying a filter was applied. When filter = "All" they match exactly (same set — verified). **Fix:** emit a `Filter,<category>` line in the summary when `p.category!=='all'`.

#### M6 — Passing within 150m of ANY saved site ends the active trip (splits trips, drops km)
`onFix` (`www/index.html:7545-7546`): while a trip is running, any single fix within `siteEndRadiusM` (150m) of a saved site ends it — including driving past a site en route elsewhere at 100 km/h. Restart then requires 2 min of sustained ≥10 km/h (`:7531-7535`) and the new polyline starts at the first fast fix, so up to one fix-interval of driving (~0.5–1.5 km at highway speed on the 30–90s cadence) is lost from the logbook every drive-by. Systematic **under**-count of business km (conservative for tax, but wrong, and splits one real trip into two cards to tag). **Fix:** require low speed too (`sp<TRIP_CFG.stopKmh`) before site-end fires.

#### M7 — Odometer readings are captured but never exported
The vehicle modal records per-FY odometer start/end (`www/index.html:7719-7728`) and the logbook card displays them (`:8256-8257`), but neither `exportTripsCSV` nor `exportTripsPDF` includes them. An ATO logbook record requires odometer readings at the start/end of the period. The PDF cannot crash on missing odometers — it never reads them — but the "accountant-ready" export is incomplete for the logbook method. **Fix:** add `Odometer start/end (FY)` rows to both summaries when present, "n/a" when not.

### LOW

#### L1 — CSV formula injection via notes/labels
`_csvCell` (`www/index.html:4897`) escapes quotes/commas/newlines but not leading `=`, `+`, `-`, `@`. A note of `=HYPERLINK(...)` executes in Excel on the accountant's machine. Single-user self-entered data → low. **Fix:** prefix `'` when a cell starts with those characters.

#### L2 — Trip crossing midnight June 30 lands wholly in the FY of its start
`date` is derived from `start_time` (`www/index.html:7564`), so a 23:50 Jun 30 → 00:20 Jul 1 trip is entirely FY-of-June-30 (and the card shows an end time "earlier" than the start). Reasonable convention, but undocumented. Fine for Steven; note it in CLAUDE.md.

#### L3 — Clearing the vehicle rate field saves `cents_per_km: 0` → silent $0 claims
`saveVehicle` `:7716` does `parseFloat(...)||0`; `vehicleRate` `:8117` treats 0 as a real rate (`!=null`). **Fix:** treat NaN/empty as "unset" (null) instead of 0.

#### L4 — Weekly "$X claimable" chip ignores the 5,000 km cap and mixes bases
`_weeklySummaryHtml` `:7883-7885`: all vehicles' business km × the default vehicle's rate, no cap. Acceptable as a motivator chip; know it can overstate.

#### L5 — In-progress logbook % is exported without caveat
An unfinished 12-week window still yields a % into CSV/PDF (`:8305`,`:8360`). The card says "in progress" (`:8253`); the exports don't. Add "(logbook in progress — not yet valid)" until `todayStr() > logbookEndDate(...)`.

#### L6 — Vehicle-less trips follow the *current* default vehicle
`tripsForVehicle` `:8122-8128` attributes `vehicle_id:null` trips to whoever is default **now** — switching the default silently moves historic unassigned km between vehicles' claims. Rare (capture stamps the default at trip start, `:7558`), but real for trips captured before any vehicle existed.

#### L7 — Pure test state machine drifts slightly from the live detector
`detectTripsFromFixes` skips poor-accuracy fixes entirely (`:7449` `continue`) while live `onFix` keeps them as the speed anchor (`:7525`), and the pure version has no site-end path. Tests therefore exercise a close cousin of production, not the identical machine. Document the delta or align them.

#### L8 — `onTaxCatChange` doesn't re-render (`:8168`)
The "N trips · X km" selection line goes stale until the next interaction. Cosmetic.

---

## 3. Answers to the specific brief questions

| Question | Answer |
|---|---|
| Cap at exactly 5000 / 5000.0001 / 4999.9 | Correct. `capped = businessKm>5000` (strict), `claimKm=min(businessKm,5000)` (`:8077-8078`). 5000.0001→capped, claim 5000; exactly 5000→not flagged capped, claim 5000; per-vehicle because input is the FY+vehicle-filtered set (H1's cross-vehicle issue affects only the *logbook %*, not the cents cap). |
| total_km == 0 / all-unknown | No divide-by-zero: guarded ternaries at `:8070` and `:8083` return 0. All-unknown → business 0, total = sum, claim $0 (conservative, correct). |
| Trip across June 30 midnight | Whole trip in the start-date FY (L2). FY selector on exactly July 1: correct — `fyOf('2026-07-01')==='2026-27'`, covered by test-tax.js:29. |
| Commute ≠ business | Confirmed: `kmByCat` puts commute in total, never business (`:8059-8067`); explicitly tested (test-tax.js:64-68). |
| Logbook window locks / 5-yr expiry / incomplete window | Start date locked (Monday, stored, no edit path); expiry = start+5yr, string-compared inclusive (`:8140-8145`) — fine. Incomplete window still yields a % (L5); the % basis is buggy per H1/H2. |
| Firestore rules | Read end-to-end. Catch-all `users/{userId}/{document=**}` is `request.auth.uid == userId` (`firestore.rules:12-14`); explicit trips/vehicles blocks identical (`:19-24`); `tax_prefs` rides the settings blob under `users/{uid}/data/` → covered by the catch-all. Diff since v92 adds **only** owner-scoped matches + comments — no new public paths. Note: `businessCodes` readable by any signed-in (incl. anonymous) user is **pre-existing** (employee/quote feature), not a v100/101 regression. Caveat: repo copy reviewed; whether the *deployed* rules match was not verified (read-only, no firebase CLI calls). |
| Merge double-counting | v90's 90-min merge is a **work-session/time** mechanism (`buildSessionsFromEvents` `:2733-2762` — gap banked as `lunchMins`, superseded by id). Trips have no merge logic at all → no km double-count possible. |
| GPS jitter false-start | Needs sustained ≥10 km/h for ≥2 min with every intermediate fix fast, else `moveStart` resets (`:7531-7536`); ≤50m accuracy gate; and any spurious micro-trip <0.3 km is discarded at commit (`:7588`). Adequately defended. |
| Mid-trip vehicle switch | Not possible mid-trip (no UI); post-hoc `setTripVehicle` re-attributes the **whole trip** to the new vehicle's rate (`:7964`). By design of the one-`vehicle_id`-per-trip model. |
| Zero-polyline trip | `polylineKm` returns 0 for <2 points (`:7410`); manual trips store `distance_km` directly with `polyline:[]` (`:7990`); `_polySvg` returns '' (`:7856`). No crash. |
| v90 sessions + v100 trip collision | None: disjoint stores (`mcn_unconfirmed` vs `mcn_trips`), disjoint id prefixes (`s…` vs `t…`), disjoint processing paths. A single GPS fix can legitimately fire both a geofence work-start and a trip site-end — independent, intended. |
| `edited_by_user` → Firestore | Yes: every edit path stamps it (`:7926,:7960,:7964,:7965,:7994`) and `setTrips`→`DB.set('trips')` auto-syncs (SYNC_KEYS `:461`, patched DB.set `:826-835`). |
| CSV column mapping | Verified 12 headers (`:8327`) ↔ 12 fields (`:8331-8338`), in order: Date/Vehicle/Start/End/Distance/Category/StartAddr/EndAddr/Notes/LinkedSite/LinkedInvoice/Purpose. Hand-traced samples below. Quirk: when `notes` is set, Purpose duplicates Notes (`_tripPurpose` `:8282`). |
| PDF summary vs weekly totals | Match exactly when category filter = All (same set). Diverge when filtered — M5. |
| No odometer readings | PDF never reads odometers → cannot crash; they're simply absent from exports — M7. |
| 0-trip export | Both guarded: `if(!sel.length){toast('No trips…');return;}` (`:8302`, `:8351`). |
| Filename `/` or `:` in vehicle name | Safe: `_vehSlug` strips to `[a-z0-9-]` with 'vehicle' fallback (`:8287`). |
| $433 field record (2026-07-01) | **Not verifiable from the repo** — it lives on the phone (offline per CLAUDE.md) / Firestore. Verified instead that no v100/v101 code can touch it: zero `days`-store references in the module, no diff hunk inside any money function (see §4). |
| Raw times (v91) | Work sessions keep `rawStart`/`rawFinish` (`:2712`, `:2717`); trips store raw ms timestamps and are never rounded (v91 rounding applies only at session confirm/save). |
| Category change without audit trace | Any change stamps `edited_by_user` — but the *prior* value isn't kept, and **deletion is fully silent** — M3. |

**CSV hand-trace (3 constructed samples against `:8331-8338`):**
1. Auto trip `{date:'2026-07-01', start_time:1751321400000, distance_km:18.25, category:'business', notes:'Muirlawn visit', linked_site_id:'Muirlawn'}` → `2026-07-01,Ute,07:30,08:00,18.25,Business,-28.65000,151.93000,Muirlawn,Muirlawn visit,Muirlawn,,Muirlawn visit` — correct (Notes≡Purpose quirk visible).
2. Manual trip `{from_label:'Home', to_label:'Stanthorpe', distance_km:12, category:'personal'}` → addresses use labels (`_tripAddr` `:8270-8278`), times both 09:00 (`:7986`) — correct.
3. Untagged auto trip near a site → Category `Untagged`, Purpose `Site visit: X` from an **unconfirmed suggestion** (`:8283`) — worth knowing: the Purpose column asserts a site visit the user never confirmed (noted under L-tier; related to `suggestTripLinks` auto-setting `linked_site_id` at `:7504` despite the "never auto-applies" comment).

---

## 4. Coverage report

**Checked:**
- Full read of the v101 pure block (`:8027-8104`), tax helpers/UI (`:8106-8294`), CSV (`:8297-8346`), PDF (`:8349-8469`), v100 pure block (`:7400-7480`), TripDetector + manual controls (`:7516-7643`), vehicles CRUD + expenses (`:7646-7767`), trips UI/swipe/detail/delete (`:7770-7997`), lifecycle (`:8000-8017`), BGGeo watcher (`:8867-8896`), v90 builder + merge (`:2660-2782`).
- `firestore.rules` end-to-end + its diff since v92.1.
- **Money-path isolation, three independent ways:** (1) all 16 diff hunk headers `d6332c8..HEAD` inspected — additions only, none inside `dayTotals`/`generateInvoice`/`saveDay`/`confirmSession`/v90 queue code; the only shared-code touches are one line in `checkNearbySites` (`:3371`, try/catch'd onFix), one line in `showScreen`, `SYNC_KEYS` +2 entries, and a `loadSettings` render block; (2) grep of the whole trip/tax module for the days store — zero hits; (3) pure regression suites re-run this audit: **test-tax.js 36/36, test-trips.js 20/20, test-sessions.js 16/16 — all pass.**
- v92 Health: untouched by the diff (no hunk lands in the Health module).

**Not checked / couldn't check:**
- The live $433 day record and on-phone state — phone offline (per CLAUDE.md, unreachable since the v92.1 ship); verified by code-path analysis instead.
- `test-money-math.sh` / `test-v90-sessions.sh` (live CDP suites) — need the emulator + running app; out of scope for a read-only audit. The pure equivalents were run.
- Whether the **deployed** Firestore rules match the repo copy (no firebase CLI invoked).
- Native accuracy-rejection gate — documented in CLAUDE.md as not emulator-testable; unchanged by v100/101.
- No trip fixture data exists in the repo (tests are synthetic in-memory), so CSV cross-checks used hand-constructed records traced through the row builder rather than real captures.
- **Model note:** the brief routed this to Fable 5 medium; the session fell back to Opus 4.8 (harness-reported) partway/at spawn. No API 529s interrupted the audit itself. If Steven wants a Fable second pass, H1/H2 are the two findings worth re-deriving.

---

## 5. What's already good (honest baseline)

- **The strict-additive claim is real.** Best-verified claim in the ship notes: diff hunks, module grep, and green regression suites all agree — invoice money, the v90 queue, v91 rounding, and v92 Health are untouched.
- **Cents-per-km core is correct**: cap semantics (strict >, min-clamp), commute-excluded-from-business, unknown/mixed in denominator only, all divide-by-zero guarded, FY boundary math right including the July-1 edge — and all of it covered by tests that extract the *shipped source verbatim* (no test/prod drift for the pure block). That extraction pattern is genuinely good engineering.
- **Firestore rules discipline**: v100/101 added only owner-scoped, redundant-by-design matches with accurate comments; `mcn_activeTrip` deliberately kept out of sync (write-spam avoidance) as documented.
- **Defensive UX details done right**: 0-trip export guards, filename slugging, `_vehSlug` fallback, `Object.assign` merge in `saveVehicle` so expenses/odometers survive edits, WinAnsi-safe PDF strings (`–`/`->`, no `→`), UTF-8 BOM + CRLF for Excel, stale-trip recovery on cold start, and the <0.3 km noise gate.
- **The detection state machine is well-defended** against the failure mode that burned v89 (GPS glitches): accuracy gate + sustain windows + commit-time distance floor.
- `edited_by_user` stamping is consistent across every edit path and reliably syncs.

*Bottom line for Steven: use cents-per-km for FY25-26 with confidence today. Don't hand an accountant a logbook-method figure until H1/H2 are fixed — both are one-to-three-line fixes.*
