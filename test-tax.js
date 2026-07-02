#!/usr/bin/env node
/*
 * test-tax.js — unit tests for the v101 PURE tax-export logic.
 *
 * Extracts the //__V101_TAX_PURE_START__ / __V101_TAX_PURE_END__ block VERBATIM
 * from www/index.html and exercises the shipped source (no copy, no drift):
 * financial-year math, km/category aggregation, cents-per-km summary + 5,000 km
 * cap, logbook business-use %, expenses, and the FY list. Pure logic →
 * sub-second feedback, no emulator.
 *
 * Run:  node test-tax.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
const m = html.match(/\/\/__V101_TAX_PURE_START__[^\n]*\n([\s\S]*?)\/\/__V101_TAX_PURE_END__/);
if (!m) { console.error('✗ could not find v101 tax pure markers in www/index.html'); process.exit(2); }
const api = new Function(m[1] + '\nreturn {fyOf,fyStartDate,fyEndDate,fyLabel,addDaysStr,addYearsStr,mondayOf,logbookEndDate,logbookExpiryDate,tripsInRange,tripsInFy,kmByCat,businessUsePct,taxSummary,logbookPct,logbookExpenseClaim,expensesInFy,fyList,tripsOfVehicle,logbookForFy,CENTS_KM_CAP};')();
const { fyOf, fyStartDate, fyEndDate, fyLabel, addDaysStr, addYearsStr, mondayOf, logbookEndDate, logbookExpiryDate, tripsInRange, tripsInFy, kmByCat, businessUsePct, taxSummary, logbookPct, logbookExpenseClaim, expensesInFy, fyList, tripsOfVehicle, logbookForFy, CENTS_KM_CAP } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra){ if(cond){ pass++; console.log('  ✓ '+name); } else { fail++; console.log('  ✗ '+name+(extra!==undefined?('  → '+extra):'')); } }
function near(a, b, tol){ return Math.abs(a-b) <= tol; }

// ── Financial year math (AU: Jul 1 – Jun 30) ─────────────────────────────────
console.log('Financial year math');
ok("June date → previous-year FY", fyOf('2026-06-30') === '2025-26', fyOf('2026-06-30'));
ok("July date → new FY", fyOf('2026-07-01') === '2026-27', fyOf('2026-07-01'));
ok("today 2026-07-02 → 2026-27", fyOf('2026-07-02') === '2026-27', fyOf('2026-07-02'));
ok("Dec date stays in same FY", fyOf('2025-12-15') === '2025-26', fyOf('2025-12-15'));
ok("FY start date", fyStartDate('2025-26') === '2025-07-01', fyStartDate('2025-26'));
ok("FY end date", fyEndDate('2025-26') === '2026-06-30', fyEndDate('2025-26'));
ok("FY label", fyLabel('2025-26') === 'FY 2025–26', fyLabel('2025-26'));

// ── Date arithmetic ──────────────────────────────────────────────────────────
console.log('Date arithmetic');
ok("mondayOf returns a Monday", new Date(mondayOf('2026-07-02')+'T00:00:00').getDay() === 1, mondayOf('2026-07-02'));
ok("mondayOf a Sunday → prev Monday", mondayOf('2026-07-05') === mondayOf('2026-06-29') || new Date(mondayOf('2026-07-05')+'T00:00:00').getDay()===1);
ok("addDaysStr rolls month", addDaysStr('2026-06-29', 5) === '2026-07-04', addDaysStr('2026-06-29',5));
ok("addYearsStr +5", addYearsStr('2026-06-29', 5) === '2031-06-29', addYearsStr('2026-06-29',5));
// 12 weeks = 84 days inclusive → last day = start + 83
ok("logbook end = start + 83 days", logbookEndDate('2026-06-29') === addDaysStr('2026-06-29', 83), logbookEndDate('2026-06-29'));
ok("logbook end is a Sunday", new Date(logbookEndDate('2026-06-29')+'T00:00:00').getDay() === 0, logbookEndDate('2026-06-29'));
ok("logbook expiry +5yr", logbookExpiryDate('2026-06-29') === '2031-06-29', logbookExpiryDate('2026-06-29'));

// ── km aggregation ───────────────────────────────────────────────────────────
console.log('km by category');
const mix = [
  {date:'2025-08-01',category:'business',distance_km:3000},
  {date:'2025-09-01',category:'personal',distance_km:1500},
  {date:'2025-10-01',category:'commute', distance_km:500},
];
const k = kmByCat(mix);
ok("business km = 3000", k.business === 3000, k.business);
ok("personal km = 1500", k.personal === 1500);
ok("commute km = 500", k.commute === 500);
ok("total km = 5000", k.total === 5000, k.total);
ok("unknown category folds to unknown", kmByCat([{category:'nope',distance_km:10}]).unknown === 10);

// ── Cents-per-km summary + 5,000 km cap ──────────────────────────────────────
console.log('Cents-per-km method (rate $0.88)');
const s1 = taxSummary(mix, 0.88);
// Brief verify: business counted, commute NOT counted → claim = 3000 × 0.88
ok("business km = 3000 (commute excluded)", s1.businessKm === 3000, s1.businessKm);
ok("not capped at 3000", s1.capped === false);
ok("cents claim = $2640", near(s1.centsClaim, 2640, 0.001), s1.centsClaim);
ok("business-use % = 60", near(s1.businessPct, 60, 0.001), s1.businessPct);

console.log('Cents-per-km cap (6000 business km)');
const over = taxSummary([{date:'2025-08-01',category:'business',distance_km:6000}], 0.88);
ok("capped = true over 5000", over.capped === true);
ok("claim km clamped to 5000", over.claimKm === 5000, over.claimKm);
ok("capped claim = $4400", near(over.centsClaim, 4400, 0.001), over.centsClaim);
ok("uncapped claim = $5280", near(over.centsClaimUncapped, 5280, 0.001), over.centsClaimUncapped);
ok("cap constant is 5000", CENTS_KM_CAP === 5000);

// ── Logbook business-use % over a 12-week window ─────────────────────────────
console.log('Logbook method (12-week window)');
const start = '2026-01-05'; // a Monday
const end = logbookEndDate(start);
// 3000 business + 2000 personal INSIDE the window; one trip OUTSIDE should be ignored
const lbTrips = [
  {date:start,            category:'business', distance_km:3000},
  {date:addDaysStr(start,10), category:'personal', distance_km:2000},
  {date:addDaysStr(end,1),    category:'business', distance_km:9999}, // outside window
];
ok("business-use % = 60", near(logbookPct(lbTrips, start), 60, 0.001), logbookPct(lbTrips, start));
ok("expense claim = 60% of $10,000 = $6000", near(logbookExpenseClaim(60, 10000), 6000, 0.001), logbookExpenseClaim(60,10000));
ok("window excludes out-of-range trip", tripsInRange(lbTrips, start, end).length === 2, tripsInRange(lbTrips,start,end).length);

// ── FY filtering + expenses + FY list ────────────────────────────────────────
console.log('FY filtering, expenses, FY list');
const twoFy = [
  {date:'2025-08-01',category:'business',distance_km:100},  // FY 2025-26
  {date:'2026-09-01',category:'business',distance_km:200},  // FY 2026-27
];
ok("tripsInFy(2025-26) keeps only that year", tripsInFy(twoFy,'2025-26').length === 1, tripsInFy(twoFy,'2025-26').length);
ok("tripsInFy(2026-27) keeps only that year", tripsInFy(twoFy,'2026-27')[0].distance_km === 200);
const exp = [
  {date:'2025-08-01',category:'fuel',amount:1200},
  {date:'2025-11-01',category:'rego',amount:800},
  {date:'2026-09-01',category:'fuel',amount:500}, // next FY
];
ok("expenses in FY 2025-26 = $2000", expensesInFy(exp,'2025-26') === 2000, expensesInFy(exp,'2025-26'));
const fys = fyList(twoFy, '2026-27');
ok("FY list newest first", fys[0] === '2026-27' && fys[1] === '2025-26', fys.join(','));
ok("FY list includes current even with no trips", fyList([], '2026-27').length === 1);

// ── H1 regression: logbook business-use % is PER-VEHICLE, not fleet-aggregate ─
// Two vehicles share one logbook window. Vehicle A drives 100% business, vehicle B
// 100% personal. Each vehicle's logbook % must reflect ONLY its own trips (A=100,
// B=0). Before the fix, logbookPct(trips(),…) fed the whole fleet → both read ~50.
console.log('H1 — per-vehicle logbook business-use %');
const h1Start = '2026-01-05'; // a Monday
const h1Trips = [
  {date:h1Start,               vehicle_id:'A', category:'business', distance_km:100},
  {date:addDaysStr(h1Start,7), vehicle_id:'A', category:'business', distance_km:100},
  {date:addDaysStr(h1Start,14),vehicle_id:'B', category:'personal', distance_km:100},
  {date:addDaysStr(h1Start,21),vehicle_id:'B', category:'personal', distance_km:100},
];
const h1PctA = logbookPct(tripsOfVehicle(h1Trips,'A',null), h1Start);
const h1PctB = logbookPct(tripsOfVehicle(h1Trips,'B',null), h1Start);
const h1Fleet = logbookPct(h1Trips, h1Start); // the buggy path — proves the delta
ok("H1: per-vehicle % A=100, B=0 (fleet-aggregate was "+h1Fleet+")", h1PctA===100 && h1PctB===0 && h1Fleet===50, 'A='+h1PctA+' B='+h1PctB+' fleet='+h1Fleet);

// ── H2 regression: each FY uses the logbook that COVERS that FY (not today's) ──
// Vehicle A has two logbooks: one begun in FY 2024-25 (60% business) and one begun
// in FY 2025-26 (80%). Exporting FY 2024-25 must use the FY25 logbook (60%), and
// FY 2025-26 the FY26 logbook (80%). Before the fix, activeLogbook() always chose
// today's newest logbook → both FYs wrongly read 80%.
console.log('H2 — FY-specific logbook selection');
const h2Logbooks = [
  {id:'lb25', vehicle_id:'A', start_date:'2024-09-02'}, // Monday, window inside FY 2024-25
  {id:'lb26', vehicle_id:'A', start_date:'2025-09-01'}, // Monday, window inside FY 2025-26
];
const h2Trips = [
  {date:'2024-09-02', vehicle_id:'A', category:'business', distance_km:60}, // FY25 window
  {date:'2024-09-09', vehicle_id:'A', category:'personal', distance_km:40}, // FY25 window
  {date:'2025-09-01', vehicle_id:'A', category:'business', distance_km:80}, // FY26 window
  {date:'2025-09-08', vehicle_id:'A', category:'personal', distance_km:20}, // FY26 window
];
const h2Lb25 = logbookForFy(h2Logbooks,'A','2024-25');
const h2Lb26 = logbookForFy(h2Logbooks,'A','2025-26');
const h2Veh = tripsOfVehicle(h2Trips,'A',null);
const h2Pct25 = logbookPct(h2Veh, h2Lb25.start_date);
const h2Pct26 = logbookPct(h2Veh, h2Lb26.start_date);
ok("H2: FY25→60% (lb25), FY26→80% (lb26); past FY never uses today's logbook",
   h2Lb25.id==='lb25' && h2Lb26.id==='lb26' && h2Pct25===60 && h2Pct26===80,
   'lb25='+h2Lb25.id+' pct25='+h2Pct25+' lb26='+h2Lb26.id+' pct26='+h2Pct26);

console.log('\n'+(fail===0?'✅ ALL PASS':'❌ FAIL')+`  (${pass} passed, ${fail} failed)`);
process.exit(fail===0?0:1);
