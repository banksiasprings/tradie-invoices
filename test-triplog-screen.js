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
return {groupOnSiteSegments, tripReviewStatus,isPendingTrip,isPrivateCat,monthKeyOf,daysInMonthKey,tripMonthKeys,
        filterTripsBy,dayStatus,buildDayStrip,periodSummary,applyTripCategory,clearTripCategory,
        approvalPlan,daySegments,routeLabelOf,
        pointInFence,tripPoints,classifyIntraSite,isIntraSite,intraSiteLocked,
        applyIntraSiteFlags,TRIP_INTRA_SITE_CFG};`)();
const { groupOnSiteSegments, tripReviewStatus, isPendingTrip, isPrivateCat, monthKeyOf, daysInMonthKey, tripMonthKeys,
        filterTripsBy, dayStatus, buildDayStrip, periodSummary, applyTripCategory, clearTripCategory,
        approvalPlan, daySegments, routeLabelOf,
        pointInFence, tripPoints, classifyIntraSite, isIntraSite, intraSiteLocked,
        applyIntraSiteFlags, TRIP_INTRA_SITE_CFG } = api;

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
// A busy day must not grow the floating header until it pushes the map away.
const busy = [
  { from_label: 'Home', to_label: 'Stanthorpe' },
  { from_label: 'Stanthorpe', to_label: 'Lucas Ranch' },
  { from_label: 'Lucas Ranch', to_label: 'Lds' },
  { from_label: 'Lds', to_label: 'Cotton Vale' },
  { from_label: 'Cotton Vale', to_label: 'Home' },
];
ok('6 stops uncapped renders in full', routeLabelOf(busy).split('→').length === 6);
ok('6 stops capped at 4 collapses the middle', routeLabelOf(busy, 4) === 'Home → … → Home', routeLabelOf(busy, 4));
ok('at the cap, nothing is collapsed',
   routeLabelOf([{ from_label: 'A', to_label: 'B' }, { from_label: 'B', to_label: 'C' }], 4) === 'A → B → C');
ok('cap ignored when no cap given', routeLabelOf(busy, 0).split('→').length === 6);

// ── Intra-site movement ──────────────────────────────────────────────────────
// Fences in this app are CIRCLES (setCircularRegion natively, dist() < radius in
// JS), not polygons — so the shipped predicate is geodesic-distance-vs-radius.
// Synthetic Granite Belt coordinates; this repo is public.
console.log('Intra-site: fence predicate');
const SITE_A = { id: 'sA', name: 'Lucas Ranch', lat: -28.7200, lng: 152.0600, radius: 2900 };
const SITE_B = { id: 'sB', name: 'Lds', lat: -28.5100, lng: 151.9400, radius: 1050 };
const SITES = [SITE_A, SITE_B];

// metres → degrees latitude. MUST use the same spherical earth radius the
// predicate uses (R·π/180 ≈ 111,194.9 m/deg), not the WGS84 ellipsoidal
// 110,574 — otherwise "2890 m from the centre" is really 2906 m to the code
// under test, and a fixture meant to sit just inside the fence lands outside.
const M_PER_DEG_LAT = 6371000 * Math.PI / 180;
const mLat = m => m / M_PER_DEG_LAT;
const northOf = (site, metres) => ({ lat: site.lat + mLat(metres), lng: site.lng });

ok('centre is inside', pointInFence(SITE_A.lat, SITE_A.lng, SITE_A, 0));
ok('just inside the radius', pointInFence(northOf(SITE_A, 2890).lat, northOf(SITE_A, 2890).lng, SITE_A, 0));
ok('just outside the radius', !pointInFence(northOf(SITE_A, 2950).lat, northOf(SITE_A, 2950).lng, SITE_A, 0));
ok('30m past the edge is inside with 50m slack',
   pointInFence(northOf(SITE_A, 2930).lat, northOf(SITE_A, 2930).lng, SITE_A, 50));
ok('200m past the edge is outside even with slack',
   !pointInFence(northOf(SITE_A, 3100).lat, northOf(SITE_A, 3100).lng, SITE_A, 50));
ok('default radius 150m when a site omits one',
   pointInFence(-28.72 + mLat(100), 152.06, { lat: -28.72, lng: 152.06 }, 0) &&
   !pointInFence(-28.72 + mLat(300), 152.06, { lat: -28.72, lng: 152.06 }, 0));
ok('malformed site is never "inside"', !pointInFence(-28.72, 152.06, { lat: null, lng: null, radius: 999 }, 0));
ok('slack default is 50m', TRIP_INTRA_SITE_CFG.boundary_slack_m === 50);

// Build a trip from a list of {lat,lng} points.
function tripOf(id, pts, extra) {
  return Object.assign({
    id, date: '2026-07-06', start_time: 1, distance_km: 4, duration_min: 30, category: 'unknown',
    start_lat: pts[0].lat, start_lng: pts[0].lng,
    end_lat: pts[pts.length - 1].lat, end_lng: pts[pts.length - 1].lng,
    polyline: pts.map((p, i) => ({ lat: p.lat, lng: p.lng, t: i * 60000 })),
  }, extra || {});
}
// A lap around inside Site A.
const lapInA = [0, 400, 900, 1400, 900, 300].map(d => northOf(SITE_A, d));

console.log('Intra-site: the five specified fixtures');
// 1. wholly within one fence
ok('FIXTURE 1: a trip fully inside one fence is intra-site',
   classifyIntraSite(tripOf('f1', lapInA), SITES).intraSite === true);
ok('FIXTURE 1: it names the site it was inside',
   classifyIntraSite(tripOf('f1', lapInA), SITES).site_id === 'sA');
// 2. across two fences → inter-site travel
ok('FIXTURE 2: Site A → Site B is NOT intra-site (it is business travel)',
   classifyIntraSite(tripOf('f2', [northOf(SITE_A, 0), { lat: -28.62, lng: 152.00 }, northOf(SITE_B, 0)]), SITES).intraSite === false);
// 3. 30m boundary excursion, twice, returning
ok('FIXTURE 3: two 30m drifts beyond the edge stay intra-site',
   classifyIntraSite(tripOf('f3', [
     northOf(SITE_A, 0), northOf(SITE_A, 2930), northOf(SITE_A, 1200),
     northOf(SITE_A, 2925), northOf(SITE_A, 500),
   ]), SITES).intraSite === true);
// 4. 200m excursion → a real trip
ok('FIXTURE 4: a 200m excursion makes it a real trip',
   classifyIntraSite(tripOf('f4', [
     northOf(SITE_A, 0), northOf(SITE_A, 3100), northOf(SITE_A, 500),
   ]), SITES).intraSite === false);
// 5. transit: starts and ends far outside, ~30% of points inside a fence
const transit = [];
for (let i = 0; i < 10; i++) transit.push({ lat: -28.90 + i * 0.02, lng: 152.06 });   // sweeps through A
ok('FIXTURE 5: transit through a site is NOT intra-site',
   classifyIntraSite(tripOf('f5', transit), SITES).intraSite === false);
const insideCount = transit.filter(p => pointInFence(p.lat, p.lng, SITE_A, 50)).length;
ok('FIXTURE 5: …and it genuinely does pass through the fence (some points inside)',
   insideCount > 0 && insideCount < transit.length, { insideCount, of: transit.length });

console.log('Intra-site: safe defaults');
ok('no sites defined → real trip', classifyIntraSite(tripOf('n1', lapInA), []).intraSite === false);
ok('no sites defined → reason says so', classifyIntraSite(tripOf('n1', lapInA), []).reason === 'no sites defined');
ok('no positions → real trip', classifyIntraSite({ id: 'n2', distance_km: 5 }, SITES).intraSite === false);
ok('null trip → real trip', classifyIntraSite(null, SITES).intraSite === false);
ok('endpoints used when there is no polyline',
   tripPoints({ start_lat: 1, start_lng: 2, end_lat: 3, end_lng: 4 }).length === 2);
ok('polyline preferred over endpoints', tripPoints(tripOf('n3', lapInA)).length === lapInA.length);
ok('a manual trip with no coordinates is judged on nothing → real',
   classifyIntraSite({ id: 'n4', distance_km: 12, auto: false }, SITES).intraSite === false);

console.log('Intra-site: flag application respects a human override');
const flagged = applyIntraSiteFlags([tripOf('a1', lapInA), tripOf('a2', transit)], SITES);
ok('lap flagged, transit not', isIntraSite(flagged.trips[0]) === true && isIntraSite(flagged.trips[1]) === false);
ok('site recorded on the flagged trip', flagged.trips[0].intraSite_site === 'sA');
// Only the positive case is written. A travel trip is left untouched rather
// than stamped intraSite:false, so classifying does not rewrite every record.
ok('only the on-site trip is rewritten', flagged.changed === 1, flagged.changed);
ok('travel trip left byte-identical', !('intraSite' in flagged.trips[1]));
ok('re-running changes nothing (idempotent)', applyIntraSiteFlags(flagged.trips, SITES).changed === 0);
ok('inputs are never mutated', tripOf('a1', lapInA).intraSite === undefined);
const overridden = applyIntraSiteFlags(
  [tripOf('m1', lapInA, { intraSite: false, intraSite_manual: true })], SITES);
ok('a user reclassification is never overwritten', overridden.trips[0].intraSite === false);
ok('…and is not counted as a change', overridden.changed === 0);
ok('intraSiteLocked detects the override', intraSiteLocked({ intraSite_manual: true }) === true);

console.log('Intra-site: day maths exclude it');
const dayMix = [
  tripOf('d1', lapInA, { date: '2026-07-06', distance_km: 6.0, category: 'unknown', intraSite: true }),
  tripOf('d2', lapInA, { date: '2026-07-06', distance_km: 3.5, category: 'unknown', intraSite: true }),
  tripOf('d3', transit, { date: '2026-07-06', distance_km: 40.0, category: 'business' }),
  tripOf('d4', transit, { date: '2026-07-06', distance_km: 10.0, category: 'personal' }),
];
const mixStrip = buildDayStrip(dayMix, '2026-07');
const mixDay = mixStrip[5];
ok('day km counts travel only (40 + 10, not 49.5)', mixDay.km === 50, mixDay.km);
ok('on-site km reported separately (9.5)', mixDay.onSiteKm === 9.5, mixDay.onSiteKm);
ok('on-site count reported (2)', mixDay.onSiteCount === 2, mixDay.onSiteCount);
ok('travel count excludes on-site (2)', mixDay.travelCount === 2, mixDay.travelCount);
ok('total count still counts everything (4)', mixDay.count === 4, mixDay.count);
ok('business km unaffected by on-site', mixDay.businessKm === 40);
ok('private km unaffected by on-site', mixDay.privateKm === 10);
ok('untagged on-site trips do NOT make the day pending', mixDay.pending === 0, mixDay.pending);
ok('day status ignores on-site trips', mixDay.status === 'tagged', mixDay.status);
const mixSum = periodSummary(mixStrip);
ok('period total km is travel only', mixSum.totalKm === 50, mixSum.totalKm);
ok('period business % computed on travel (80%)', mixSum.businessPct === 80, mixSum.businessPct);
ok('period reports on-site km + count', mixSum.onSiteKm === 9.5 && mixSum.onSiteCount === 2);
ok('period travelTrips excludes on-site', mixSum.travelTrips === 2, mixSum.travelTrips);
// A day of nothing but paddock laps is settled, not waiting on a decision.
const onlyOnSite = buildDayStrip([
  tripOf('o1', lapInA, { date: '2026-07-09', distance_km: 5, intraSite: true }),
], '2026-07');
ok('a day of only on-site movement reads "onsite"', onlyOnSite[8].status === 'onsite', onlyOnSite[8].status);
ok('…contributes 0 travel km', onlyOnSite[8].km === 0);
ok('…and is not pending', onlyOnSite[8].pending === 0);
ok('bar normalisation uses travel km, so an on-site-only day has no bar', onlyOnSite[8].bar === 0);

console.log('Intra-site: approval, filters and segments');
// d1/d2 are on-site (nothing to decide); d3/d4 are genuine travel with
// categories, so they remain approvable.
const mixPlan = approvalPlan(dayMix);
ok('approve-all offers only the travel trips', mixPlan.approve.map(a => a.id).join(',') === 'd3,d4',
   mixPlan.approve.map(a => a.id));
ok('approve-all never lists an on-site trip',
   !mixPlan.approve.concat(mixPlan.skip.map(id => ({ id }))).some(a => a.id === 'd1' || a.id === 'd2'));
ok('approve-all skips nothing here', mixPlan.skip.length === 0);
ok('approve-all still offers a genuine untagged travel trip',
   approvalPlan([tripOf('x', transit, { category: 'unknown', suggest_category: 'business' })]).approve.length === 1);
ok('business filter excludes on-site', filterTripsBy(dayMix, 'business').length === 1);
ok('pending filter excludes on-site', filterTripsBy(dayMix, 'pending').length === 0);
ok('onsite filter isolates them', filterTripsBy(dayMix, 'onsite').length === 2);
ok('all still returns everything', filterTripsBy(dayMix, 'all').length === 4);
const mixSegs = daySegments(dayMix);
ok('segments flag on-site', mixSegs[0].intraSite === true && mixSegs[2].intraSite === false);
ok('on-site segment status is "onsite" (never pending)', mixSegs[0].status === 'onsite');
ok('travel segment keeps its real status', mixSegs[2].status === 'tagged');

// ── CROSS-CHECK: two independent implementations of the same predicate ───────
// The shipped predicate is geodesic distance vs radius. This checks it against
// ray-casting point-in-polygon over the SAME fence polygonised — a genuinely
// different algorithm. Turf.js is used when installed (third-party, independent);
// a local ray-caster always runs, so the cross-check never silently disappears.
console.log('Intra-site: cross-check vs an independent implementation');
function circleToPolygon(site, steps) {
  const ring = [], R = 6371000, latR = site.lat * Math.PI / 180;
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * 2 * Math.PI;
    const dLat = (site.radius * Math.cos(th)) / R * (180 / Math.PI);
    const dLng = (site.radius * Math.sin(th)) / (R * Math.cos(latR)) * (180 / Math.PI);
    ring.push([site.lng + dLng, site.lat + dLat]);
  }
  ring.push(ring[0]);
  return ring;
}
// Classic ray casting (Jordan curve), independent of any distance formula.
function rayCastInside(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
let turf = null;
try {
  const c = require('@turf/circle');
  const b = require('@turf/boolean-point-in-polygon');
  turf = { circle: c.circle || c.default || c, inside: b.booleanPointInPolygon || b.default || b };
} catch (_) { /* optional */ }

// Sample a grid around Site A and require both methods to agree. Points within
// 15m of the boundary are skipped: polygonisation is an approximation there, so
// disagreement is expected geometry, not a bug in either implementation.
let compared = 0, disagreeLocal = 0, disagreeTurf = 0;
const ringA = circleToPolygon(SITE_A, 720);
const turfA = turf ? turf.circle([SITE_A.lng, SITE_A.lat], SITE_A.radius / 1000, { steps: 720, units: 'kilometers' }) : null;
for (let dy = -4000; dy <= 4000; dy += 250) {
  for (let dx = -4000; dx <= 4000; dx += 250) {
    const lat = SITE_A.lat + mLat(dy);
    const lng = SITE_A.lng + (dx / 110574) / Math.cos(SITE_A.lat * Math.PI / 180);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (Math.abs(d - SITE_A.radius) < 15) continue;
    compared++;
    const shipped = pointInFence(lat, lng, SITE_A, 0);
    if (shipped !== rayCastInside(lat, lng, ringA)) disagreeLocal++;
    if (turfA && shipped !== turf.inside([lng, lat], turfA)) disagreeTurf++;
  }
}
ok('cross-check sampled a meaningful grid', compared > 800, compared);
ok('shipped predicate agrees with ray-casting point-in-polygon everywhere',
   disagreeLocal === 0, { disagreements: disagreeLocal, of: compared });
if (turf) {
  ok('shipped predicate agrees with Turf.js booleanPointInPolygon everywhere',
     disagreeTurf === 0, { disagreements: disagreeTurf, of: compared });
} else {
  console.log('  … Turf.js not installed — ran the local ray-caster only (npm i -D @turf/circle @turf/boolean-point-in-polygon)');
}

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

// test_intra_site_trip_filters_from_km_total
// Steven's ONE real captured trip (2026-07-27, 35.54 km) spans ~24 km between
// its endpoints, against fences of 2900 m and 1050 m — the real radii. The
// on-site rule must NOT swallow it: a classifier that erased his only captured
// trip would be worse than no classifier. Geometry matches the real record;
// absolute coordinates are synthetic because this repo is public.
console.log('REGRESSION PIN: test_intra_site_trip_filters_from_km_total');
const REAL_SITES = [
  { id: 'sr1', name: 'Big Fence', lat: -28.7300, lng: 152.0700, radius: 2900 },
  { id: 'sr2', name: 'Small Fence', lat: -28.5100, lng: 151.9400, radius: 1050 },
];
const realTrip = REAL_SHAPE[0];
ok('pin: the real captured trip is NOT classified as on-site',
   classifyIntraSite(realTrip, REAL_SITES).intraSite === false,
   classifyIntraSite(realTrip, REAL_SITES));
ok('pin: …and its 35.54 km stays in the travel total',
   periodSummary(buildDayStrip(applyIntraSiteFlags([realTrip], REAL_SITES).trips, '2026-07')).totalKm === 35.54);
ok('pin: …contributing 0 on-site km',
   periodSummary(buildDayStrip(applyIntraSiteFlags([realTrip], REAL_SITES).trips, '2026-07')).onSiteKm === 0);
// The complement: a lap inside the big fence IS filtered out of the km total.
const yardLap = {
  id: 'yard', date: '2026-07-27', start_time: 5, distance_km: 7.25, duration_min: 40, category: 'unknown',
  polyline: [0, 800, 1600, 700, 100].map((m, i) => ({
    lat: REAL_SITES[0].lat + m / M_PER_DEG_LAT, lng: REAL_SITES[0].lng, t: i * 60000 })),
};
const bothFlagged = applyIntraSiteFlags([realTrip, yardLap], REAL_SITES).trips;
const bothSum = periodSummary(buildDayStrip(bothFlagged, '2026-07'));
ok('pin: a yard lap inside the big fence IS filtered from km total',
   bothSum.totalKm === 35.54, bothSum.totalKm);
ok('pin: …and is reported as on-site instead', bothSum.onSiteKm === 7.25, bothSum.onSiteKm);
ok('pin: …without being deleted', bothFlagged.length === 2);
ok('pin: the day still shows both trips', buildDayStrip(bothFlagged, '2026-07')[26].count === 2);


console.log('\n── v105.2: Steven\'s Thursday 30 Jul, from the screenshot ──────');
{
  // Header read: "109.2 km travel · 6 trips · 92.5 km business · +7 on-site (24.1 km)"
  const T0 = Date.parse('2026-07-30T08:00:00');
  let n = 0;
  const t = (km, cat, onsite) => Object.assign({
    id: 't' + (++n), date: '2026-07-30', category: cat, distance_km: km,
    duration_min: 10, start_time: T0 + n * 6e5, end_time: T0 + n * 6e5 + 6e5
  }, onsite ? { intraSite: true, intraSite_site: 'Lucas Ranch' } : {});
  const trips = [t(40.0, 'business'), t(30.0, 'business'), t(22.5, 'business'),
                 t(10.0, 'personal'), t(4.7, 'unknown'), t(2.0, 'unknown')];
  [4.0, 3.5, 3.4, 3.6, 3.2, 3.2, 3.2].forEach(k => trips.push(t(k, 'unknown', true)));

  const rows = buildDayStrip(filterTripsBy(trips, 'all'), '2026-07');
  const day = rows.filter(r => r.date === '2026-07-30')[0];

  console.log('  ── PIN: test_daily_total_km_excludes_on_site_trips');
  ok('PIN: the day headline is 109.2 km', day.km === 109.2, day.km);
  ok('PIN: on-site is 7 trips / 24.1 km, reported separately',
     day.onSiteCount === 7 && day.onSiteKm === 24.1, { c: day.onSiteCount, km: day.onSiteKm });
  ok('PIN: the headline EXCLUDES on-site — adding it would give 133.3',
     day.km !== +(day.km + day.onSiteKm).toFixed(1) && +(day.km + day.onSiteKm).toFixed(1) === 133.3);
  ok('PIN: …and the headline reconciles exactly as travel-only',
     +(day.businessKm + day.privateKm + 6.7).toFixed(1) === day.km,
     { b: day.businessKm, p: day.privateKm, total: day.km });
  ok('PIN: business is 92.5', day.businessKm === 92.5, day.businessKm);
  ok('PIN: the 16.7 km gap is private + untagged travel, NOT on-site',
     +(day.km - day.businessKm).toFixed(1) === 16.7 && day.privateKm === 10);
  ok('PIN: only the 6 travel trips are counted as trips', day.travelCount === 6, day.travelCount);
  ok('PIN: an on-site trip contributes zero to business km', (() => {
      const noOnsite = buildDayStrip(filterTripsBy(trips.filter(x => !isIntraSite(x)), 'all'), '2026-07')
        .filter(r => r.date === '2026-07-30')[0];
      return noOnsite.km === day.km && noOnsite.businessKm === day.businessKm;
    })());

  console.log('  ── PIN: test_monthly_total_km_excludes_on_site_trips');
  const sum = periodSummary(rows);
  ok('PIN: the month total is travel only', sum.totalKm === 109.2, sum.totalKm);
  ok('PIN: …with on-site carried alongside', sum.onSiteKm === 24.1 && sum.onSiteCount === 7);
  ok('PIN: …never folded in', sum.totalKm + sum.onSiteKm !== sum.totalKm);
  ok('PIN: business % is computed on travel only, not travel+on-site',
     sum.businessPct === Math.round((92.5 / 109.2) * 100), sum.businessPct);

  console.log('  ── PIN: test_on_site_trips_collapse_to_single_summary_row_per_day');
  const segs = daySegments(trips);
  ok('PIN: daySegments still returns every trip', segs.length === 13, segs.length);
  const g = groupOnSiteSegments(segs);
  ok('PIN: the travel rows stay individual', g.travel.length === 6, g.travel.length);
  ok('PIN: …and none of them is on-site', g.travel.every(x => !x.intraSite));
  ok('PIN: the 7 on-site rows fold into ONE group', !!g.group && g.group.count === 7);
  ok('PIN: …carrying their combined km', g.group.km === 24.1, g.group.km);
  ok('PIN: …and naming the site when they share one', g.group.siteName === 'Lucas Ranch');
  ok('PIN: …so the sheet draws 7 rows, not 13', g.travel.length + 1 === 7);
  ok('PIN: the individual rows are kept for expansion', g.onsite.length === 7);
  ok('PIN: …and their ids are retained', g.group.ids.length === 7 && g.group.ids[0] === segs.filter(x => x.intraSite)[0].id);
  ok('PIN: a day with no on-site movement gets no group row',
     groupOnSiteSegments(daySegments(trips.filter(x => !isIntraSite(x)))).group === null);
  ok('PIN: a day of ONLY on-site movement is one row',
     (() => { const o = groupOnSiteSegments(daySegments(trips.filter(isIntraSite)));
              return o.travel.length === 0 && o.group.count === 7; })());
  ok('PIN: mixed sites do not claim a single name', (() => {
      const mixed = daySegments([t(1, 'unknown', true), Object.assign(t(1, 'unknown', true), { intraSite_site: 'Other' })]);
      return groupOnSiteSegments(mixed).group.siteName === null;
    })());
  ok('PIN: empty and null are safe',
     groupOnSiteSegments([]).group === null && groupOnSiteSegments(null).group === null);

  console.log('  ── the grouping is display-only');
  ok('PIN: it changes no km figure', (() => {
      const after = buildDayStrip(filterTripsBy(trips, 'all'), '2026-07').filter(r => r.date === '2026-07-30')[0];
      return after.km === day.km && after.businessKm === day.businessKm && after.onSiteKm === day.onSiteKm;
    })());
  ok('PIN: …and no trip record', trips.every(x => x.distance_km > 0));
  ok('PIN: business/private/skip rows are untouched by it',
     g.travel.filter(x => x.category === 'business').length === 3 &&
     g.travel.filter(x => x.category === 'personal').length === 1 &&
     g.travel.filter(x => x.status === 'pending').length === 2);
}

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
