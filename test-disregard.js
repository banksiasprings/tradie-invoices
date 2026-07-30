#!/usr/bin/env node
/*
 * test-disregard.js — v104.6 delete a trip, and "don't record trips here" zones.
 *
 * Steven: "when I'm driving around at home, it's also doing that, but I've got
 * no way to disregard it or delete it … unless I put a circle around home and
 * you can disregard a lot as well … it'd be nice to be able to delete if I
 * think it's not applicable."
 *
 * Two fixes, pinned here:
 *   - deleteTripFrom()      — remove a trip outright (Skip keeps it; this doesn't)
 *   - `disregard` zones     — a trip wholly inside one is kept out of the log
 *
 * Synthetic coordinates — this repo is PUBLIC.
 *
 * Run:  node test-disregard.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
function extract(start, end) {
  const m = html.match(new RegExp('\\/\\/' + start + '[^\\n]*\\n([\\s\\S]*?)\\/\\/' + end));
  if (!m) { console.error('✗ could not find ' + start); process.exit(2); }
  return m[1];
}
// The disregard classifier lives in the trip-log block but leans on the zone
// vocabulary, so both blocks are needed — the same pairing test-loads.js uses.
const api = new Function(
  extract('__V102_TRIPLOG_PURE_START__', '__V102_TRIPLOG_PURE_END__') + '\n' +
  extract('__V102_CIRCUIT_PURE_START__', '__V102_CIRCUIT_PURE_END__') + `
return {classifyDisregard, applyDisregardFlags, isDisregarded, disregardLocked, undisregardTrip,
        deleteTripFrom, filterTripsBy, buildDayStrip, periodSummary, isIntraSite,
        applyIntraSiteFlags, TRIP_DISREGARD_CFG, TRIP_INTRA_SITE_CFG,
        ZONE_MODES, zoneMode, zonesOfMode, isDetectionMode, zoneOverlapVerdict,
        zoneVisitsFromFixes, circuitsFromFixes, subSessionsFromFixes, CIRCUIT_CFG};`)();
const { classifyDisregard, applyDisregardFlags, isDisregarded, disregardLocked, undisregardTrip,
        deleteTripFrom, filterTripsBy, buildDayStrip, periodSummary, isIntraSite,
        applyIntraSiteFlags, TRIP_DISREGARD_CFG, TRIP_INTRA_SITE_CFG,
        ZONE_MODES, zoneMode, zonesOfMode, isDetectionMode, zoneOverlapVerdict,
        zoneVisitsFromFixes, circuitsFromFixes, subSessionsFromFixes, CIRCUIT_CFG } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

const M = 111320;
const HOME = { id: 'zh', name: 'Home', mode: 'disregard', lat: -28.400, lng: 151.800, radius: 400 };
const SITE = { id: 's1', name: 'Lucas Ranch', lat: -28.700, lng: 152.000, radius: 2900 };
const T0 = Date.parse('2026-07-30T08:00:00');

// A trip is judged on its polyline; endpoints alone if it has none.
function trip(id, pts, extra) {
  return Object.assign({
    id: id, date: '2026-07-30', category: 'unknown',
    start_time: T0, end_time: T0 + 600000, distance_km: 2.4, duration_min: 10,
    polyline: pts.map((p, i) => ({ lat: p[0], lng: p[1], t: T0 + i * 60000 }))
  }, extra || {});
}
const near = (z, dn, de) => [z.lat + dn / M, z.lng + de / M];

// Pottering around the house — every point inside the home circle.
const AT_HOME = trip('t-home', [near(HOME, 0, 0), near(HOME, 120, 40), near(HOME, -80, -150), near(HOME, 30, 60)]);
// A real drive that starts at home and leaves.
const HOME_TO_TOWN = trip('t-town', [near(HOME, 0, 0), near(HOME, 300, 0), near(HOME, 1200, 0), near(HOME, 4000, 0)]);
// A trip nowhere near home.
const ELSEWHERE = trip('t-else', [[-28.7, 152.0], [-28.71, 152.01]]);

console.log('── PIN: test_disregard_zone_filters_trips_entirely_within_it ──');
{
  const c = classifyDisregard(AT_HOME, [HOME], TRIP_DISREGARD_CFG);
  ok('PIN: a trip entirely inside the home circle is disregarded', c.disregard === true, c);
  ok('PIN: …and names the zone that caught it', c.zone_id === 'zh' && c.zone_name === 'Home', c);
  ok('PIN: a trip that leaves the circle is NOT disregarded',
     classifyDisregard(HOME_TO_TOWN, [HOME], TRIP_DISREGARD_CFG).disregard === false);
  ok('PIN: a trip nowhere near it is NOT disregarded',
     classifyDisregard(ELSEWHERE, [HOME], TRIP_DISREGARD_CFG).disregard === false);

  const res = applyDisregardFlags([AT_HOME, HOME_TO_TOWN, ELSEWHERE], [HOME], TRIP_DISREGARD_CFG);
  ok('PIN: exactly one of the three is flagged', res.changed === 1, res.changed);
  ok('PIN: …the home one', isDisregarded(res.trips[0]) === true);
  ok('PIN: …and the other two are byte-identical objects',
     res.trips[1] === HOME_TO_TOWN && res.trips[2] === ELSEWHERE);

  // The headline behaviour: it vanishes from the log.
  const shown = filterTripsBy(res.trips, 'all');
  ok('PIN: the disregarded trip is OUT of the default Trip Log view',
     shown.length === 2 && !shown.some(isDisregarded), shown.map(t => t.id));
  ok('PIN: …out of Business only', filterTripsBy(res.trips, 'business').every(t => !isDisregarded(t)));
  ok('PIN: …out of Private only', filterTripsBy(res.trips, 'private').every(t => !isDisregarded(t)));
  ok('PIN: …out of Needs review', filterTripsBy(res.trips, 'pending').every(t => !isDisregarded(t)));
  ok('PIN: …out of On-site movement', filterTripsBy(res.trips, 'onsite').every(t => !isDisregarded(t)));
  // But never unreachable — a too-big circle must be discoverable.
  const only = filterTripsBy(res.trips, 'disregarded');
  ok('PIN: …but visible in its own filter, so a too-big circle can be found',
     only.length === 1 && only[0].id === 't-home', only.map(t => t.id));
  // TL_FILTERS lives in the impure screen module, so it is checked in source.
  ok('PIN: the filter rail offers that view', /\{k:'disregarded'/.test(html));

  // And it leaves the km maths entirely.
  const rows = buildDayStrip(filterTripsBy(res.trips, 'all'), '2026-07');
  const sum = periodSummary(rows);
  ok('PIN: it contributes no km', sum.totalKm === 4.8, sum.totalKm);
  ok('PIN: …and nothing to review', sum.pending === 2, sum.pending);
  const allRows = buildDayStrip(res.trips, '2026-07');
  ok('PIN: (unfiltered it would have counted 7.2km — so the filter is doing the work)',
     periodSummary(allRows).totalKm === 7.2, periodSummary(allRows).totalKm);
}

console.log('\nA day of nothing but home pottering disappears entirely');
{
  const res = applyDisregardFlags([AT_HOME], [HOME], TRIP_DISREGARD_CFG);
  const rows = buildDayStrip(filterTripsBy(res.trips, 'all'), '2026-07');
  ok('no day chip is driven', periodSummary(rows).daysDriven === 0);
  ok('…and no trips counted', periodSummary(rows).trips === 0);
}

console.log('\nThe escape hatch — a circle drawn too big');
{
  const flagged = applyDisregardFlags([HOME_TO_TOWN], [Object.assign({}, HOME, { radius: 5000 })], TRIP_DISREGARD_CFG);
  ok('an over-large circle does swallow a real trip', isDisregarded(flagged.trips[0]) === true);
  const back = undisregardTrip(flagged.trips[0]);
  ok('…the user can put it back', isDisregarded(back) === false);
  ok('…and it is locked against re-classification', disregardLocked(back) === true);
  const again = applyDisregardFlags([back], [Object.assign({}, HOME, { radius: 5000 })], TRIP_DISREGARD_CFG);
  ok('…so a re-render never re-hides it', isDisregarded(again.trips[0]) === false && again.changed === 0);
  ok('…and the original object is never mutated', HOME_TO_TOWN.disregarded === undefined);
}

console.log('\nClassification edge cases');
ok('no disregard zones defined → nothing is disregarded',
   classifyDisregard(AT_HOME, [], TRIP_DISREGARD_CFG).disregard === false);
ok('null zone list is safe', classifyDisregard(AT_HOME, null, TRIP_DISREGARD_CFG).disregard === false);
ok('a trip with no positions is never disregarded (fail open)',
   classifyDisregard(trip('t-empty', []), [HOME], TRIP_DISREGARD_CFG).disregard === false);
ok('…and says why', /no positions/.test(classifyDisregard(trip('t-empty', []), [HOME], TRIP_DISREGARD_CFG).reason));
ok('a zone with no coordinates is skipped',
   classifyDisregard(AT_HOME, [{ id: 'x', name: 'broken', mode: 'disregard' }], TRIP_DISREGARD_CFG).disregard === false);
ok('a NON-disregard zone never disregards anything', classifyDisregard(AT_HOME,
   [{ id: 'zp', name: 'Pit', mode: 'circuit-pickup', lat: HOME.lat, lng: HOME.lng, radius: 400 }],
   TRIP_DISREGARD_CFG).disregard === false);
ok('boundary slack is applied, like intra-site',
   classifyDisregard(trip('t-edge', [near(HOME, 420, 0), near(HOME, 0, 0)]), [HOME], TRIP_DISREGARD_CFG).disregard === true);
ok('…but not without limit',
   classifyDisregard(trip('t-far', [near(HOME, 600, 0), near(HOME, 0, 0)]), [HOME], TRIP_DISREGARD_CFG).disregard === false);
ok('a trip must be inside ONE zone, not spread across two', (() => {
    const A = { id: 'a', name: 'A', mode: 'disregard', lat: -28.4, lng: 151.8, radius: 200 };
    const B = { id: 'b', name: 'B', mode: 'disregard', lat: -28.4 + 500 / M, lng: 151.8, radius: 200 };
    return classifyDisregard(trip('t2', [near(A, 0, 0), near(B, 0, 0)]), [A, B], TRIP_DISREGARD_CFG).disregard === false;
  })());

console.log('\n── PIN: test_trip_row_long_press_delete_removes_from_log ──────');
{
  const list = [AT_HOME, HOME_TO_TOWN, ELSEWHERE];
  const after = deleteTripFrom(list, 't-town');
  ok('PIN: the trip is gone', after.length === 2 && !after.some(t => t.id === 't-town'), after.map(t => t.id));
  ok('PIN: the others are untouched', after[0] === AT_HOME && after[1] === ELSEWHERE);
  ok('PIN: the input array is not mutated', list.length === 3);
  ok('PIN: deleting is different from skipping — skip KEEPS the trip', (() => {
      // clearTripCategory (Skip) leaves the record in place; delete removes it.
      return deleteTripFrom(list, 't-home').length === 2 && list.length === 3;
    })());
  ok('PIN: an unknown id removes nothing', deleteTripFrom(list, 'nope').length === 3);
  ok('PIN: a null list is safe', deleteTripFrom(null, 'x').length === 0);
  ok('PIN: holes in the list do not throw', deleteTripFrom([null, AT_HOME], 't-home').length === 1);
  ok('PIN: it removes from the log the UI reads',
     filterTripsBy(deleteTripFrom(list, 't-else'), 'all').every(t => t.id !== 't-else'));
}

console.log('\nDisregard zones do not interfere with circuits or sub-activities');
{
  const PIT = { id: 'zp', name: 'Pit', mode: 'circuit-pickup', lat: -28.500, lng: 151.900, radius: 100 };
  const TIP = { id: 'zt', name: 'Tip', mode: 'circuit-dump', lat: -28.489, lng: 151.900, radius: 100 };
  // A home circle deliberately sitting right on top of the pit — the nastiest case.
  const OVER = { id: 'zo', name: 'Home', mode: 'disregard', lat: -28.500, lng: 151.900, radius: 800 };
  ok('a disregard zone is not a detection mode', isDetectionMode(ZONE_MODES.DISREGARD) === false);
  ok('…while pickup/dump/sub are', ['circuit-pickup', 'circuit-dump', 'sub_activity'].every(isDetectionMode));

  const at = (z, m, s) => ({ lat: z.lat + m / M, lng: z.lng, t: T0 + s * 1000 });
  const mid = s => ({ lat: (PIT.lat + TIP.lat) / 2, lng: PIT.lng, t: T0 + s * 1000 });
  const fx = []; let t = 0;
  for (let i = 0; i < 2; i++) {
    fx.push(at(PIT, 0, t), at(PIT, 5, t + 60)); fx.push(mid(t + 120));
    fx.push(at(TIP, 0, t + 180), at(TIP, 5, t + 240)); fx.push(mid(t + 300));
    t += 360;
  }
  fx.push(at(PIT, 0, t), at(PIT, 5, t + 60));

  const without = circuitsFromFixes(fx, [PIT, TIP], CIRCUIT_CFG);
  const with_ = circuitsFromFixes(fx, [PIT, TIP, OVER], CIRCUIT_CFG);
  ok('circuits record the same with a home zone sitting over the pit',
     with_.circuits.length === without.circuits.length && with_.circuits.length === 2,
     { without: without.circuits.length, with: with_.circuits.length });
  ok('…identical durations, so it steals no fixes',
     JSON.stringify(with_.circuits.map(c => c.duration_s)) === JSON.stringify(without.circuits.map(c => c.duration_s)));
  ok('…and never appears in the visit stream at all',
     zoneVisitsFromFixes(fx, [PIT, TIP, OVER], CIRCUIT_CFG).every(v => v.zone_id !== 'zo'));
  const SHED = { id: 'zs', name: 'Shed', mode: 'sub_activity', lat: -28.4805, lng: 151.9, radius: 60 };
  ok('sub-activity detection is likewise unaffected', (() => {
      const f2 = []; for (let s = 0; s <= 600; s += 60) f2.push({ lat: SHED.lat, lng: SHED.lng, t: T0 + s * 1000 });
      f2.push({ lat: -28.6, lng: 152.1, t: T0 + 900000 });
      const a = subSessionsFromFixes(f2, [SHED], CIRCUIT_CFG).sessions.length;
      const b = subSessionsFromFixes(f2, [SHED, OVER], CIRCUIT_CFG).sessions.length;
      return a === b && a === 1;
    })());

  console.log('\n  …and are exempt from the v104.5 overlap rules');
  ok('a home circle may be placed over a pickup zone',
     zoneOverlapVerdict(PIT.lat, PIT.lng, 800, [PIT, TIP], ZONE_MODES.DISREGARD).ok === true);
  ok('…and an existing home circle never blocks a new pickup zone',
     zoneOverlapVerdict(PIT.lat, PIT.lng, 100, [OVER], ZONE_MODES.PICKUP).ok === true);
  ok('while real activity zones are still policed',
     zoneOverlapVerdict(PIT.lat + 120 / M, PIT.lng, 100, [PIT], ZONE_MODES.DUMP).ok === false);
}

console.log('\nWork-site auto-skip (intra-site) still works — no regression');
{
  const inYard = trip('t-yard', [[SITE.lat, SITE.lng], [SITE.lat + 300 / M, SITE.lng], [SITE.lat, SITE.lng + 200 / M]]);
  const r = applyIntraSiteFlags([inYard], [SITE], TRIP_INTRA_SITE_CFG);
  ok('a trip inside the work site is still on-site movement', isIntraSite(r.trips[0]) === true);
  ok('…and is still SHOWN, not deleted', filterTripsBy(r.trips, 'onsite').length === 1);
  ok('…and still excluded from travel km', periodSummary(buildDayStrip(r.trips, '2026-07')).totalKm === 0);
  ok('a disregard zone does not make it disappear instead',
     applyDisregardFlags(r.trips, [HOME], TRIP_DISREGARD_CFG).changed === 0);
  // Order of precedence: disregard beats on-site, because "don't record" is the
  // stronger instruction and filterTripsBy drops it before anything else looks.
  const both = applyDisregardFlags(
    applyIntraSiteFlags([trip('t-both', [near(HOME, 0, 0), near(HOME, 50, 50)])],
      [{ id: 's2', name: 'Home paddock', lat: HOME.lat, lng: HOME.lng, radius: 900 }], TRIP_INTRA_SITE_CFG).trips,
    [HOME], TRIP_DISREGARD_CFG);
  ok('a trip that is BOTH on-site and disregarded is treated as disregarded',
     isIntraSite(both.trips[0]) === true && isDisregarded(both.trips[0]) === true &&
     filterTripsBy(both.trips, 'onsite').length === 0 &&
     filterTripsBy(both.trips, 'disregarded').length === 1);
}

console.log('\nZone vocabulary');
ok('the mode is named "disregard"', ZONE_MODES.DISREGARD === 'disregard');
ok('zoneMode resolves it', zoneMode(HOME) === 'disregard');
ok('zonesOfMode selects it', zonesOfMode([HOME, { id: 'x', mode: 'circuit-dump' }], ZONE_MODES.DISREGARD).length === 1);
ok('the Zones card has a button for it', /czSetMode\('disregard'\)/.test(html));
ok('…and a human label', /Don&#39;t record|Don't record trips here/.test(html));

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
