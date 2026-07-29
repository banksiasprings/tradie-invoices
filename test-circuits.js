#!/usr/bin/env node
/*
 * test-circuits.js — v102.0 circuit timer (pickup -> dump -> pickup cycles).
 *
 * Extracts the //__V102_CIRCUIT_PURE_START__ / __V102_CIRCUIT_PURE_END__ block
 * AND the //__V102_TRIPLOG_PURE_*__ block (for pointInFence / _fenceHaversine,
 * which the circuit code deliberately reuses) VERBATIM from www/index.html.
 *
 * Fixtures are synthetic GPS breadcrumbs over a synthetic pit and tip — this
 * repo is PUBLIC, so no real coordinates appear here.
 *
 * Run:  node test-circuits.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
function extract(start, end) {
  const m = html.match(new RegExp('\\/\\/' + start + '[^\\n]*\\n([\\s\\S]*?)\\/\\/' + end));
  if (!m) { console.error('✗ could not find ' + start + ' in www/index.html'); process.exit(2); }
  return m[1];
}
const api = new Function(
  extract('__V102_TRIPLOG_PURE_START__', '__V102_TRIPLOG_PURE_END__') + '\n' +
  extract('__V102_CIRCUIT_PURE_START__', '__V102_CIRCUIT_PURE_END__') + `
return {CIRCUIT_CFG, zoneOfPoint, zoneVisitsFromFixes, circuitsFromVisits,
        circuitsFromFixes, circuitStats, fmtCircuitDur, circuitDateOf, isStaleCircuit, pointInFence,
        ZONE_MODES, zoneMode, zonesOfMode, unusableZones, isCircuitMode};`)();
const { CIRCUIT_CFG, zoneOfPoint, zoneVisitsFromFixes, circuitsFromVisits,
        circuitsFromFixes, circuitStats, fmtCircuitDur, circuitDateOf, isStaleCircuit, pointInFence,
        ZONE_MODES, zoneMode, zonesOfMode, unusableZones, isCircuitMode } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

// ── Synthetic job: a pit and a tip 1.2 km apart ─────────────────────────────
const M_PER_DEG_LAT = 111320;
const PIT = { id: 'z1', name: 'Pit', kind: 'pickup', lat: -28.500, lng: 151.900, radius: 100 };
const TIP = { id: 'z2', name: 'Tip', kind: 'dump',   lat: -28.489, lng: 151.900, radius: 100 };
const ZONES = [PIT, TIP];

const T0 = Date.parse('2026-07-30T07:00:00');
// A fix `m` metres north of a zone centre, at t seconds after T0.
const at = (zone, m, t) => ({ lat: zone.lat + m / M_PER_DEG_LAT, lng: zone.lng, t: T0 + t * 1000 });
// Halfway between pit and tip — outside both.
const between = t => ({ lat: (PIT.lat + TIP.lat) / 2, lng: PIT.lng, t: T0 + t * 1000 });

console.log('Zone containment reuses the work-site fence test');
ok('a point at the pit centre is in the pit', zoneOfPoint(PIT.lat, PIT.lng, ZONES).id === 'z1');
ok('a point at the tip centre is in the tip', zoneOfPoint(TIP.lat, TIP.lng, ZONES).id === 'z2');
ok('90 m out is still inside a 100 m zone', zoneOfPoint(at(PIT, 90, 0).lat, PIT.lng, ZONES).id === 'z1');
ok('110 m out is inside via the 15 m slack', zoneOfPoint(at(PIT, 110, 0).lat, PIT.lng, ZONES).id === 'z1');
ok('130 m out is outside', zoneOfPoint(at(PIT, 130, 0).lat, PIT.lng, ZONES) === null);
ok('halfway between the zones is in neither', zoneOfPoint(between(0).lat, between(0).lng, ZONES) === null);
ok('no zones configured = never inside', zoneOfPoint(PIT.lat, PIT.lng, []) === null);
ok('a zone with no coordinates is skipped',
   zoneOfPoint(PIT.lat, PIT.lng, [{ id: 'bad', name: 'x', kind: 'pickup' }]) === null);
ok('it agrees with pointInFence, the geofence timer’s own test',
   zoneOfPoint(at(PIT, 90, 0).lat, PIT.lng, ZONES) !== null ===
   pointInFence(at(PIT, 90, 0).lat, PIT.lng, PIT, 15));
// Overlapping zones: nearest centre wins, so a decision is never ambiguous.
const OVERLAP = [PIT, { id: 'z3', name: 'Pit edge', kind: 'dump', lat: PIT.lat + 0.0005, lng: PIT.lng, radius: 100 }];
ok('overlapping zones resolve to the nearer centre', zoneOfPoint(PIT.lat, PIT.lng, OVERLAP).id === 'z1');

// ── The canonical drive ──────────────────────────────────────────────────────
// Two full cycles, sampled every 30 s, exactly as TripLogService banks them:
//   07:00 arrive pit · load 3 min · haul 4 min · tip 2 min · return 4 min
//   07:13 arrive pit (closes circuit 1, opens circuit 2) · same again
//   07:26 arrive pit (closes circuit 2)
function drive() {
  const f = [];
  const push = (zone, from, to, step = 30) => {
    for (let t = from; t <= to; t += step) f.push(at(zone, 10, t));
  };
  const travel = (from, to, step = 30) => {
    for (let t = from; t <= to; t += step) f.push(between(t));
  };
  push(PIT, 0, 180);        // load 1
  travel(210, 390);         // haul 1
  push(TIP, 420, 540);      // tip 1
  travel(570, 750);         // return 1
  push(PIT, 780, 960);      // load 2  ← closes circuit 1
  travel(990, 1170);        // haul 2
  push(TIP, 1200, 1320);    // tip 2
  travel(1350, 1530);       // return 2
  push(PIT, 1560, 1740);    // load 3  ← closes circuit 2
  return f;
}
const FIXES = drive();

console.log('\nVisits');
const visits = zoneVisitsFromFixes(FIXES, ZONES);
ok('five zone visits: pit, tip, pit, tip, pit', visits.length === 5, visits.map(v => v.zone_name));
ok('…alternating pickup and dump',
   visits.map(v => v.kind).join(',') === 'pickup,dump,pickup,dump,pickup');
ok('the first visit starts at 07:00', visits[0].enter_ts === T0);
ok('…and lasts the 3 minutes he spent loading', (visits[0].exit_ts - visits[0].enter_ts) === 180000);
ok('fixes outside every zone produce no visit',
   zoneVisitsFromFixes([between(0), between(30)], ZONES).length === 0);
ok('an empty fix stream is not an error', zoneVisitsFromFixes([], ZONES).length === 0);
ok('null input is not an error', zoneVisitsFromFixes(null, ZONES).length === 0);
ok('fixes arriving out of order are sorted before pairing',
   zoneVisitsFromFixes(FIXES.slice().reverse(), ZONES).length === 5);

console.log('\nRegression pin: test_circuit_records_pickup_dump_pickup_pattern');
const r = circuitsFromFixes(FIXES, ZONES);
ok('two complete circuits recorded', r.circuits.length === 2, r.circuits.length);
const c1 = r.circuits[0];
ok('circuit 1 runs pit → tip', c1.pickup_name === 'Pit' && c1.dump_name === 'Tip');
ok('…starts when he arrived at the pit', c1.start_ts === T0);
ok('…ends when he got back to the pit', c1.end_ts === T0 + 780000);
ok('…total cycle time is 13 min', c1.duration_s === 780, c1.duration_s);
ok('…of which 3 min was loading', c1.load_s === 180, c1.load_s);
ok('…4 min hauling out', c1.haul_s === 240, c1.haul_s);
ok('…2 min tipping', c1.dump_s === 120, c1.dump_s);
ok('…4 min driving back', c1.return_s === 240, c1.return_s);
ok('…and the parts add up to the whole',
   c1.load_s + c1.haul_s + c1.dump_s + c1.return_s === c1.duration_s);
ok('…two legs recorded', c1.legs.length === 2);
ok('…leg 1 is the loaded haul Pit → Tip',
   c1.legs[0].kind === 'haul' && c1.legs[0].from === 'Pit' && c1.legs[0].to === 'Tip' && c1.legs[0].duration_s === 240);
ok('…leg 2 is the empty return Tip → Pit',
   c1.legs[1].kind === 'return' && c1.legs[1].from === 'Tip' && c1.legs[1].to === 'Pit' && c1.legs[1].duration_s === 240);
// The closing arrival opens the next cycle — that is what makes back-to-back
// loads measurable with the driver touching nothing.
ok('circuit 2 starts exactly where circuit 1 ended', r.circuits[1].start_ts === c1.end_ts);
ok('circuit 2 is also 13 min', r.circuits[1].duration_s === 780);
ok('nothing was abandoned on a clean run', r.abandoned.length === 0, r.abandoned);
ok('no cycle is left open at the end of a clean run — the last pit arrival is one',
   r.open !== null && r.open.dump === null);

console.log('\nFalse positives: entering pickup but never reaching a dump');
// Specified fixture: he turns up at the pit, mucks about, leaves, comes back.
// No dump was ever reached, so there is no circuit to record.
const NO_DUMP = [
  at(PIT, 10, 0), at(PIT, 10, 60), at(PIT, 10, 120),
  between(180), between(240), between(300),
  at(PIT, 10, 360), at(PIT, 10, 420),
];
const nd = circuitsFromFixes(NO_DUMP, ZONES);
ok('no circuit recorded', nd.circuits.length === 0, nd.circuits);
ok('…and the false start is reported, not silently swallowed',
   nd.abandoned.length === 1 && nd.abandoned[0].reason === 'no_dump');
ok('…with a cycle still open (he is at the pit)', nd.open !== null);
ok('a dump visit with no preceding pickup records nothing',
   circuitsFromFixes([at(TIP, 10, 0), at(TIP, 10, 60)], ZONES).circuits.length === 0);
ok('driving only between the zones records nothing',
   circuitsFromFixes([between(0), between(60), between(120)], ZONES).circuits.length === 0);
ok('a single visit to the pit records nothing',
   circuitsFromFixes([at(PIT, 10, 0), at(PIT, 10, 60)], ZONES).circuits.length === 0);
ok('pit → tip with no return does NOT count as a circuit yet',
   circuitsFromFixes([at(PIT, 10, 0), at(PIT, 10, 60), between(120), at(TIP, 10, 180)], ZONES).circuits.length === 0);

console.log('\nGuards');
// Lunch: he leaves the tip, disappears for an hour, then comes back to the pit.
// That is not a 70-minute cycle — it is a break, and counting it would poison
// every average he looks at.
const LUNCH = [
  at(PIT, 10, 0), at(PIT, 10, 60),
  between(120), at(TIP, 10, 180), at(TIP, 10, 240),
  at(PIT, 10, 7500), at(PIT, 10, 7560),      // back 2h05 after the start
];
const lu = circuitsFromFixes(LUNCH, ZONES);
ok('an over-long cycle is not counted', lu.circuits.length === 0, lu.circuits.map(c => c.duration_s));
ok('…it is reported as abandoned instead',
   lu.abandoned.length === 1 && lu.abandoned[0].reason === 'too_long', lu.abandoned);
ok('…and the threshold is 2 hours', CIRCUIT_CFG.max_circuit_s === 7200);
// Just inside the limit still counts.
const OK_LONG = [
  at(PIT, 10, 0), at(PIT, 10, 60),
  between(120), at(TIP, 10, 180), at(TIP, 10, 240),
  at(PIT, 10, 7100), at(PIT, 10, 7160),
];
ok('a long-but-plausible cycle still counts', circuitsFromFixes(OK_LONG, ZONES).circuits.length === 1);

// Boundary flutter: GPS jitter must not read as leaving and returning.
const FLUTTER = [
  at(PIT, 10, 0), at(PIT, 130, 30), at(PIT, 10, 60), at(PIT, 10, 90),   // one blip outside
  between(150), at(TIP, 10, 240), at(TIP, 10, 300),
  between(360), at(PIT, 10, 450),
];
const fl = circuitsFromFixes(FLUTTER, ZONES);
ok('a one-fix jitter blip does not split the pit visit',
   fl.visits.filter(v => v.zone_id === 'z1')[0].merged === true);
ok('…so the circuit still records once', fl.circuits.length === 1, fl.circuits.length);
ok('…and starts from the original arrival, not the blip', fl.circuits[0].start_ts === T0);
// The merge window is a knob, not a law: with it off, the blip does split.
ok('with merging disabled the blip does split the visit',
   zoneVisitsFromFixes(FLUTTER, ZONES, { merge_gap_s: 0 }).filter(v => v.zone_id === 'z1').length > 2);
// min_dwell is off by default (record everything) but must work when set.
ok('min_dwell_s defaults to 0 — every entry counts, as specified', CIRCUIT_CFG.min_dwell_s === 0);
ok('raising min_dwell_s rejects a momentary touch',
   zoneVisitsFromFixes([at(PIT, 10, 0), between(30)], ZONES, { min_dwell_s: 60 }).length === 0);
ok('…while a real stop survives it',
   zoneVisitsFromFixes([at(PIT, 10, 0), at(PIT, 10, 120), between(150)], ZONES, { min_dwell_s: 60 }).length === 1);

console.log('\nMultiple pickup / dump zones');
const TIP2 = { id: 'z9', name: 'Far tip', kind: 'dump', lat: -28.470, lng: 151.900, radius: 100 };
const MULTI = [
  at(PIT, 10, 0), at(PIT, 10, 60), between(120),
  at(TIP, 10, 180), at(TIP, 10, 240), between(300),
  at(PIT, 10, 360), at(PIT, 10, 420), between(480),
  at(TIP2, 10, 540), at(TIP2, 10, 600), between(660),
  at(PIT, 10, 720),
];
const mu = circuitsFromFixes(MULTI, [PIT, TIP, TIP2]);
ok('two circuits to two different tips', mu.circuits.length === 2);
ok('…each records the tip it actually went to',
   mu.circuits[0].dump_name === 'Tip' && mu.circuits[1].dump_name === 'Far tip',
   mu.circuits.map(c => c.dump_name));

console.log('\nStats');
const st = circuitStats(r.circuits);
ok('one pickup→dump pair', st.length === 1);
ok('…named for the run', st[0].pair === 'Pit → Tip');
ok('…counting both circuits', st[0].count === 2);
ok('…average 13 min', st[0].avgS === 780);
ok('…fastest 13 min', st[0].fastestS === 780);
ok('…slowest 13 min', st[0].slowestS === 780);
ok('…with the phase averages Steven can act on',
   st[0].avgLoadS === 180 && st[0].avgHaulS === 240 && st[0].avgDumpS === 120 && st[0].avgReturnS === 240);
ok('internal accumulators are not leaked into the result', st[0]._load === undefined);
const mixed = circuitStats([
  { pickup_name: 'Pit', dump_name: 'Tip', duration_s: 600, load_s: 100, haul_s: 200, dump_s: 100, return_s: 200 },
  { pickup_name: 'Pit', dump_name: 'Tip', duration_s: 900, load_s: 200, haul_s: 250, dump_s: 150, return_s: 300 },
  { pickup_name: 'Pit', dump_name: 'Far tip', duration_s: 1200, load_s: 100, haul_s: 500, dump_s: 100, return_s: 500 },
]);
ok('separate pairs are reported separately', mixed.length === 2);
ok('…busiest pair first', mixed[0].count === 2);
ok('…fastest and slowest are real extremes', mixed[0].fastestS === 600 && mixed[0].slowestS === 900);
ok('…average is the mean', mixed[0].avgS === 750);
ok('empty input gives empty stats', circuitStats([]).length === 0);
ok('null input gives empty stats', circuitStats(null).length === 0);
ok('a zero-duration circuit is ignored rather than skewing the average',
   circuitStats([{ pickup_name: 'a', dump_name: 'b', duration_s: 0 }]).length === 0);

console.log('\nZone modes — v102.0 records keep working alongside v103.0 ones');
// v102.0 shipped circuit zones as kind:'pickup'|'dump'. Those are live on the
// phone, so the mode is DERIVED, never migrated in place.
ok('legacy kind:pickup reads as circuit-pickup', zoneMode({ kind: 'pickup' }) === ZONE_MODES.PICKUP);
ok('legacy kind:dump reads as circuit-dump', zoneMode({ kind: 'dump' }) === ZONE_MODES.DUMP);
ok('an explicit mode wins over kind',
   zoneMode({ kind: 'pickup', mode: ZONE_MODES.SUB }) === ZONE_MODES.SUB);
ok('a zone with neither is unusable, not guessed', zoneMode({ name: 'x' }) === null);
ok('null zone is unusable', zoneMode(null) === null);
ok('unusable zones are surfaced rather than silently dropped',
   unusableZones([PIT, { id: 'q', name: 'Mystery' }]).length === 1);
ok('…including one with a mode but no coordinates',
   unusableZones([{ id: 'q', name: 'No GPS', mode: ZONE_MODES.SUB }]).length === 1);
ok('zonesOfMode filters by derived mode',
   zonesOfMode([PIT, TIP], ZONE_MODES.PICKUP).length === 1);
ok('isCircuitMode covers both circuit ends',
   isCircuitMode(ZONE_MODES.PICKUP) && isCircuitMode(ZONE_MODES.DUMP));
ok('…and excludes sub-activities and work sites',
   !isCircuitMode(ZONE_MODES.SUB) && !isCircuitMode(ZONE_MODES.WORKSITE));
// The whole drive again, with the new mode spelling — identical result.
const MODE_ZONES = [
  { id: 'z1', name: 'Pit', mode: ZONE_MODES.PICKUP, lat: PIT.lat, lng: PIT.lng, radius: 100 },
  { id: 'z2', name: 'Tip', mode: ZONE_MODES.DUMP, lat: TIP.lat, lng: TIP.lng, radius: 100 },
];
const modeRun = circuitsFromFixes(FIXES, MODE_ZONES);
ok('mode-spelled zones produce the same two circuits', modeRun.circuits.length === 2);
ok('…with identical timings', modeRun.circuits[0].duration_s === 780 && modeRun.circuits[1].duration_s === 780);

console.log('\nA sub-activity inside the run does not disturb the circuits');
// The charcoal shed sits beside the haul road. Walking into it mid-cycle must
// not close, split, or abandon the circuit — the two readings are independent.
const SHED = { id: 'z5', name: 'Charcoal shed', mode: ZONE_MODES.SUB,
               lat: (PIT.lat + TIP.lat) / 2, lng: PIT.lng + 0.004, radius: 60 };
const withShed = FIXES.slice();
withShed.push({ lat: SHED.lat, lng: SHED.lng, t: T0 + 600 * 1000 });   // mid return leg 1
withShed.push({ lat: SHED.lat, lng: SHED.lng, t: T0 + 660 * 1000 });
const shedRun = circuitsFromFixes(withShed, MODE_ZONES.concat([SHED]));
ok('still exactly two circuits', shedRun.circuits.length === 2, shedRun.circuits.length);
ok('…with the cycle time unchanged', shedRun.circuits[0].duration_s === 780);
ok('…and nothing abandoned', shedRun.abandoned.length === 0, shedRun.abandoned);
ok('the shed visit IS in the shared visit stream (one primitive, two readings)',
   shedRun.visits.some(v => v.zone_id === 'z5'));
ok('…carrying its mode so the other reading can pick it up',
   shedRun.visits.filter(v => v.zone_id === 'z5')[0].mode === ZONE_MODES.SUB);

console.log('\nAn open cycle goes stale rather than counting forever');
// Caught by looking at the rendered screen: with an open cycle left from the
// morning, the live card read "CYCLE IN PROGRESS 10h 30m" the following evening.
// Same failure shape as the stale activeDay that blocked auto-start for 15 days.
const openAt7 = { start_ts: Date.parse('2026-07-30T07:00:00'), pickup_name: 'Pit' };
ok('a cycle 5 minutes old is live',
   isStaleCircuit(openAt7, Date.parse('2026-07-30T07:05:00')) === false);
ok('…still live at 1h59', isStaleCircuit(openAt7, Date.parse('2026-07-30T08:59:00')) === false);
ok('…stale past the 2h max', isStaleCircuit(openAt7, Date.parse('2026-07-30T09:01:00')) === true);
ok('…and certainly stale the next evening',
   isStaleCircuit(openAt7, Date.parse('2026-07-30T17:30:00')) === true);
ok('the threshold is the same max_circuit_s that rejects a lunch-break cycle',
   isStaleCircuit(openAt7, openAt7.start_ts + CIRCUIT_CFG.max_circuit_s * 1000 + 1) === true &&
   isStaleCircuit(openAt7, openAt7.start_ts + CIRCUIT_CFG.max_circuit_s * 1000) === false);
ok('no open cycle is never stale', isStaleCircuit(null, Date.now()) === false);
ok('a malformed cursor is never stale', isStaleCircuit({}, Date.now()) === false);

console.log('\nFormatting and dates');
ok('seconds under a minute', fmtCircuitDur(45) === '0m 45s');
ok('minutes and seconds', fmtCircuitDur(780) === '13m 00s');
ok('pads the seconds', fmtCircuitDur(605) === '10m 05s');
ok('rolls over to hours', fmtCircuitDur(3720) === '1h 02m');
ok('zero is zero', fmtCircuitDur(0) === '0m 00s');
ok('negative clamps to zero', fmtCircuitDur(-5) === '0m 00s');
ok('garbage clamps to zero', fmtCircuitDur('x') === '0m 00s');
// The v101.6 lesson: never toISOString for a user-facing date. Brisbane is
// UTC+10, so an 07:00 local start must file under the 30th, not the 29th.
ok('a Brisbane morning files under the local date',
   circuitDateOf(Date.parse('2026-07-30T07:00:00')) === '2026-07-30');
ok('…and so does 00:30 local', circuitDateOf(Date.parse('2026-07-30T00:30:00')) === '2026-07-30');
ok('…and 23:30 local', circuitDateOf(Date.parse('2026-07-30T23:30:00')) === '2026-07-30');

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
