#!/usr/bin/env node
/*
 * test-loads.js — v104.0 Loads review layer.
 *
 * Extracts //__V102_TRIPLOG_PURE_*__ (for monthKeyOf), //__V102_CIRCUIT_PURE_*__
 * (for circuitDateOf / fmtCircuitDur / the detector, so the rollup is checked
 * against circuits the REAL builder produced) and //__V104_LOADS_PURE_*__
 * VERBATIM from www/index.html.
 *
 * Fixtures are synthetic GPS breadcrumbs over a synthetic pit and tip — this
 * repo is PUBLIC, so no real coordinates appear here.
 *
 * Run:  node test-loads.js
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
  extract('__V102_CIRCUIT_PURE_START__', '__V102_CIRCUIT_PURE_END__') + '\n' +
  extract('__V104_LOADS_PURE_START__', '__V104_LOADS_PURE_END__') + `
return {LOADS_CFG, isVoidLoad, loadReviewStatus, countedLoads, medianOf, loadsRollup,
        loadsForDate, loadMonthKeys, loadsByDay, loadDayStatus, buildLoadStrip,
        loadsPeriodSummary, applyLoadConfirm, clearLoadConfirm, applyLoadVoid, clearLoadVoid,
        retimeCircuit, outlierLoads, confirmPlan, loadSegments, decimatePolyline,
        pruneCircuitPolylines, circuitPhaseSplit, fmtLcm, LOAD_VOID_REASONS, loadVoidLabel,
        circuitsFromFixes, circuitDateOf, fmtCircuitDur, CIRCUIT_CFG};`)();
const { LOADS_CFG, isVoidLoad, loadReviewStatus, countedLoads, medianOf, loadsRollup,
        loadsForDate, loadMonthKeys, loadsByDay, loadDayStatus, buildLoadStrip,
        loadsPeriodSummary, applyLoadConfirm, clearLoadConfirm, applyLoadVoid, clearLoadVoid,
        retimeCircuit, outlierLoads, confirmPlan, loadSegments, decimatePolyline,
        pruneCircuitPolylines, circuitPhaseSplit, fmtLcm, LOAD_VOID_REASONS, loadVoidLabel,
        circuitsFromFixes, circuitDateOf, fmtCircuitDur, CIRCUIT_CFG } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const DAY = '2026-07-30';
const T0 = Date.parse(DAY + 'T07:00:00');
const mkt = (min) => T0 + min * 60000;
// A recorded lap: starts at `startMin`, runs `durMin`, split into four phases.
function lap(id, startMin, durMin, extra) {
  const s = mkt(startMin), e = mkt(startMin + durMin);
  const d = durMin * 60;
  const load = Math.round(d * 0.25), haul = Math.round(d * 0.3),
        dump = Math.round(d * 0.15), ret = d - load - haul - dump;
  return Object.assign({
    id: id, date: DAY, pickup_name: 'Pit', dump_name: 'Tip',
    pickup_zone_id: 'z1', dump_zone_id: 'z2',
    start_ts: s, end_ts: e, duration_s: d,
    load_s: load, haul_s: haul, dump_s: dump, return_s: ret,
    legs: [
      { kind: 'haul', depart_ts: s + load * 1000, arrive_ts: s + (load + haul) * 1000 },
      { kind: 'return', depart_ts: s + (load + haul + dump) * 1000, arrive_ts: e }
    ], notes: ''
  }, extra || {});
}
// Five laps: 8, 9, 10, 11 and 12 minutes. Median 10, mean 10.
const EVEN_DAY = [lap('c1', 0, 8), lap('c2', 10, 9), lap('c3', 20, 10), lap('c4', 32, 11), lap('c5', 45, 12)];

console.log('Median, not mean — the whole reason Steven asked for it');
ok('odd count takes the middle value', medianOf([8, 10, 12]) === 10);
ok('even count averages the two middle', medianOf([8, 10, 12, 14]) === 11);
ok('an even split that lands on .5 rounds', medianOf([10, 11]) === 11);
ok('order does not matter', medianOf([12, 8, 10]) === 10);
ok('a single value is its own median', medianOf([420]) === 420);
ok('empty is null, NOT zero', medianOf([]) === null);
ok('null input is null', medianOf(null) === null);
ok('non-numbers are ignored', medianOf([10, 'x', null, undefined, 20]) === 15);
ok('NaN and Infinity are ignored', medianOf([10, NaN, Infinity, 20]) === 15);
// The load-bearing case: one breakdown must not move the headline figure.
{
  const durs = [480, 540, 600, 660, 7200];
  ok('one 2-hour breakdown does not move the median', medianOf(durs) === 600);
  const mean = Math.round(durs.reduce((a, b) => a + b) / durs.length);
  ok('…while the mean is dragged to ' + mean + 's', mean === 1896 && mean > 3 * 600);
}

console.log('\nReview status — three states, two additive fields');
ok('a pre-v104 circuit is pending', loadReviewStatus(EVEN_DAY[0]) === 'pending');
ok('a confirmed circuit is confirmed', loadReviewStatus(applyLoadConfirm(EVEN_DAY[0], 1)) === 'confirmed');
ok('a flagged circuit is void', loadReviewStatus(applyLoadVoid(EVEN_DAY[0], 'breakdown', 1)) === 'void');
ok('flagging clears a prior confirmation',
   applyLoadVoid(applyLoadConfirm(EVEN_DAY[0], 1), 'break', 2).confirmed_at === undefined);
ok('unflagging restores it to pending, not confirmed',
   loadReviewStatus(clearLoadVoid(applyLoadVoid(EVEN_DAY[0], 'breakdown', 1))) === 'pending');
ok('unconfirming is possible — the stamp is not a lock',
   loadReviewStatus(clearLoadConfirm(applyLoadConfirm(EVEN_DAY[0], 1))) === 'pending');
ok('every transition returns a NEW object', applyLoadConfirm(EVEN_DAY[0], 1) !== EVEN_DAY[0]);
ok('…and never mutates the input', EVEN_DAY[0].confirmed_at === undefined && EVEN_DAY[0].invalid === undefined);
ok('the reason is kept', applyLoadVoid(EVEN_DAY[0], 'breakdown', 1).invalid_reason === 'breakdown');
ok('a missing reason falls back to other', applyLoadVoid(EVEN_DAY[0], null, 1).invalid_reason === 'other');
ok('isVoidLoad reads the flag', isVoidLoad({ invalid: true }) === true && isVoidLoad({}) === false);
ok('a flagged lap is still IN the list — kept and shown, never deleted',
   [applyLoadVoid(EVEN_DAY[0], 'break', 1)].length === 1);
ok('…but out of the counted set', countedLoads([applyLoadVoid(EVEN_DAY[0], 'break', 1)]).length === 0);
ok('every void reason has a human label',
   LOAD_VOID_REASONS.every(r => loadVoidLabel(r.k) === r.label));
ok('an unknown reason still gets a label', loadVoidLabel('zzz') === 'Flagged');

console.log('\nThe rollup — the ONLY thing that reaches an invoice');
{
  const r = loadsRollup(EVEN_DAY, 12);
  ok('total loads', r.loads === 5);
  ok('median cycle time is the middle lap (10 min)', r.medianS === 600);
  ok('mean is reported alongside so the gap is visible', r.meanS === 600);
  ok('fastest / slowest', r.fastestS === 480 && r.slowestS === 720);
  ok('LCM³ = loads × truck capacity', r.lcm3 === 60);
  ok('capacity is echoed back', r.capacity === 12);
  ok('productive hours = sum of cycle durations', r.productiveHours === 0.83,
     r.productiveHours);
  ok('…which is 50 minutes of laps, not the 57 minutes of clock they span',
     r.totalS === 3000 && (EVEN_DAY[4].end_ts - EVEN_DAY[0].start_ts) / 1000 === 3420);
  ok('the pickup → dump pairs are listed once', r.pairs.length === 1 && r.pairs[0] === 'Pit → Tip');
  ok('nothing flagged yet', r.voided === 0);
  ok('all five are pending review', r.pending === 5);
}
{
  // Truck capacity not set: null, never 0. "0 LCM³" reads as "moved nothing".
  const r = loadsRollup(EVEN_DAY, 0);
  ok('no truck capacity → lcm3 is null, NOT 0', r.lcm3 === null);
  ok('…and capacity is null', r.capacity === null);
  ok('…but loads and median still work', r.loads === 5 && r.medianS === 600);
  ok('a missing capacity argument behaves the same', loadsRollup(EVEN_DAY).lcm3 === null);
  ok('a negative capacity is refused', loadsRollup(EVEN_DAY, -5).lcm3 === null);
  ok('a fractional capacity is kept', loadsRollup(EVEN_DAY, 12.5).lcm3 === 62.5);
}
{
  const r = loadsRollup([], 12);
  ok('no laps → loads 0', r.loads === 0);
  ok('no laps → median null, NOT 0', r.medianS === null);
  ok('no laps → lcm3 is 0 (zero loads really is zero volume)', r.lcm3 === 0);
  ok('no laps → productive hours 0', r.productiveHours === 0);
  ok('null list is safe', loadsRollup(null, 12).loads === 0);
  ok('holes in the list are skipped', loadsRollup([null, undefined], 12).loads === 0);
}

console.log('\nBreakdown mid-cycle — flagged, excluded, kept');
{
  // Lap 3 was a 90-minute breakdown. Recorded (it is under max_circuit_s), then
  // flagged by Steven in the review sheet.
  const withBreakdown = [lap('c1', 0, 8), lap('c2', 10, 9), lap('c3', 20, 90), lap('c4', 115, 11), lap('c5', 128, 12)];
  const raw = loadsRollup(withBreakdown, 12);
  ok('before flagging it counts as a load', raw.loads === 5);
  ok('…and it drags the mean to 26 min while the median holds at 11',
     raw.meanS === 1560 && raw.medianS === 660);
  const flagged = withBreakdown.map(c => c.id === 'c3' ? applyLoadVoid(c, 'breakdown', 1) : c);
  const r = loadsRollup(flagged, 12);
  ok('flagged: loads drops to 4', r.loads === 4);
  ok('flagged: it is counted in voided', r.voided === 1);
  ok('flagged: median is the honest 10 min', r.medianS === 600);
  ok('flagged: LCM³ follows the load count', r.lcm3 === 48);
  ok('flagged: its 90 minutes leave productive hours',
     r.productiveHours === 0.67, r.productiveHours);
  ok('flagged: the record itself is still in the list', flagged.length === 5);
  ok('flagged: and still carries its measurements', flagged[2].duration_s === 5400);
}

console.log('\nMeal break at the dump zone');
{
  // He tipped, then sat at the tip face for 40 minutes. The lap is recorded as
  // one long cycle with a huge tip phase — it is NOT auto-excluded, because a
  // genuinely slow lap looks the same and silently deleting it would hide the
  // one number that says a job is going badly.
  const mealLap = lap('c3', 20, 50);
  const day = [lap('c1', 0, 8), lap('c2', 10, 9), mealLap, lap('c4', 75, 11), lap('c5', 88, 12)];
  const r = loadsRollup(day, 12);
  ok('the long lap is recorded, not silently dropped', r.loads === 5);
  ok('but the median is unmoved by it', r.medianS === 660);
  ok('and it IS flagged as an outlier for the eye', outlierLoads(day).indexOf('c3') >= 0);
  ok('…while the normal laps are not', outlierLoads(day).length === 1);
  const after = day.map(c => c.id === 'c3' ? applyLoadVoid(c, 'break', 1) : c);
  ok('once flagged as a meal break it leaves the count', loadsRollup(after, 12).loads === 4);
  ok('…and leaves productive hours', loadsRollup(after, 12).totalS === 2400);
  ok('…and is no longer reported as an outlier', outlierLoads(after).length === 0);
}

console.log('\nOutliers are a hint, never a filter');
ok('a uniform day flags nothing', outlierLoads(EVEN_DAY).length === 0);
ok('under 3 laps there is no typical to deviate from',
   outlierLoads([lap('a', 0, 5), lap('b', 10, 60)]).length === 0);
ok('exactly 3x the median is not yet an outlier',
   outlierLoads([lap('a', 0, 10), lap('b', 20, 10), lap('c', 40, 30)]).length === 0);
ok('just over 3x is', outlierLoads([lap('a', 0, 10), lap('b', 20, 10), lap('c', 40, 31)]).length === 1);
ok('the multiple is configurable',
   outlierLoads(EVEN_DAY, { outlier_multiple: 1.1 }).length === 1);
ok('an already-flagged lap is never re-flagged as an outlier',
   outlierLoads([lap('a', 0, 10), lap('b', 20, 10), applyLoadVoid(lap('c', 40, 90), 'break', 1)]).length === 0);
ok('an empty list flags nothing', outlierLoads([]).length === 0);

console.log('\nIncomplete cycles never reach this layer at all');
{
  // The detector abandons a pickup that never reached a dump — it is returned
  // in `abandoned[]`, never in `circuits[]`, so the review screen cannot show
  // it and the rollup cannot count it.
  const M = 111320;
  const PIT = { id: 'z1', name: 'Pit', mode: 'circuit-pickup', lat: -28.5, lng: 151.9, radius: 100 };
  const TIP = { id: 'z2', name: 'Tip', mode: 'circuit-dump', lat: -28.489, lng: 151.9, radius: 100 };
  const at = (z, m, s) => ({ lat: z.lat + m / M, lng: z.lng, t: T0 + s * 1000 });
  const between = (s) => ({ lat: (PIT.lat + TIP.lat) / 2, lng: PIT.lng, t: T0 + s * 1000 });
  // Pit → out → back to the pit without ever reaching the tip.
  const fixes = [at(PIT, 0, 0), at(PIT, 10, 60), between(200), between(300), at(PIT, 0, 500), at(PIT, 5, 560)];
  const res = circuitsFromFixes(fixes, [PIT, TIP], CIRCUIT_CFG);
  ok('a pickup that never reached a dump produces no circuit', res.circuits.length === 0);
  ok('…and is reported as abandoned instead', res.abandoned.length === 1 && res.abandoned[0].reason === 'no_dump');
  ok('the rollup over the recorded circuits shows nothing',
     loadsRollup(res.circuits, 12).loads === 0);
  ok('…and its median is null, not 0', loadsRollup(res.circuits, 12).medianS === null);
  // A real pit → tip → pit lap DOES land, so the fixture above is not vacuous.
  const good = [at(PIT, 0, 0), at(PIT, 10, 60), between(200), at(TIP, 0, 400), at(TIP, 5, 460),
                between(600), at(PIT, 0, 800), at(PIT, 5, 860)];
  const gres = circuitsFromFixes(good, [PIT, TIP], CIRCUIT_CFG);
  ok('a real pit → tip → pit lap is recorded', gres.circuits.length === 1);
  ok('…and the rollup counts it', loadsRollup(gres.circuits, 12).loads === 1);
  ok('…with LCM³ for one load', loadsRollup(gres.circuits, 12).lcm3 === 12);
}

console.log('\nDays, months and the strip');
{
  const other = lap('d1', 0, 10, { date: '2026-07-29', id: 'd1' });
  const all = EVEN_DAY.concat([other]);
  ok('loadsForDate scopes to one day', loadsForDate(all, DAY).length === 5);
  ok('month keys are newest first',
     JSON.stringify(loadMonthKeys(all.concat([lap('x', 0, 5, { date: '2026-06-01', id: 'x' })])))
       === JSON.stringify(['2026-07', '2026-06']));
  const byDay = loadsByDay(all, 12);
  ok('loadsByDay is newest first', byDay[0].date === DAY && byDay[1].date === '2026-07-29');
  ok('each day carries its own rollup', byDay[0].loads === 5 && byDay[1].loads === 1);
  ok('each day carries its raw circuits for the sheet', byDay[0].circuits.length === 5);
  ok('a day of nothing but flagged laps still gets a row',
     loadsByDay([applyLoadVoid(other, 'break', 1)], 12).length === 1);
  const strip = buildLoadStrip(all, '2026-07', 12);
  ok('the strip is calendar order, oldest first', strip[0].date === '2026-07-29' && strip[1].date === DAY);
  ok('only days that were actually worked get a chip', strip.length === 2);
  ok('the bar normalises to the busiest day', strip[1].bar === 100 && strip[0].bar === 20);
  ok('a month with no laps gives an empty strip', buildLoadStrip(all, '2026-01', 12).length === 0);
  ok('the strip carries the day number for the chip', strip[1].day === 30);
}

console.log('\nDay status');
ok('nothing recorded → none', loadDayStatus([]) === 'none');
ok('a fresh day is pending', loadDayStatus(EVEN_DAY) === 'pending');
ok('one unconfirmed lap keeps the day pending',
   loadDayStatus(EVEN_DAY.map((c, i) => i < 4 ? applyLoadConfirm(c, 1) : c)) === 'pending');
ok('all confirmed → confirmed',
   loadDayStatus(EVEN_DAY.map(c => applyLoadConfirm(c, 1))) === 'confirmed');
ok('a flagged lap does not hold the day back — flagging IS the decision',
   loadDayStatus(EVEN_DAY.map((c, i) => i === 0 ? applyLoadVoid(c, 'break', 1) : applyLoadConfirm(c, 1))) === 'confirmed');
ok('a day where everything was flagged reads void',
   loadDayStatus(EVEN_DAY.map(c => applyLoadVoid(c, 'break', 1))) === 'void');

console.log('\nConfirm all');
ok('confirms every counted, unconfirmed lap', confirmPlan(EVEN_DAY).length === 5);
ok('skips ones already confirmed',
   confirmPlan(EVEN_DAY.map((c, i) => i < 2 ? applyLoadConfirm(c, 1) : c)).length === 3);
ok('never confirms a flagged lap',
   confirmPlan(EVEN_DAY.map(c => applyLoadVoid(c, 'break', 1))).length === 0);
ok('a settled day has nothing to do',
   confirmPlan(EVEN_DAY.map(c => applyLoadConfirm(c, 1))).length === 0);

console.log('\nPeriod summary (the invoice total line)');
{
  const rows = buildLoadStrip(EVEN_DAY.concat([lap('d1', 0, 20, { date: '2026-07-29', id: 'd1' })]), '2026-07', 12);
  const s = loadsPeriodSummary(rows);
  ok('days worked', s.days === 2);
  ok('total loads across the period', s.loads === 6);
  ok('the median is across EVERY lap, not a median of daily medians',
     s.medianS === 630, s.medianS);
  ok('…which a median-of-medians would have got wrong',
     medianOf([600, 1200]) === 900 && s.medianS !== 900);
  ok('total LCM³ over the period', s.lcm3 === 72);
  ok('productive hours add up', s.productiveHours === 1.17, s.productiveHours);
  ok('pending count rolls up', s.pending === 6);
  ok('an empty period is null-safe', loadsPeriodSummary([]).medianS === null);
  ok('…with no fabricated LCM³', loadsPeriodSummary([]).lcm3 === null);
}

console.log('\nRetiming a lap trims only the outermost phases');
{
  const c = lap('c1', 0, 20);                       // 1200s: 300 load / 360 haul / 180 tip / 360 return
  ok('fixture phases sum to the duration',
     c.load_s + c.haul_s + c.dump_s + c.return_s === c.duration_s);
  const r = retimeCircuit(c, c.start_ts + 120000, c.end_ts);   // start 2 min later
  ok('duration shrinks by the trim', r.duration_s === 1080);
  ok('the load phase absorbs it', r.load_s === 180);
  ok('the haul phase is untouched — no honest way to edit road time', r.haul_s === c.haul_s);
  ok('the tip phase is untouched', r.dump_s === c.dump_s);
  ok('the return phase is untouched', r.return_s === c.return_s);
  ok('phases still sum to the duration', r.load_s + r.haul_s + r.dump_s + r.return_s === r.duration_s);
  ok('it is stamped as user-edited', r.edited_by_user === true);
  const r2 = retimeCircuit(c, c.start_ts, c.end_ts - 120000);  // end 2 min earlier
  ok('trimming the end eats the return phase', r2.return_s === 240 && r2.load_s === c.load_s);
  ok('phases still sum after an end trim',
     r2.load_s + r2.haul_s + r2.dump_s + r2.return_s === r2.duration_s);
  const r3 = retimeCircuit(c, c.start_ts + 60000, c.end_ts - 60000);
  ok('both ends can be trimmed at once', r3.duration_s === 1080 && r3.load_s === 240 && r3.return_s === 300);
  const r4 = retimeCircuit(c, c.start_ts, c.end_ts - 900000);  // cut to 5 min
  ok('an aggressive trim never leaves phases longer than the lap',
     r4.load_s + r4.haul_s + r4.dump_s + r4.return_s <= r4.duration_s,
     [r4.duration_s, r4.load_s, r4.haul_s, r4.dump_s, r4.return_s]);
  ok('no phase goes negative', r4.load_s >= 0 && r4.return_s >= 0);
  ok('an inverted range is refused', retimeCircuit(c, c.end_ts, c.start_ts) === null);
  ok('a zero-length range is refused', retimeCircuit(c, c.start_ts, c.start_ts) === null);
  ok('garbage input is refused', retimeCircuit(c, 'x', 'y') === null);
  ok('a null circuit is refused', retimeCircuit(null, 1, 2) === null);
  ok('the original is never mutated', c.duration_s === 1200 && c.load_s === 300);
  ok('a retimed lap flows straight into the rollup',
     loadsRollup([r], 12).medianS === 1080);
}

console.log('\nBreadcrumb: decimate, split, prune');
{
  const pts = [];
  for (let i = 0; i < 500; i++) pts.push({ lat: -28.5 + i * 1e-5, lng: 151.9, t: T0 + i * 1000 });
  const d = decimatePolyline(pts, 40);
  ok('decimated to the cap', d.length === 40);
  ok('the first fix is kept', d[0].t === pts[0].t);
  ok('the last fix is kept — the trail still ends at the pit', d[39].t === pts[499].t);
  ok('points stay in order', d.every((p, i) => i === 0 || p.t > d[i - 1].t));
  ok('a short trail is returned whole', decimatePolyline(pts.slice(0, 12), 40).length === 12);
  ok('…as a copy, not the same array', decimatePolyline(pts.slice(0, 3), 40) !== pts);
  ok('the default cap is used when none is given', decimatePolyline(pts).length === LOADS_CFG.polyline_max_points);
  ok('empty in, empty out', decimatePolyline([], 40).length === 0);
  ok('null is safe', decimatePolyline(null, 40).length === 0);
  ok('points with no coordinates are dropped', decimatePolyline([{ t: 1 }, pts[0]], 40).length === 1);
}
{
  const c = lap('c1', 0, 20);
  c.polyline = [];
  for (let s = 0; s <= 1200; s += 60) c.polyline.push({ lat: -28.5, lng: 151.9, t: c.start_ts + s * 1000 });
  const p = circuitPhaseSplit(c);
  ok('the loaded haul is separated from the empty return',
     p.haul.length > 0 && p.ret.length > 0);
  ok('every point lands in exactly one phase (boundaries are shared for drawing)',
     p.atPickup.length + p.haul.length + p.atDump.length + p.ret.length >= c.polyline.length);
  ok('the haul starts where the pickup dwell ended',
     p.atPickup.length === 0 || p.haul[0] === p.atPickup[p.atPickup.length - 1]);
  ok('the return starts where the tip dwell ended',
     p.atDump.length === 0 || p.ret[0] === p.atDump[p.atDump.length - 1]);
  ok('a lap with no trail splits to nothing',
     circuitPhaseSplit(lap('x', 0, 5)).haul.length === 0);
  ok('a null circuit is safe', circuitPhaseSplit(null).haul.length === 0);
  const noLegs = Object.assign({}, c); delete noLegs.legs;
  ok('a hand-edited lap with no legs draws as one run',
     circuitPhaseSplit(noLegs).haul.length === c.polyline.length);
}
{
  const NOW = Date.parse('2026-09-15T12:00:00');
  const fresh = lap('c1', 0, 10, { start_ts: NOW - 5 * 86400000, polyline: [{ lat: 1, lng: 2, t: 1 }, { lat: 1, lng: 2, t: 2 }] });
  const old = lap('c2', 0, 10, { start_ts: NOW - 60 * 86400000, polyline: [{ lat: 1, lng: 2, t: 1 }, { lat: 1, lng: 2, t: 2 }] });
  const res = pruneCircuitPolylines([fresh, old], NOW);
  ok('a recent trail is kept', res.circuits[0].polyline.length === 2);
  ok('an old trail is dropped', res.circuits[1].polyline === undefined);
  ok('…and says so, rather than just showing nothing', res.circuits[1].trail_pruned === true);
  ok('the prune count is reported', res.pruned === 1);
  // The load-bearing guarantee: a number that has been on an invoice never moves.
  ok('pruning never touches the duration', res.circuits[1].duration_s === old.duration_s);
  ok('pruning never touches the phases',
     res.circuits[1].load_s === old.load_s && res.circuits[1].haul_s === old.haul_s &&
     res.circuits[1].dump_s === old.dump_s && res.circuits[1].return_s === old.return_s);
  ok('pruning never touches the start/end stamps',
     res.circuits[1].start_ts === old.start_ts && res.circuits[1].end_ts === old.end_ts);
  ok('pruning never touches a confirmation',
     pruneCircuitPolylines([applyLoadConfirm(old, 7)], NOW).circuits[0].confirmed_at === 7);
  ok('pruning never touches a flag',
     pruneCircuitPolylines([applyLoadVoid(old, 'breakdown', 7)], NOW).circuits[0].invalid_reason === 'breakdown');
  ok('the rollup is identical before and after a prune',
     JSON.stringify(loadsRollup([fresh, old], 12)) === JSON.stringify(loadsRollup(res.circuits, 12)));
  ok('a lap with no trail is passed through untouched',
     pruneCircuitPolylines([lap('c3', 0, 10)], NOW).circuits[0].id === 'c3');
  ok('nothing to prune reports zero', pruneCircuitPolylines([fresh], NOW).pruned === 0);
  ok('the retention window is configurable',
     pruneCircuitPolylines([fresh], NOW, { polyline_keep_days: 1 }).pruned === 1);
}

console.log('\nDay-sheet rows');
{
  const day = EVEN_DAY.map((c, i) => i === 1 ? applyLoadVoid(c, 'breakdown', 1) : (i === 2 ? applyLoadConfirm(c, 1) : c));
  const segs = loadSegments(day);
  ok('one row per lap, flagged ones included', segs.length === 5);
  ok('rows are in time order', segs.every((s, i) => i === 0 || s.start_ts >= segs[i - 1].start_ts));
  ok('rows are numbered for the eye', segs[0].n === 1 && segs[4].n === 5);
  ok('the pickup → dump pair is spelled out', segs[0].pair === 'Pit → Tip');
  ok('phase breakdown rides along', segs[0].loadS > 0 && segs[0].haulS > 0 && segs[0].dumpS > 0 && segs[0].returnS > 0);
  ok('the flagged lap carries its status and reason',
     segs[1].status === 'void' && segs[1].reason === 'breakdown');
  ok('the confirmed lap says so', segs[2].status === 'confirmed');
  ok('the rest are pending', segs[0].status === 'pending' && segs[4].status === 'pending');
  ok('hasTrail is false with no polyline', segs[0].hasTrail === false);
  const withTrail = loadSegments([lap('t', 0, 10, { polyline: [{ lat: 1, lng: 2, t: 1 }, { lat: 1, lng: 2, t: 2 }] })]);
  ok('hasTrail is true with one', withTrail[0].hasTrail === true);
  ok('a one-point trail is not drawable',
     loadSegments([lap('t', 0, 10, { polyline: [{ lat: 1, lng: 2, t: 1 }] })])[0].hasTrail === false);
  ok('an empty day gives no rows', loadSegments([]).length === 0);
  ok('null is safe', loadSegments(null).length === 0);
}

console.log('\nLCM³ formatting');
ok('null formats as an em dash, never 0', fmtLcm(null) === '—');
ok('a whole number', fmtLcm(60) === '60 LCM³');
ok('two decimals are kept', fmtLcm(62.5) === '62.5 LCM³');
ok('rounds past two decimals', fmtLcm(60.128) === '60.13 LCM³');
ok('thousands are grouped', fmtLcm(1200).indexOf('1,200') === 0);
ok('zero really is zero', fmtLcm(0) === '0 LCM³');

console.log('\n── PIN ────────────────────────────────────────────────────────');
// test_loads_tab_shows_completed_cycles_only_median_time_and_lcm3_rollup
{
  // A real shape of day: four completed laps, one abandoned run that never
  // reached the tip, and one meal break the driver flagged.
  const M = 111320;
  const PIT = { id: 'z1', name: 'Pit', mode: 'circuit-pickup', lat: -28.5, lng: 151.9, radius: 100 };
  const TIP = { id: 'z2', name: 'Tip', mode: 'circuit-dump', lat: -28.489, lng: 151.9, radius: 100 };
  const at = (z, m, s) => ({ lat: z.lat + m / M, lng: z.lng, t: T0 + s * 1000 });
  const mid = (s) => ({ lat: (PIT.lat + TIP.lat) / 2, lng: PIT.lng, t: T0 + s * 1000 });

  const fixes = [];
  let t = 0;
  // Four clean 10-minute laps back to back.
  for (let i = 0; i < 4; i++) {
    fixes.push(at(PIT, 0, t), at(PIT, 5, t + 120));     // loading
    fixes.push(mid(t + 240));                            // hauling
    fixes.push(at(TIP, 0, t + 330), at(TIP, 5, t + 420)); // tipping
    fixes.push(mid(t + 500));                            // returning
    t += 600;
  }
  fixes.push(at(PIT, 0, t), at(PIT, 5, t + 120));         // closes lap 4, opens lap 5
  // Lap 5: out towards the tip and straight back — never arrived. Abandoned.
  fixes.push(mid(t + 300), at(PIT, 0, t + 600), at(PIT, 5, t + 700));

  const res = circuitsFromFixes(fixes, [PIT, TIP], CIRCUIT_CFG);
  ok('PIN: the detector recorded 4 completed cycles', res.circuits.length === 4, res.circuits.length);
  ok('PIN: the run that never reached the tip is abandoned, not recorded',
     res.abandoned.length === 1 && res.abandoned[0].reason === 'no_dump');

  const stored = res.circuits.map((c, i) => Object.assign({ id: 'c' + c.start_ts, date: circuitDateOf(c.start_ts) }, c));
  // The driver flagged lap 2 — he stopped for smoko at the tip face.
  const day = stored.map((c, i) => i === 1 ? applyLoadVoid(c, 'break', T0) : c);

  const roll = loadsRollup(day, 12);
  ok('PIN: the tab shows every recorded lap, including the flagged one',
     loadSegments(day).length === 4);
  ok('PIN: only COMPLETED cycles reach the rollup — the abandoned run is absent',
     roll.loads + roll.voided === 4);
  ok('PIN: only NON-FLAGGED completed cycles are counted', roll.loads === 3);
  ok('PIN: the headline is a MEDIAN cycle time, not a mean', roll.medianS === medianOf(
     countedLoads(day).map(c => c.duration_s)));
  ok('PIN: the median is 10 minutes', roll.medianS === 600, roll.medianS);
  ok('PIN: LCM³ = counted loads × truck capacity = 3 × 12', roll.lcm3 === 36, roll.lcm3);
  ok('PIN: productive hours are the counted cycle time only',
     roll.productiveHours === Math.round((roll.totalS / 3600) * 100) / 100 && roll.totalS === 1800);
  ok('PIN: with no truck capacity the LCM³ is null, never a fabricated 0',
     loadsRollup(day).lcm3 === null);
  ok('PIN: the day is pending until the laps are confirmed', loadDayStatus(day) === 'pending');
  const confirmed = day.map(c => isVoidLoad(c) ? c : applyLoadConfirm(c, T0));
  ok('PIN: confirming every counted lap settles the day', loadDayStatus(confirmed) === 'confirmed');
  ok('PIN: confirming changes no measurement',
     JSON.stringify(loadsRollup(confirmed, 12).medianS) === JSON.stringify(roll.medianS) &&
     loadsRollup(confirmed, 12).lcm3 === roll.lcm3);
}

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
