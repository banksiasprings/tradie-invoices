#!/usr/bin/env node
/*
 * test-triplog-screen.js — unit tests for the v101.7 Trip Log review screen.
 *
 * Extracts the //__V102_TRIPLOG_PURE_START__ / __V102_TRIPLOG_PURE_END__ block
 * VERBATIM from www/index.html and exercises the shipped source (no copy, no
 * drift): review status, the day strip builder, period totals, filters, the
 * approval plan, day segments, and route labels.
 *
 * Includes the regression pin test_trip_log_screen_renders_from_mcn_trips,
 * built on a fixture that matches the REAL shape v101.6 writes to mcn_trips
 * (verified against Steven's Firestore blob 2026-07-28). Coordinates are
 * synthetic — this repo is public.
 *
 * Run:  node test-triplog-screen.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
const m = html.match(/\/\/__V102_TRIPLOG_PURE_START__[^\n]*\n([\s\S]*?)\/\/__V102_TRIPLOG_PURE_END__/);
if (!m) { console.error('✗ could not find v102 trip-log pure markers in www/index.html'); process.exit(2); }
const api = new Function(m[1] + `
return {tripReviewStatus,isPendingTrip,isPrivateCat,monthKeyOf,daysInMonthKey,tripMonthKeys,
        filterTripsBy,dayStatus,buildDayStrip,periodSummary,applyTripCategory,clearTripCategory,
        approvalPlan,daySegments,routeLabelOf};`)();
const { tripReviewStatus, isPendingTrip, isPrivateCat, monthKeyOf, daysInMonthKey, tripMonthKeys,
        filterTripsBy, dayStatus, buildDayStrip, periodSummary, applyTripCategory, clearTripCategory,
        approvalPlan, daySegments, routeLabelOf } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

// ── Review status ────────────────────────────────────────────────────────────
console.log('Review status');
ok('no category = pending', tripReviewStatus({ category: 'unknown' }) === 'pending');
ok('absent category = pending', tripReviewStatus({}) === 'pending');
ok('null trip = pending', tripReviewStatus(null) === 'pending');
ok('category set, no stamp = tagged', tripReviewStatus({ category: 'business' }) === 'tagged');
ok('approved_at wins = approved', tripReviewStatus({ category: 'business', approved_at: 123 }) === 'approved');
// The legacy case that matters: every trip captured before v101.7 was tagged by
// swipe, so it has edited_by_user but no stamp. It must read as tagged, not
// approved — claiming the user confirmed something they never saw is a lie.
ok('legacy swipe-tag (edited_by_user, no stamp) = tagged',
   tripReviewStatus({ category: 'business', edited_by_user: true }) === 'tagged');
ok('isPendingTrip agrees', isPendingTrip({ category: 'unknown' }) === true && isPendingTrip({ category: 'personal' }) === false);
ok('commute is private', isPrivateCat('commute') === true);
ok('personal is private', isPrivateCat('personal') === true);
ok('business is not private', isPrivateCat('business') === false);

// ── Period helpers ───────────────────────────────────────────────────────────
console.log('Period helpers');
ok('monthKeyOf', monthKeyOf('2026-07-27') === '2026-07');
ok('monthKeyOf on junk', monthKeyOf(null) === '' && monthKeyOf(undefined) === '');
ok('July has 31 days', daysInMonthKey('2026-07') === 31);
ok('February 2026 has 28 days', daysInMonthKey('2026-02') === 28, daysInMonthKey('2026-02'));
ok('February 2028 has 29 (leap)', daysInMonthKey('2028-02') === 29, daysInMonthKey('2028-02'));
ok('June has 30 days', daysInMonthKey('2026-06') === 30);
ok('bad month key = 0', daysInMonthKey('2026-13') === 0 && daysInMonthKey('nope') === 0 && daysInMonthKey(null) === 0);
ok('month keys newest first',
   JSON.stringify(tripMonthKeys([{ date: '2026-05-01' }, { date: '2026-07-27' }, { date: '2026-06-14' }, { date: '2026-07-02' }]))
   === JSON.stringify(['2026-07', '2026-06', '2026-05']));
ok('month keys ignore undated trips', JSON.stringify(tripMonthKeys([{ date: '2026-07-01' }, {}, { date: null }])) === JSON.stringify(['2026-07']));

// ── Filters ──────────────────────────────────────────────────────────────────
console.log('Filters');
const mixed = [
  { id: 'a', category: 'business' },
  { id: 'b', category: 'personal' },
  { id: 'c', category: 'commute' },
  { id: 'd', category: 'unknown' },
  { id: 'e' },
];
ok('all = everything', filterTripsBy(mixed, 'all').length === 5);
ok('business = 1', filterTripsBy(mixed, 'business').map(t => t.id).join('') === 'a');
ok('private = personal + commute', filterTripsBy(mixed, 'private').map(t => t.id).join('') === 'bc');
ok('pending = untagged only', filterTripsBy(mixed, 'pending').map(t => t.id).join('') === 'de');
ok('filter does not mutate input', mixed.length === 5);

// ── Day strip ────────────────────────────────────────────────────────────────
console.log('Day strip');
const julyTrips = [
  { id: 't1', date: '2026-07-27', start_time: 300, distance_km: 35.54, category: 'business' },
  { id: 't2', date: '2026-07-27', start_time: 100, distance_km: 4.46, category: 'unknown' },
  { id: 't3', date: '2026-07-03', start_time: 500, distance_km: 20, category: 'personal', approved_at: 9 },
  { id: 't4', date: '2026-06-30', start_time: 500, distance_km: 999, category: 'business' }, // other month
];
const strip = buildDayStrip(julyTrips, '2026-07');
ok('strip covers the whole month (31 rows)', strip.length === 31, strip.length);
ok('row 1 is the 1st', strip[0].date === '2026-07-01' && strip[0].day === 1);
ok('row 31 is the 31st', strip[30].date === '2026-07-31' && strip[30].day === 31);
ok('empty day has no trips', strip[0].count === 0 && strip[0].km === 0 && strip[0].status === 'none');
const d27 = strip[26], d3 = strip[2];
ok('27th has 2 trips', d27.count === 2, d27.count);
ok('27th km = 40.00', d27.km === 40, d27.km);
ok('27th business km = 35.54', d27.businessKm === 35.54, d27.businessKm);
ok('27th has 1 pending', d27.pending === 1, d27.pending);
ok('27th status = pending (any untagged wins)', d27.status === 'pending', d27.status);
ok('3rd status = approved', d3.status === 'approved', d3.status);
ok('3rd private km = 20', d3.privateKm === 20, d3.privateKm);
ok('other-month trip excluded', strip.every(r => r.km !== 999));
ok('trips within a day sorted by start_time', d27.trips[0].id === 't2' && d27.trips[1].id === 't1',
   d27.trips.map(t => t.id));
ok('bar normalised: biggest day = 100', d27.bar === 100, d27.bar);
ok('bar normalised: 20/40 = 50', d3.bar === 50, d3.bar);
ok('bar 0 on empty days', strip[0].bar === 0);
ok('bad month key = empty strip', buildDayStrip(julyTrips, 'nope').length === 0);
ok('no trips still renders the full month', buildDayStrip([], '2026-07').length === 31);
ok('all-zero month does not divide by zero', buildDayStrip([], '2026-07').every(r => r.bar === 0));

console.log('Day status rollup');
ok('empty = none', dayStatus([]) === 'none');
ok('all approved = approved', dayStatus([{ category: 'business', approved_at: 1 }, { category: 'personal', approved_at: 2 }]) === 'approved');
ok('all tagged, none approved = tagged', dayStatus([{ category: 'business' }, { category: 'personal' }]) === 'tagged');
ok('mixed approved + tagged = tagged', dayStatus([{ category: 'business', approved_at: 1 }, { category: 'personal' }]) === 'tagged');
ok('one pending poisons the day', dayStatus([{ category: 'business', approved_at: 1 }, { category: 'unknown' }]) === 'pending');

// ── Period summary ───────────────────────────────────────────────────────────
console.log('Period summary');
const sum = periodSummary(strip);
ok('2 days driven', sum.daysDriven === 2, sum.daysDriven);
ok('total km = 60', sum.totalKm === 60, sum.totalKm);
ok('business km = 35.54', sum.businessKm === 35.54, sum.businessKm);
ok('private km = 20', sum.privateKm === 20, sum.privateKm);
ok('3 trips', sum.trips === 3, sum.trips);
ok('1 pending', sum.pending === 1, sum.pending);
ok('business pct = 59', sum.businessPct === 59, sum.businessPct);
const empty = periodSummary(buildDayStrip([], '2026-07'));
ok('empty month: 0 days, 0 km, 0%', empty.daysDriven === 0 && empty.totalKm === 0 && empty.businessPct === 0);
// Untagged km must NOT be counted as business — that is the whole point of the
// pending state, and counting it would overstate a claim.
ok('untagged km excluded from business', sum.businessKm + sum.privateKm < sum.totalKm);

// ── Approval mutation ────────────────────────────────────────────────────────
console.log('Approval mutation');
const orig = { id: 'x', category: 'unknown', distance_km: 12, notes: 'keep me', auto: true };
const appd = applyTripCategory(orig, 'business', 1785200000000);
ok('category applied', appd.category === 'business');
ok('edited_by_user set', appd.edited_by_user === true);
ok('approved_at stamped', appd.approved_at === 1785200000000);
ok('other fields preserved', appd.notes === 'keep me' && appd.distance_km === 12 && appd.auto === true);
ok('input NOT mutated', orig.category === 'unknown' && orig.approved_at === undefined);
ok('status flips to approved', tripReviewStatus(appd) === 'approved');
const cleared = clearTripCategory(appd);
ok('clear → pending', tripReviewStatus(cleared) === 'pending');
ok('clear drops the stamp', !('approved_at' in cleared));
ok('clear keeps other fields', cleared.notes === 'keep me' && cleared.distance_km === 12);
ok('clear does not mutate input', appd.category === 'business' && appd.approved_at === 1785200000000);

// Business-use % moves when a trip is approved — the header figure Steven watches.
const beforePct = periodSummary(buildDayStrip(julyTrips, '2026-07')).businessPct;
const afterTrips = julyTrips.map(t => t.id === 't2' ? applyTripCategory(t, 'business', 5) : t);
const afterPct = periodSummary(buildDayStrip(afterTrips, '2026-07')).businessPct;
ok('tagging the untagged trip business moves 59% → 67%', beforePct === 59 && afterPct === 67, [beforePct, afterPct]);
const afterPersonal = julyTrips.map(t => t.id === 't2' ? applyTripCategory(t, 'personal', 5) : t);
ok('tagging it personal leaves business % at 59', periodSummary(buildDayStrip(afterPersonal, '2026-07')).businessPct === 59);

console.log('Approval plan');
const plan = approvalPlan([
  { id: 'p1', category: 'business' },                       // explicit → approve as business
  { id: 'p2', category: 'unknown', suggest_category: 'commute' }, // suggestion → approve as commute
  { id: 'p3', category: 'unknown' },                        // no decision → skip
  { id: 'p4', category: 'personal', approved_at: 1 },       // already done → neither
]);
ok('2 approvable', plan.approve.length === 2, plan.approve);
ok('explicit category kept', plan.approve[0].id === 'p1' && plan.approve[0].category === 'business');
ok('suggestion adopted', plan.approve[1].id === 'p2' && plan.approve[1].category === 'commute');
ok('undecidable trip skipped, not guessed', plan.skip.length === 1 && plan.skip[0] === 'p3');
ok('already-approved trip not re-approved', !plan.approve.some(a => a.id === 'p4'));
ok('empty day = nothing to do', approvalPlan([]).approve.length === 0 && approvalPlan([]).skip.length === 0);

// ── Day segments ─────────────────────────────────────────────────────────────
console.log('Day segments');
const segs = daySegments([
  { id: 's1', distance_km: 35.54, duration_min: 43.9, start_time: 1785136035123, end_time: 1785138668910,
    from_label: 'Stanthorpe', to_label: 'Lucas Ranch', category: 'business' },
  { id: 's2', distance_km: 5, duration_min: 0, category: 'unknown', suggest_category: 'business' },
]);
ok('km/h computed', segs[0].kmh === 48.6, segs[0].kmh);
ok('duration rounded to minutes', segs[0].min === 44, segs[0].min);
ok('labels carried', segs[0].from === 'Stanthorpe' && segs[0].to === 'Lucas Ranch');
ok('category carried', segs[0].category === 'business' && segs[0].status === 'tagged');
ok('zero duration does not divide by zero', segs[1].kmh === 0, segs[1].kmh);
ok('unknown category reported as null, suggestion kept', segs[1].category === null && segs[1].suggest === 'business');

console.log('Route labels');
ok('single trip A → B', routeLabelOf([{ from_label: 'Home', to_label: 'Lucas Ranch' }]) === 'Home → Lucas Ranch');
ok('chained trips collapse the shared stop',
   routeLabelOf([{ from_label: 'Home', to_label: 'Lucas Ranch' }, { from_label: 'Lucas Ranch', to_label: 'Lds' }])
   === 'Home → Lucas Ranch → Lds');
ok('unlabelled trips = empty string (caller falls back)', routeLabelOf([{ id: 'x' }]) === '');
ok('partial labels still render', routeLabelOf([{ to_label: 'Lucas Ranch' }]) === 'Lucas Ranch');
ok('empty list = empty string', routeLabelOf([]) === '');

// ── REGRESSION PIN ───────────────────────────────────────────────────────────
// test_trip_log_screen_renders_from_mcn_trips
// Fixture matches the exact record shape v101.6's TripLogService → JS replay
// writes to mcn_trips, verified against the live Firestore blob on 2026-07-28:
// every field present, `category` already set by a swipe-tag, `approved_at`
// absent, `from_label`/`to_label` absent, `linked_site_id` null. The screen must
// build a complete strip from this with no undefined leaking into the UI.
console.log('REGRESSION PIN: test_trip_log_screen_renders_from_mcn_trips');
const REAL_SHAPE = [{
  id: 'tfms2vwk6r', vehicle_id: 'vmr333uij', category: 'business',
  start_time: 1785136035123, end_time: 1785138668910,
  start_lat: -28.5100000, start_lng: 151.9400000,
  end_lat: -28.7300000, end_lng: 152.0700000,
  polyline: [
    { lat: -28.5100000, lng: 151.9400000, t: 1785136035123 },
    { lat: -28.6200000, lng: 151.9900000, t: 1785136903019 },
    { lat: -28.7300000, lng: 152.0700000, t: 1785138668910 },
  ],
  distance_km: 35.54, duration_min: 43.9, notes: '',
  linked_site_id: null, linked_invoice_id: null,
  date: '2026-07-27', auto: true, edited_by_user: true, created_at: 1785136035123,
}];
const pinStrip = buildDayStrip(REAL_SHAPE, '2026-07');
const pinSum = periodSummary(pinStrip);
const pinDay = pinStrip[26];
ok('pin: 31 chips built', pinStrip.length === 31);
ok('pin: the 27th carries the trip', pinDay.count === 1 && pinDay.date === '2026-07-27');
ok('pin: km = 35.54', pinDay.km === 35.54, pinDay.km);
ok('pin: status = tagged (real trip is categorised but never approved here)',
   pinDay.status === 'tagged', pinDay.status);
ok('pin: not counted as pending', pinDay.pending === 0);
ok('pin: bar is the month max', pinDay.bar === 100);
ok('pin: period = 1 day, 35.54 km, 100% business', pinSum.daysDriven === 1 && pinSum.totalKm === 35.54 && pinSum.businessPct === 100,
   [pinSum.daysDriven, pinSum.totalKm, pinSum.businessPct]);
ok('pin: month picker offers 2026-07', tripMonthKeys(REAL_SHAPE)[0] === '2026-07');
const pinSegs = daySegments(pinDay.trips);
ok('pin: segment km/h sane (35.54km in 43.9min ≈ 48.6)', pinSegs[0].kmh === 48.6, pinSegs[0].kmh);
ok('pin: no labels yet → route label falls back to empty', routeLabelOf(pinDay.trips) === '');
ok('pin: nothing in the strip row is undefined',
   Object.keys(pinDay).every(k => pinDay[k] !== undefined), pinDay);
ok('pin: approve-all adopts the existing business category',
   approvalPlan(pinDay.trips).approve.length === 1 && approvalPlan(pinDay.trips).approve[0].category === 'business');
// A day with a real trip must never render as 'none' — that would hide driving.
ok('pin: a day with a trip is never status "none"', pinDay.status !== 'none');

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
