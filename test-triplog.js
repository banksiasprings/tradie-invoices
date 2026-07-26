#!/usr/bin/env node
/*
 * test-triplog.js — unit tests for the v101.6 PURE logic.
 *
 * Extracts the //__V100_TRIP_PURE_*__ and //__V101_6_PURE_*__ blocks VERBATIM
 * from www/index.html and exercises the shipped source (no copy, no drift).
 *
 * Covers the three field bugs found on 2026-07-27 from the mirrored Firestore
 * telemetry (see NIGHT_LOG 2026-07-27):
 *
 *   1. STUCK activeDay — Steven's phone carried an activeDay started
 *      2026-07-12 08:30 AEST with finish:null for 15 days. checkNearbySites()
 *      gates auto-START on !activeDay(), so nothing could ever auto-start again.
 *      isStaleActiveDay() is the predicate that unblocks it.
 *
 *   2. TRIP CAPTURE DIED WITH THE ACTIVITY — the BackgroundGeolocation plugin
 *      stops its own foreground service in handleOnDestroy(), and Steven's Moto
 *      destroys MainActivity the moment the app is backgrounded. Trip capture
 *      moves to an app-owned native service that BANKS FIXES; JS reconstructs
 *      trips from that banked stream via reconstructTripsFromFixes().
 *
 *   3. GeoLog filed entries under a UTC date but a LOCAL time, so every
 *      Brisbane morning before 10:00 landed in the PREVIOUS day's bucket —
 *      both in-app and in the Firestore mirror. geoLogDateOf() fixes it.
 *
 * TZ is forced to Australia/Brisbane (Steven's zone) so the UTC-vs-local
 * assertions are meaningful. Pure logic → sub-second, no emulator.
 *
 * Run:  node test-triplog.js
 */
process.env.TZ = 'Australia/Brisbane';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');

function extract(startMarker, endMarker, label) {
  const re = new RegExp('\\/\\/__' + startMarker + '__[^\\n]*\\n([\\s\\S]*?)\\/\\/__' + endMarker + '__');
  const m = html.match(re);
  if (!m) { console.error('✗ could not find ' + label + ' markers in www/index.html'); process.exit(2); }
  return m[1];
}

const v100 = extract('V100_TRIP_PURE_START', 'V100_TRIP_PURE_END', 'v100 trip pure');
const v1016 = extract('V101_6_PURE_START', 'V101_6_PURE_END', 'v101.6 pure');

const PRELUDE = "var TRIP_CATS=['business','personal','commute','mixed','unknown'];\n";
const api = new Function(
  PRELUDE + v100 + '\n' + v1016 +
  '\nreturn {detectTripsFromFixes,TRIP_CFG,isStaleActiveDay,STALE_ACTIVE_DAY_H,' +
  'reconstructTripsFromFixes,TRIP_FIX_SETTLE_MS,bankedTripId,geoLogDateOf};'
)();
const {
  detectTripsFromFixes, TRIP_CFG,
  isStaleActiveDay, STALE_ACTIVE_DAY_H,
  reconstructTripsFromFixes, TRIP_FIX_SETTLE_MS, bankedTripId, geoLogDateOf,
} = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + extra) : '')); }
}
const H = 3600000;

// ═══════════════════════════════════════════════════════════════════════════
// 1. isStaleActiveDay — the stuck-timer / blocked-auto-start bug
// ═══════════════════════════════════════════════════════════════════════════
console.log('isStaleActiveDay — stuck activeDay blocks every later auto-start');

// REGRESSION PIN: Steven's actual field record, read out of Firestore
// users/{uid}/data/activeDay on 2026-07-27. startTs is the real value.
const STUCK = {
  id: 'mridhdq89hyul', site: 'Lds', start: '08:30', date: '2026-07-12',
  startTs: 1783809047318, finish: null, finishTs: null, rate: 60,
  status: 'UNCONFIRMED', merged: true,
};
const NOW_2026_07_27 = Date.parse('2026-07-27T09:00:00+10:00');
ok('PIN: real 15-day stuck activeDay (Lds, 12 Jul) is stale',
   isStaleActiveDay(STUCK, NOW_2026_07_27) === true);

// Must NOT seal anything that could be a real running shift.
const base = (hoursAgo) => ({ id: 'x', site: 'Lucas Ranch', start: '07:00',
  date: '2026-07-27', startTs: NOW_2026_07_27 - hoursAgo * H, finish: null });

