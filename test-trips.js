#!/usr/bin/env node
/*
 * test-trips.js — unit tests for the v100 PURE trip-log logic.
 *
 * Extracts the //__V100_TRIP_PURE_START__ / __V100_TRIP_PURE_END__ block
 * VERBATIM from www/index.html and exercises the shipped source (no copy, no
 * drift): Haversine, polyline km sum, speed, the trip detection state machine,
 * and weekly aggregation. Pure logic → sub-second feedback, no emulator.
 *
 * Run:  node test-trips.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
const m = html.match(/\/\/__V100_TRIP_PURE_START__[^\n]*\n([\s\S]*?)\/\/__V100_TRIP_PURE_END__/);
if (!m) { console.error('✗ could not find v100 trip pure markers in www/index.html'); process.exit(2); }
// TRIP_CATS is declared just above the pure block in the app; inject it so the
// extracted source resolves it exactly as it does in the running app.
const PRELUDE = "var TRIP_CATS=['business','personal','commute','mixed','unknown'];\n";
const api = new Function(PRELUDE + m[1] + '\nreturn {_tripHaversine,polylineKm,speedKmh,detectTripsFromFixes,aggregateTrips,TRIP_CFG};')();
const { _tripHaversine, polylineKm, speedKmh, detectTripsFromFixes, aggregateTrips, TRIP_CFG } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra){ if(cond){ pass++; console.log('  ✓ '+name); } else { fail++; console.log('  ✗ '+name+(extra?('  → '+extra):'')); } }
function near(a, b, tol){ return Math.abs(a-b) <= tol; }

// ── Haversine ────────────────────────────────────────────────────────────────
console.log('Haversine distance');
// Stanthorpe ~ Brisbane is ~180km straight line. Use a known ~1km separation:
// 0.009 deg latitude ≈ 1.0 km.
ok('0.009° lat ≈ 1.00 km', near(_tripHaversine(-28.65,151.93,-28.659,151.93)/1000, 1.0, 0.05),
   (_tripHaversine(-28.65,151.93,-28.659,151.93)/1000).toFixed(3)+'km');
ok('identical points = 0', _tripHaversine(-28.65,151.93,-28.65,151.93) === 0);

// ── polylineKm ───────────────────────────────────────────────────────────────
console.log('Polyline km sum');
const straight = [
  {lat:-28.650,lng:151.930},
  {lat:-28.659,lng:151.930},   // +1km
  {lat:-28.668,lng:151.930},   // +1km
];
ok('two 1km legs ≈ 2.0 km', near(polylineKm(straight), 2.0, 0.06), polylineKm(straight).toFixed(3));
ok('single point = 0 km', polylineKm([{lat:-28.65,lng:151.93}]) === 0);
ok('empty = 0 km', polylineKm([]) === 0);

// ── speedKmh ─────────────────────────────────────────────────────────────────
console.log('Speed km/h');
// 1km in 60s = 60 km/h
const s = speedKmh({lat:-28.650,lng:151.930,t:0},{lat:-28.659,lng:151.930,t:60000});
ok('1km in 60s ≈ 60 km/h', near(s, 60, 3), s.toFixed(1));
ok('no dt = 0', speedKmh({lat:0,lng:0,t:100},{lat:1,lng:1,t:100}) === 0);

// ── Detection state machine: a simulated 30-min drive ────────────────────────
console.log('Trip detection — simulated 30-min home→worksite drive');
// Build a fix every 30s driving north ~0.0009°(=100m)/30s = ~12 km/h... too slow.
// Use ~0.0027°/30s ≈ 300m/30s = 36 km/h. 30 min = 60 fixes.
function drive(){
  const fixes = [];
  let lat = -28.650, lng = 151.930, t = 0;
  // 2 min of pre-trip idle (parked) — should NOT start a trip
  for(let i=0;i<4;i++){ fixes.push({lat,lng,t,acc:8}); t+=30000; }
  // ~30 min driving north at ~36 km/h (0.0027°/30s)
  for(let i=0;i<60;i++){ lat -= 0.0027; fixes.push({lat,lng,t,acc:8}); t+=30000; }
  // 6 min stopped at destination → triggers stop
  for(let i=0;i<12;i++){ fixes.push({lat,lng,t,acc:8}); t+=30000; }
  return fixes;
}
const detected = detectTripsFromFixes(drive(), TRIP_CFG);
ok('exactly 1 trip detected', detected.length === 1, 'got '+detected.length);
if(detected[0]){
  const km = detected[0].distance_km;
  // 60 legs × ~300m ≈ 18 km
  ok('distance ≈ 18 km (16–20)', km >= 16 && km <= 20, km+'km');
  ok('duration ≈ 30 min (25–40)', detected[0].duration_min >= 25 && detected[0].duration_min <= 40, detected[0].duration_min+'min');
  ok('has start+end coords', detected[0].start_lat!=null && detected[0].end_lat!=null);
}

console.log('Trip detection — parked all day (no movement)');
function parked(){ const f=[]; let t=0; for(let i=0;i<200;i++){ f.push({lat:-28.65,lng:151.93,t,acc:8}); t+=30000; } return f; }
ok('no trips from a stationary phone', detectTripsFromFixes(parked(), TRIP_CFG).length === 0);

console.log('Trip detection — poor-accuracy fixes rejected for geometry');
// Same drive but every fix has acc 80 (> maxAccM 50) → no polyline points → no trip
function badAcc(){ return drive().map(f=>({...f,acc:80})); }
ok('all >50m acc → 0 trips', detectTripsFromFixes(badAcc(), TRIP_CFG).length === 0);

// ── Weekly aggregation ───────────────────────────────────────────────────────
console.log('Weekly aggregation over 3 days');
const week = [
  {date:'2026-06-29',category:'business',distance_km:20,duration_min:30},
  {date:'2026-06-29',category:'personal',distance_km:5, duration_min:12},
  {date:'2026-06-30',category:'business',distance_km:15,duration_min:22},
  {date:'2026-07-01',category:'commute', distance_km:10,duration_min:18},
  {date:'2026-07-01',category:'business',distance_km:30,duration_min:40},
];
const agg = aggregateTrips(week);
ok('total km = 80', agg.totalKm === 80, agg.totalKm);
ok('business km = 65', agg.byCat.business.km === 65, agg.byCat.business.km);
ok('personal km = 5', agg.byCat.personal.km === 5);
ok('commute km = 10', agg.byCat.commute.km === 10);
ok('count = 5', agg.count === 5);
ok('days driven = 3', agg.daysDriven === 3, agg.daysDriven);
ok('avg km = 16', agg.avgKm === 16, agg.avgKm);

console.log('\n'+(fail===0?'✅ ALL PASS':'❌ FAIL')+`  (${pass} passed, ${fail} failed)`);
process.exit(fail===0?0:1);
