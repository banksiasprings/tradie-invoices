# NIGHT LOG — tradie-invoices

Running log of autonomous/agent work sessions. Newest first.

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