ok('a session started 3h ago is NOT stale', isStaleActiveDay(base(3), NOW_2026_07_27) === false);
ok('a 14h shift is NOT stale (long day, still legit)', isStaleActiveDay(base(14), NOW_2026_07_27) === false);
ok('a 19h shift is NOT stale (just under threshold)', isStaleActiveDay(base(19), NOW_2026_07_27) === false);
ok('boundary: 19.9h NOT stale', isStaleActiveDay(base(19.9), NOW_2026_07_27) === false);
ok('boundary: 20.1h IS stale', isStaleActiveDay(base(20.1), NOW_2026_07_27) === true);
ok('threshold constant is 20h', STALE_ACTIVE_DAY_H === 20, STALE_ACTIVE_DAY_H);
ok('explicit thresholdH override honoured', isStaleActiveDay(base(5), NOW_2026_07_27, 4) === true);

// Records the seal path must never touch.
const finished = Object.assign({}, base(30), { finish: '15:30' });
ok('an activeDay WITH finish is NOT stale (seal path owns it)',
   isStaleActiveDay(finished, NOW_2026_07_27) === false);
ok('null activeDay is not stale', isStaleActiveDay(null, NOW_2026_07_27) === false);
ok('missing startTs is not stale (malformed — leave it alone)',
   isStaleActiveDay({ id: 'y', site: 'A', finish: null }, NOW_2026_07_27) === false);
ok('future startTs (clock skew) is not stale',
   isStaleActiveDay(base(-5), NOW_2026_07_27) === false);

// ═══════════════════════════════════════════════════════════════════════════
// 2. reconstructTripsFromFixes — trips rebuilt from a natively-banked stream
// ═══════════════════════════════════════════════════════════════════════════
console.log('reconstructTripsFromFixes — rebuild trips from banked native fixes');

// One ~18km drive: 2min parked, ~30min at ~36km/h, then N minutes stopped.
function drive(t0, stopSamples) {
  const fixes = [];
  let lat = -28.650, lng = 151.930, t = t0;
  for (let i = 0; i < 4; i++) { fixes.push({ lat, lng, t, acc: 8 }); t += 30000; }
  for (let i = 0; i < 60; i++) { lat -= 0.0027; fixes.push({ lat, lng, t, acc: 8 }); t += 30000; }
  for (let i = 0; i < stopSamples; i++) { fixes.push({ lat, lng, t, acc: 8 }); t += 30000; }
  return fixes;
}

// (a) COLD stream — phone parked for hours, then the app is opened.
const t0 = Date.parse('2026-07-20T07:00:00+10:00');
const coldFixes = drive(t0, 12);                       // 6 min stopped → trip closes
const coldNow = coldFixes[coldFixes.length - 1].t + 3 * H;
const cold = reconstructTripsFromFixes(coldFixes, TRIP_CFG, coldNow);
ok('cold stream → 1 completed trip', cold.trips.length === 1, cold.trips.length);
ok('cold stream → no carry (nothing in progress)', cold.carry === null);
if (cold.trips[0]) {
  ok('trip distance ≈ 18km', cold.trips[0].distance_km >= 16 && cold.trips[0].distance_km <= 20,
     cold.trips[0].distance_km);
  ok('trip carries start_time', typeof cold.trips[0].start_time === 'number');
  ok('trip carries end_time', typeof cold.trips[0].end_time === 'number');
  ok('end_time is after start_time', cold.trips[0].end_time > cold.trips[0].start_time);
}

// (b) WARM stream, still moving — the last trip must be carried, not force-closed.
const warmFixes = drive(t0, 0);                        // stream ends mid-drive
const warmNow = warmFixes[warmFixes.length - 1].t + 60000;   // fix 1 min ago
const warm = reconstructTripsFromFixes(warmFixes, TRIP_CFG, warmNow);
ok('warm mid-drive stream → 0 completed trips', warm.trips.length === 0, warm.trips.length);
ok('warm mid-drive stream → carries the open trip', warm.carry !== null);

// (c) WARM stream but the trip genuinely ENDED (stopped 6 min, recent fix).
// Precision check: warmth alone must not turn a finished trip into a carry.
const warmDoneFixes = drive(t0, 12);
const warmDoneNow = warmDoneFixes[warmDoneFixes.length - 1].t + 60000;
const warmDone = reconstructTripsFromFixes(warmDoneFixes, TRIP_CFG, warmDoneNow);
ok('warm but genuinely-stopped stream → 1 completed trip', warmDone.trips.length === 1, warmDone.trips.length);
ok('warm but genuinely-stopped stream → no carry', warmDone.carry === null);

