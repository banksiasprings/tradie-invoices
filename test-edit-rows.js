#!/usr/bin/env node
/*
 * test-edit-rows.js — v104.7 edit a recorded lap, and a recorded trip.
 *
 * THE FIELD CASE (2026-07-30): Steven ran dump-truck cycles, then got into the
 * Hitachi for 40 minutes without leaving the dump zone. GPS saw one continuous
 * 45-minute "load". The real lap was about five.
 *
 * retimeCircuit() (v104.0) trims only the OUTER phases, deliberately — there is
 * no honest way to edit the time a loaded truck spent on the road. But this dead
 * time sat in the MIDDLE, in the tip phase, so trimming the finish would take it
 * off the run back, which is not where it was. Hence setCircuitDuration().
 *
 * Synthetic coordinates — this repo is PUBLIC.
 *
 * Run:  node test-edit-rows.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
function extract(start, end) {
  const m = html.match(new RegExp('\\/\\/' + start + '[^\\n]*\\n([\\s\\S]*?)\\/\\/' + end));
  if (!m) { console.error('✗ could not find ' + start); process.exit(2); }
  return m[1];
}
const api = new Function(
  extract('__V102_TRIPLOG_PURE_START__', '__V102_TRIPLOG_PURE_END__') + '\n' +
  extract('__V102_CIRCUIT_PURE_START__', '__V102_CIRCUIT_PURE_END__') + '\n' +
  extract('__V104_LOADS_PURE_START__', '__V104_LOADS_PURE_END__') + `
return {setCircuitDuration, longestPhaseOf, retimeCircuit, loadsRollup, loadSegments,
        medianOf, countedLoads, applyLoadVoid, isVoidLoad, fmtCircuitDur, LOADS_CFG};`)();
const { setCircuitDuration, longestPhaseOf, retimeCircuit, loadsRollup, loadSegments,
        medianOf, countedLoads, applyLoadVoid, isVoidLoad, fmtCircuitDur } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

const DAY = '2026-07-30';
const T0 = Date.parse(DAY + 'T07:00:00');
const mkt = min => T0 + min * 60000;
// A lap with an explicit phase breakdown.
function lap(id, startMin, phases) {
  const [load, haul, dump, ret] = phases;
  const d = load + haul + dump + ret;
  const s = mkt(startMin);
  return {
    id, date: DAY, pickup_name: 'Pit', dump_name: 'Tip',
    start_ts: s, end_ts: s + d * 1000, duration_s: d,
    load_s: load, haul_s: haul, dump_s: dump, return_s: ret,
    legs: [{ kind: 'haul', depart_ts: s + load * 1000, arrive_ts: s + (load + haul) * 1000 },
           { kind: 'return', depart_ts: s + (load + haul + dump) * 1000, arrive_ts: s + d * 1000 }],
    notes: ''
  };
}
// Four honest 10-minute laps: 2 load / 3 haul / 1.5 tip / 3.5 back.
const CLEAN = [0, 10, 20, 30].map((m, i) => lap('c' + (i + 1), m, [120, 180, 90, 210]));
// THE one: 45 minutes recorded, of which 40 were spent sitting in the Hitachi
// inside the dump zone. The real lap underneath is 5 minutes: 60/90/45/105.
const HITACHI = lap('c5', 45, [60, 90, 45 + 2400, 105]);

console.log('── PIN: test_loads_row_long_press_edit_adjusts_duration_and_recomputes_rollup ──');
{
  const before = loadsRollup(CLEAN.concat([HITACHI]), 12);
  ok('PIN: before the edit there are 5 loads', before.loads === 5);
  ok('PIN: …the bad lap is 45 minutes', HITACHI.duration_s === 2700, HITACHI.duration_s);
  ok('PIN: …the median is already protected from it', before.medianS === 600, before.medianS);
  ok('PIN: …but productive hours are inflated by the sit-around',
     before.productiveHours === 1.42, before.productiveHours);
  ok('PIN: …and the dead time is in the TIP phase, not at either end',
     longestPhaseOf(HITACHI) === 'tipping');

  // The edit: "that lap was really 5 minutes."
  const fixed = setCircuitDuration(HITACHI, 5 * 60);
  ok('PIN: the duration becomes 5 minutes', fixed.duration_s === 300, fixed.duration_s);
  ok('PIN: …the finish moves, the start does not',
     fixed.start_ts === HITACHI.start_ts && fixed.end_ts === HITACHI.start_ts + 300000);
  ok('PIN: …the 40 minutes come off TIPPING, where the waiting was',
     fixed.dump_s === 45, { dump_s: fixed.dump_s, wasDeadTime: 2400 });
  ok('PIN: …and the haul out is untouched — GPS got that right',
     fixed.haul_s === HITACHI.haul_s, { was: HITACHI.haul_s, now: fixed.haul_s });
  ok('PIN: …loading is untouched too', fixed.load_s === HITACHI.load_s);
  ok('PIN: …and nothing spills onto the run back, because tipping absorbed it all',
     fixed.return_s === 105, { return_s: fixed.return_s });
  ok('PIN: …so the phases still sum to the corrected lap exactly',
     fixed.load_s + fixed.haul_s + fixed.dump_s + fixed.return_s === 300,
     [fixed.load_s, fixed.haul_s, fixed.dump_s, fixed.return_s]);
  ok('PIN: …phases never exceed the lap that contains them',
     fixed.load_s + fixed.haul_s + fixed.dump_s + fixed.return_s <= fixed.duration_s,
     [fixed.load_s, fixed.haul_s, fixed.dump_s, fixed.return_s, fixed.duration_s]);
  ok('PIN: …and it is stamped as a human decision', fixed.edited_by_user === true);
  ok('PIN: the original record is never mutated', HITACHI.duration_s === 2700 && HITACHI.dump_s === 2445);

  // The rollup recomputes off the edited list — the whole point of the fix.
  const after = loadsRollup(CLEAN.concat([fixed]), 12);
  ok('PIN: the load COUNT is unchanged — it was a real lap, just a short one',
     after.loads === 5);
  ok('PIN: …so LCM³ is unchanged at 60', after.lcm3 === 60 && before.lcm3 === 60);
  ok('PIN: productive hours drop by the 40 minutes',
     after.productiveHours === 0.75, { before: before.productiveHours, after: after.productiveHours });
  ok('PIN: …which is exactly 40 minutes less',
     Math.round((before.productiveHours - after.productiveHours) * 60) === 40);
  ok('PIN: the median moves to the honest middle', after.medianS === 600, after.medianS);
  ok('PIN: the slowest lap is no longer the phantom', after.slowestS === 600, after.slowestS);
  ok('PIN: neighbouring laps are byte-identical objects',
     CLEAN.every(c => c.duration_s === 600 && c.dump_s === 90));
  ok('PIN: …and the sheet rows still list all five',
     loadSegments(CLEAN.concat([fixed])).length === 5);
  ok('PIN: …with the edited one badged', loadSegments(CLEAN.concat([fixed]))
     .filter(s => s.id === 'c5')[0].edited === true);

  // The alternative he'd otherwise be forced into: flag the whole lap off.
  const flagged = loadsRollup(CLEAN.concat([applyLoadVoid(HITACHI, 'breakdown', 1)]), 12);
  ok('PIN: flagging it instead would have LOST a real load', flagged.loads === 4);
  ok('PIN: …and 12 LCM³ he actually moved', flagged.lcm3 === 48);
  ok('PIN: editing keeps the load and fixes the time — which is why Edit exists',
     after.loads === 5 && after.lcm3 === 60 && after.productiveHours < before.productiveHours);
}

console.log('\nsetCircuitDuration — the spill rule');
{
  const c = lap('x', 0, [100, 200, 400, 300]);   // 1000s
  ok('shortening takes from the longest phase first',
     setCircuitDuration(c, 800).dump_s === 200);
  ok('…leaving the others alone',
     (() => { const r = setCircuitDuration(c, 800); return r.load_s === 100 && r.haul_s === 200 && r.return_s === 300; })());
  ok('a bigger cut spills into the next longest', (() => {
      const r = setCircuitDuration(c, 500);       // remove 500: 400 from dump, 100 from return
      return r.dump_s === 0 && r.return_s === 200 && r.haul_s === 200 && r.load_s === 100;
    })());
  ok('…and keeps spilling until it fits', (() => {
      const r = setCircuitDuration(c, 60);
      return r.load_s + r.haul_s + r.dump_s + r.return_s <= 60;
    })());
  ok('no phase ever goes negative', (() => {
      const r = setCircuitDuration(c, 1);
      return [r.load_s, r.haul_s, r.dump_s, r.return_s].every(v => v >= 0);
    })());
  ok('lengthening adds to the longest phase', setCircuitDuration(c, 1200).dump_s === 600);
  ok('an unchanged duration changes no phase', (() => {
      const r = setCircuitDuration(c, 1000);
      return r.load_s === 100 && r.haul_s === 200 && r.dump_s === 400 && r.return_s === 300;
    })());
  ok('a lap with no phase breakdown still gets its duration set', (() => {
      const bare = { id: 'b', start_ts: T0, end_ts: T0 + 600000, duration_s: 600 };
      const r = setCircuitDuration(bare, 300);
      return r.duration_s === 300 && r.end_ts === T0 + 300000;
    })());
  ok('zero is refused', setCircuitDuration(c, 0) === null);
  ok('negative is refused', setCircuitDuration(c, -60) === null);
  ok('garbage is refused', setCircuitDuration(c, 'x') === null);
  ok('a null lap is refused', setCircuitDuration(null, 300) === null);
  ok('fractional seconds round', setCircuitDuration(c, 300.4).duration_s === 300);
}

console.log('\nlongestPhaseOf names the phase in plain words');
ok('tipping', longestPhaseOf(lap('a', 0, [10, 10, 500, 10])) === 'tipping');
ok('the haul out', longestPhaseOf(lap('a', 0, [10, 500, 10, 10])) === 'the haul out');
ok('loading', longestPhaseOf(lap('a', 0, [500, 10, 10, 10])) === 'loading');
ok('the run back', longestPhaseOf(lap('a', 0, [10, 10, 10, 500])) === 'the run back');
ok('a lap with no phases returns nothing to name',
   longestPhaseOf({ id: 'z', duration_s: 300 }) === null);
ok('a null lap is safe', longestPhaseOf(null) === null);

console.log('\nThe two edit paths stay independent');
{
  const c = lap('y', 0, [120, 180, 90, 210]);
  const byTime = retimeCircuit(c, c.start_ts + 60000, c.end_ts);
  ok('retime still trims only the outer phases (v104.0 rule intact)',
     byTime.load_s === 60 && byTime.haul_s === 180 && byTime.dump_s === 90);
  const byDur = setCircuitDuration(c, 540);
  ok('setDuration takes from the longest instead', byDur.return_s === 150 && byDur.load_s === 120);
  ok('both reach the same duration by different routes',
     byTime.duration_s === 540 && byDur.duration_s === 540);
  ok('…and neither mutates the original', c.duration_s === 600 && c.load_s === 120);
}

console.log('\n── PIN: test_trip_row_long_press_edit_adjusts_time_and_category ──');
{
  // The trip-side edit is impure (it writes through setTrips), so the contract
  // is pinned in source here and exercised for real in the live suite.
  ok('PIN: long-press opens a choice, not the delete confirm',
     /tlRowActions\(id\);/.test(html) && !/confirmDeleteTrip\(id\);\n\s*\},500\)/.test(html));
  ok('PIN: …offering Edit', /Edit this trip/.test(html));
  ok('PIN: …and Delete', /Delete this trip/.test(html));
  ok('PIN: …with the Skip-vs-Delete distinction spelled out',
     /use Skip/.test(html));
  ok('PIN: the detail modal now has an editable start time', /id="td-start"/.test(html));
  ok('PIN: …and an editable finish time', /id="td-end"/.test(html));
  ok('PIN: …wired to a handler', /onchange="setTripTimes/.test(html));
  ok('PIN: …that recomputes duration_min', /duration_min=Math\.round\(\(ne-ns\)\/60000\)/.test(html));
  ok('PIN: …refuses a finish before the start', /Finish has to be after the start/.test(html));
  ok('PIN: …and stamps the trip as user-edited', /t\.edited_by_user=true;\n\s*setTrips\(all\);\n\s*try\{ GeoLog\.add\('info','Trip '\+id\+' times corrected'/.test(html));
  ok('PIN: category editing already existed and is untouched', /setTripCategory/.test(html));
  ok('PIN: distance is NOT rewritten by a time edit — it feeds the ATO claim',
     /Distance is NOT touched/.test(html) && !/t\.distance_km=/.test(html.slice(html.indexOf('function setTripTimes'), html.indexOf('function setTripTimes') + 900)));
}

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
