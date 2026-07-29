#!/usr/bin/env node
/*
 * test-subactivity.js — v103.0 sub-activity tracking + batch costing.
 *
 * The SECOND reading of the shared zone-visit stream (the first is circuits, in
 * test-circuits.js). Extracts //__V102_CIRCUIT_PURE_START__ ... _END__ and the
 * trip-log block it depends on, VERBATIM from www/index.html.
 *
 * Steven's case: charcoal batching. A small zone (the charcoal shed) nested
 * inside the big work-site fence. Time in the shed is "charcoal time" while the
 * work session keeps running; after a batch he enters materials and kg produced
 * and wants $/kg — and whether it is getting cheaper.
 *
 * Coordinates are synthetic — this repo is PUBLIC.
 *
 * Run:  node test-subactivity.js
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
return {ZONE_MODES, zoneMode, zonesOfMode, CIRCUIT_CFG,
        zoneVisitsFromFixes, subSessionsFromVisits, subSessionsFromFixes,
        subHoursOn, groupSubSessions, batchCost, costTrend, activityCostSummary,
        fmtUnitCost, circuitDateOf, circuitsFromFixes};`)();
const { ZONE_MODES, CIRCUIT_CFG, subSessionsFromFixes, subSessionsFromVisits, zoneVisitsFromFixes,
        subHoursOn, groupSubSessions, batchCost, costTrend, activityCostSummary,
        fmtUnitCost, circuitDateOf, circuitsFromFixes } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

const M = 111320;
// The nesting Steven described: a 60 m charcoal shed INSIDE a 2900 m work site.
// The work site lives in mcn_sites and is not part of this detector at all —
// which is exactly why the nesting is not a conflict.
const SHED = { id: 'z-shed', name: 'Charcoal shed', mode: ZONE_MODES.SUB,
               lat: -28.500, lng: 151.900, radius: 60,
               cost: { hourly_rate: 60, output_unit: 'kg' } };
const WELD = { id: 'z-weld', name: 'Welding bay', mode: ZONE_MODES.SUB,
               lat: -28.494, lng: 151.900, radius: 60 };
const ZONES = [SHED, WELD];

const D = (day, h, m) => new Date(2026, 6, day, h, m, 0).getTime();
const at = (z, t) => ({ lat: z.lat + 10 / M, lng: z.lng, t });
const away = t => ({ lat: -28.470, lng: 151.930, t });

console.log('Detecting time in a sub-activity zone');
// 30 Jul: in the shed 08:00–11:00, out for lunch, back 12:00–14:00.
const day1 = [];
for (let t = D(30, 8, 0); t <= D(30, 11, 0); t += 300000) day1.push(at(SHED, t));
for (let t = D(30, 11, 5); t <= D(30, 11, 55); t += 300000) day1.push(away(t));
for (let t = D(30, 12, 0); t <= D(30, 14, 0); t += 300000) day1.push(at(SHED, t));
day1.push(away(D(30, 14, 30)));   // he leaves, so the last visit is closed

const r1 = subSessionsFromFixes(day1, ZONES);
ok('two shed sessions detected', r1.sessions.length === 2, r1.sessions.length);
ok('…the first runs 08:00–11:00', r1.sessions[0].start_ts === D(30, 8, 0) && r1.sessions[0].end_ts === D(30, 11, 0));
ok('…3 hours of it', r1.sessions[0].duration_s === 10800);
ok('…the second runs 12:00–14:00', r1.sessions[1].duration_s === 7200);
ok('…both named for the zone', r1.sessions.every(s => s.activity === 'Charcoal shed'));
ok('…and keyed to it', r1.sessions.every(s => s.zone_id === 'z-shed'));
ok('nothing is left open once he has driven away', r1.open === null);
ok('total for the day is 5 hours', subHoursOn(r1.sessions, 'z-shed', '2026-07-30') === 5);
ok('…and 0 for a day he was not there', subHoursOn(r1.sessions, 'z-shed', '2026-07-29') === 0);
ok('…and 0 for a different activity', subHoursOn(r1.sessions, 'z-weld', '2026-07-30') === 0);

console.log('\nAn open session is never sealed');
// He is still in the shed — the fix stream simply stops there.
const openRun = [];
for (let t = D(30, 8, 0); t <= D(30, 9, 30); t += 300000) openRun.push(at(SHED, t));
const r2 = subSessionsFromFixes(openRun, ZONES);
ok('the current visit is reported as open', r2.open !== null);
ok('…with its start time', r2.open.start_ts === D(30, 8, 0));
// Sealing it would invent a finish time for work still going on — the same rule
// the work timer follows for a shift with no knock-off.
ok('…and is NOT counted as a completed session', r2.sessions.length === 0, r2.sessions);
ok('…so it contributes no hours to a batch yet', subHoursOn(r2.sessions, 'z-shed', '2026-07-30') === 0);

console.log('\nWalking past is not working');
const passBy = [at(SHED, D(30, 8, 0)), away(D(30, 8, 0) + 20000), away(D(30, 8, 5))];
ok('a 20-second touch is below the floor', subSessionsFromFixes(passBy, ZONES).sessions.length === 0);
ok('the floor is a minute', CIRCUIT_CFG.min_sub_activity_s === 60);
// Higher than the circuit floor on purpose: these hours are divided into an
// output figure, so junk entries quietly distort $/kg rather than being obvious.
ok('…which is stricter than the circuit floor', CIRCUIT_CFG.min_sub_activity_s > CIRCUIT_CFG.min_dwell_s);
const realStop = [at(SHED, D(30, 8, 0)), at(SHED, D(30, 8, 2)), away(D(30, 8, 10))];
ok('a two-minute stop does count', subSessionsFromFixes(realStop, ZONES).sessions.length === 1);

console.log('\nTwo different sub-activities on the same day');
const mixed = [];
for (let t = D(30, 8, 0); t <= D(30, 10, 0); t += 300000) mixed.push(at(SHED, t));
for (let t = D(30, 10, 30); t <= D(30, 12, 0); t += 300000) mixed.push(at(WELD, t));
for (let t = D(30, 12, 30); t <= D(30, 13, 30); t += 300000) mixed.push(at(SHED, t));
mixed.push(away(D(30, 14, 0)));
const r3 = subSessionsFromFixes(mixed, ZONES);
ok('three sessions across two activities', r3.sessions.length === 3);
ok('charcoal gets 3 hours', subHoursOn(r3.sessions, 'z-shed', '2026-07-30') === 3);
ok('welding gets 1.5 hours', subHoursOn(r3.sessions, 'z-weld', '2026-07-30') === 1.5);
const groups = groupSubSessions(r3.sessions);
ok('grouped into one row per activity per day', groups.length === 2, groups.map(g => g.activity));
ok('…each carrying its total hours',
   groups.find(g => g.zone_id === 'z-shed').hours === 3 &&
   groups.find(g => g.zone_id === 'z-weld').hours === 1.5);
ok('…and how many separate stints made it up',
   groups.find(g => g.zone_id === 'z-shed').count === 2);
ok('…newest first', groups[0].first_ts >= groups[1].first_ts);

console.log('\nSessions split across days stay on their own day');
const overDays = [];
for (let t = D(29, 9, 0); t <= D(29, 11, 0); t += 300000) overDays.push(at(SHED, t));
overDays.push(away(D(29, 12, 0)));
for (let t = D(30, 9, 0); t <= D(30, 12, 0); t += 300000) overDays.push(at(SHED, t));
overDays.push(away(D(30, 13, 0)));
const r4 = subSessionsFromFixes(overDays, ZONES);
ok('29 Jul gets its own 2 hours', subHoursOn(r4.sessions, 'z-shed', '2026-07-29') === 2);
ok('30 Jul gets its own 3 hours', subHoursOn(r4.sessions, 'z-shed', '2026-07-30') === 3);
ok('grouped as two separate rows', groupSubSessions(r4.sessions).length === 2);
// The v101.6 lesson — a Brisbane morning must not file under the previous UTC day.
ok('days are LOCAL dates', circuitDateOf(D(30, 7, 0)) === '2026-07-30');

console.log('\nNo zones / no fixes / junk');
ok('no zones = no sessions', subSessionsFromFixes(day1, []).sessions.length === 0);
ok('no fixes = no sessions', subSessionsFromFixes([], ZONES).sessions.length === 0);
ok('null fixes do not throw', subSessionsFromFixes(null, ZONES).sessions.length === 0);
ok('a circuit zone is not a sub-activity',
   subSessionsFromFixes(day1, [{ id: 'z1', name: 'Pit', mode: ZONE_MODES.PICKUP,
                                 lat: SHED.lat, lng: SHED.lng, radius: 60 }]).sessions.length === 0);
ok('subSessionsFromVisits handles an empty stream', subSessionsFromVisits([], null).sessions.length === 0);

console.log('\nBatch costing — (labour + materials) / output');
// Steven's charcoal batch: 5 hours at $60, $80 of wood, 120 kg out.
const b1 = batchCost({ hours: 5, rate: 60, material_cost: 80, output_qty: 120 });
ok('labour is hours x rate', b1.labour === 300);
ok('materials carry through', b1.material === 80);
ok('total is labour + materials', b1.total === 380);
ok('cost per unit is total / output', b1.cost_per_unit === 3.1667, b1.cost_per_unit);
ok('…and reads sensibly', fmtUnitCost(b1.cost_per_unit, 'kg') === '$3.17/kg', fmtUnitCost(b1.cost_per_unit, 'kg'));
// A sub-dollar unit cost must not round away to $0.00.
ok('a cheap unit keeps its precision',
   fmtUnitCost(batchCost({ hours: 1, rate: 60, material_cost: 20, output_qty: 1000 }).cost_per_unit, 'kg') === '$0.080/kg',
   fmtUnitCost(batchCost({ hours: 1, rate: 60, material_cost: 20, output_qty: 1000 }).cost_per_unit, 'kg'));

console.log('\nCosting refuses to invent an answer');
// No output entered yet. A fabricated "$0.00/kg" reads as free — the opposite
// of unknown — so the answer is withheld instead.
ok('no output = no cost per unit', batchCost({ hours: 5, rate: 60, material_cost: 80 }).cost_per_unit === null);
ok('zero output = no cost per unit', batchCost({ hours: 5, rate: 60, output_qty: 0 }).cost_per_unit === null);
ok('…but the total is still computed', batchCost({ hours: 5, rate: 60, material_cost: 80 }).total === 380);
ok('…and displays as a dash, not a number', fmtUnitCost(null, 'kg') === '—');
ok('empty input does not throw', batchCost({}).total === 0);
ok('null input does not throw', batchCost(null).cost_per_unit === null);
ok('negative hours clamp to zero', batchCost({ hours: -5, rate: 60, output_qty: 10 }).labour === 0);
ok('negative materials clamp to zero', batchCost({ hours: 1, rate: 10, material_cost: -50, output_qty: 10 }).total === 10);
ok('string inputs from a form are coerced',
   batchCost({ hours: '5', rate: '60', material_cost: '80', output_qty: '120' }).total === 380);
ok('materials-only batch still costs out',
   batchCost({ hours: 0, rate: 60, material_cost: 100, output_qty: 50 }).cost_per_unit === 2);
ok('labour-only batch still costs out',
   batchCost({ hours: 2, rate: 50, material_cost: 0, output_qty: 50 }).cost_per_unit === 2);

console.log('\nHistorical trend — is it getting cheaper?');
const BATCHES = [
  { id: 'b1', zone_id: 'z-shed', activity: 'Charcoal shed', date: '2026-07-20', hours: 6, labour: 360, material: 100, total: 460, output_qty: 100, output_unit: 'kg', cost_per_unit: 4.6 },
  { id: 'b2', zone_id: 'z-shed', activity: 'Charcoal shed', date: '2026-07-25', hours: 5, labour: 300, material: 80, total: 380, output_qty: 120, output_unit: 'kg', cost_per_unit: 3.1667 },
  { id: 'b3', zone_id: 'z-shed', activity: 'Charcoal shed', date: '2026-07-28', hours: 5, labour: 300, material: 90, total: 390, output_qty: 150, output_unit: 'kg', cost_per_unit: 2.6 },
  { id: 'b4', zone_id: 'z-weld', activity: 'Welding bay', date: '2026-07-26', hours: 2, labour: 120, material: 40, total: 160, output_qty: 8, output_unit: 'joints', cost_per_unit: 20 },
];
const tr = costTrend(BATCHES, 'z-shed');
ok('only this activity’s batches', tr.length === 3);
ok('…oldest first, so a trend reads left to right', tr[0].date === '2026-07-20' && tr[2].date === '2026-07-28');
ok('first batch has no comparison', tr[0].delta_pct === null);
ok('second is 31.2% cheaper', tr[1].delta_pct === -31.2, tr[1].delta_pct);
ok('third is cheaper again', tr[2].delta_pct === -17.9, tr[2].delta_pct);
ok('the cheapest batch is flagged', tr[2].is_best === true);
ok('…and the dearest', tr[0].is_worst === true);
ok('a batch with no output is left out of the trend entirely',
   costTrend(BATCHES.concat([{ id: 'b5', zone_id: 'z-shed', date: '2026-07-29', cost_per_unit: null }]), 'z-shed').length === 3);
ok('no zone filter returns every activity', costTrend(BATCHES).length === 4);
ok('an unknown activity has no trend', costTrend(BATCHES, 'nope').length === 0);
ok('empty input does not throw', costTrend([], 'z-shed').length === 0);
ok('null input does not throw', costTrend(null).length === 0);
ok('a single batch is neither best nor worst-flagged as a comparison',
   costTrend([BATCHES[0]], 'z-shed')[0].is_worst === false);

console.log('\nActivity summary uses a WEIGHTED average');
const sum = activityCostSummary(BATCHES, 'z-shed');
ok('counts the batches', sum.batches === 3);
ok('adds the hours', sum.hours === 16);
ok('adds the spend', sum.total === 1230);
ok('adds the output', sum.output_qty === 370);
// Total spend over total output — NOT the mean of the per-batch rates, or a 5 kg
// batch would weigh the same as a 200 kg one.
ok('cost per unit is total spend / total output', sum.cost_per_unit === 3.3243, sum.cost_per_unit);
const meanOfRates = (4.6 + 3.1667 + 2.6) / 3;
ok('…which is NOT the mean of the batch rates',
   Math.abs(sum.cost_per_unit - meanOfRates) > 0.01, [sum.cost_per_unit, meanOfRates]);
ok('carries the unit label through', sum.output_unit === 'kg');
ok('a different activity summarises separately', activityCostSummary(BATCHES, 'z-weld').batches === 1);
ok('no batches = no summary (not a zeroed one)', activityCostSummary([], 'z-shed') === null);
ok('null input does not throw', activityCostSummary(null, 'z-shed') === null);

console.log('\nEnd to end: a charcoal day becomes a $/kg figure');
// The whole path, as it happens in the field.
const shift = [];
for (let t = D(30, 8, 0); t <= D(30, 13, 0); t += 300000) shift.push(at(SHED, t));
shift.push(away(D(30, 13, 30)));
const detected = subSessionsFromFixes(shift, ZONES);
const hours = subHoursOn(detected.sessions, 'z-shed', '2026-07-30');
ok('the shed time is measured without him touching anything', hours === 5, hours);
const costed = batchCost({ hours: hours, rate: SHED.cost.hourly_rate, material_cost: 80, output_qty: 120 });
ok('…costed against the zone’s own configured rate', costed.labour === 300);
ok('…and 120 kg out gives $3.17/kg',
   fmtUnitCost(costed.cost_per_unit, SHED.cost.output_unit) === '$3.17/kg');
// The regression pin for this half of the system.
ok('test_sub_activity_records_nested_zone_time_and_costs_per_unit',
   detected.sessions.length === 1 && hours === 5 && costed.cost_per_unit === 3.1667,
   { sessions: detected.sessions.length, hours, cpu: costed.cost_per_unit });

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