// (d) MULTI-DAY banked stream — the "app was dead for a week" case. This is the
// whole point of banking fixes natively instead of relying on a JS watcher.
const d1 = Date.parse('2026-07-20T07:00:00+10:00');
const d2 = Date.parse('2026-07-21T07:00:00+10:00');
const d3 = Date.parse('2026-07-22T07:00:00+10:00');
const multi = drive(d1, 12).concat(drive(d2, 12), drive(d3, 12));
const multiNow = d3 + 12 * H;
const multiOut = reconstructTripsFromFixes(multi, TRIP_CFG, multiNow);
ok('3 days of banked driving → 3 trips', multiOut.trips.length === 3, multiOut.trips.length);
ok('3-day stream → no carry', multiOut.carry === null);

// (e) Poor accuracy: rural fused-location garbage must not fabricate trips.
const badAcc = drive(t0, 12).map(f => Object.assign({}, f, { acc: 400 }));
const bad = reconstructTripsFromFixes(badAcc, TRIP_CFG, coldNow);
ok('all-poor-accuracy stream → 0 trips', bad.trips.length === 0, bad.trips.length);
ok('all-poor-accuracy stream → no carry', bad.carry === null);

// (f) Robustness — the native queue gives no ordering guarantee.
const shuffled = drive(t0, 12).slice().reverse();
const shuf = reconstructTripsFromFixes(shuffled, TRIP_CFG, coldNow);
ok('out-of-order fixes are sorted → still 1 trip', shuf.trips.length === 1, shuf.trips.length);

ok('empty stream → no trips, no carry, no throw',
   (() => { const r = reconstructTripsFromFixes([], TRIP_CFG, coldNow);
            return r.trips.length === 0 && r.carry === null; })());
ok('null stream → no trips, no carry, no throw',
   (() => { const r = reconstructTripsFromFixes(null, TRIP_CFG, coldNow);
            return r.trips.length === 0 && r.carry === null; })());
ok('fixes missing t are dropped, not crashed',
   (() => { const r = reconstructTripsFromFixes(
              [{ lat: -28.6, lng: 151.9 }, { lat: -28.6, lng: 151.9, t: t0, acc: 5 }], TRIP_CFG, coldNow);
            return r.trips.length === 0 && r.carry === null; })());

// (g) Idempotent replay — a re-drain of overlapping fixes must not double-log.
console.log('bankedTripId — deterministic ids make replay idempotent');
const run1 = reconstructTripsFromFixes(coldFixes, TRIP_CFG, coldNow);
const run2 = reconstructTripsFromFixes(coldFixes, TRIP_CFG, coldNow);
ok('same stream → identical trip id on replay',
   bankedTripId(run1.trips[0].start_time) === bankedTripId(run2.trips[0].start_time),
   bankedTripId(run1.trips[0].start_time));
ok('different start → different id', bankedTripId(1000) !== bankedTripId(2000));
ok('id is a stable string', typeof bankedTripId(1783809047318) === 'string');

// ═══════════════════════════════════════════════════════════════════════════
// 3. geoLogDateOf — the UTC-date / local-time mismatch
// ═══════════════════════════════════════════════════════════════════════════
console.log('geoLogDateOf — GeoLog must file entries under the LOCAL date');

function localFmt(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

// REGRESSION PIN: the real entry that exposed it. 13 Jul 08:36 AEST is
// 12 Jul 22:36 UTC, so the old code filed the whole morning under 2026-07-12.
const morning = new Date('2026-07-13T08:36:13+10:00');
ok('PIN: 13 Jul 08:36 AEST files under 2026-07-13 (not -07-12)',
   geoLogDateOf(morning) === '2026-07-13', geoLogDateOf(morning));
ok('PIN: the old UTC formatting really did differ',
   morning.toISOString().slice(0, 10) === '2026-07-12', morning.toISOString().slice(0, 10));

// Any Brisbane time before 10:00 is on the previous UTC day — the whole
// working-morning window, which is exactly when the app gets opened.
['00:30', '05:00', '07:00', '09:59'].forEach(hhmm => {
  const d = new Date('2026-07-13T' + hhmm + ':00+10:00');
  ok('local date correct at ' + hhmm + ' AEST', geoLogDateOf(d) === '2026-07-13', geoLogDateOf(d));
});
// …and afternoons must not regress.
['10:00', '15:30', '23:59'].forEach(hhmm => {
  const d = new Date('2026-07-13T' + hhmm + ':00+10:00');
  ok('local date correct at ' + hhmm + ' AEST', geoLogDateOf(d) === '2026-07-13', geoLogDateOf(d));
});
ok('agrees with the local-component format used by todayStr()',
   geoLogDateOf(morning) === localFmt(morning));
ok('no-arg call uses now (returns a YYYY-MM-DD string)',
   /^\d{4}-\d{2}-\d{2}$/.test(geoLogDateOf()));

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
