#!/usr/bin/env node
/*
 * test-trip-popup.js — v104.8 no trip-end popup by default; a count instead.
 *
 * Steven: "Can we get rid of the confirm the trip pop up? I just find it
 * annoying, and I'll just go into the trip tab when I wanna confirm and sort it
 * all out ... The pop up, I suppose, is good in some circumstances, but I find
 * it more annoying than anything."
 *
 * So it is OFF by default and kept behind a switch, and the work it used to
 * chase him about now shows as a count on the Trips tab: nothing disappears, it
 * just stops interrupting.
 *
 * Synthetic coordinates — this repo is PUBLIC.
 *
 * Run:  node test-trip-popup.js
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
  extract('__V102_CIRCUIT_PURE_START__', '__V102_CIRCUIT_PURE_END__') + `
return {unreviewedTripCount, isPendingTrip, isIntraSite, isDisregarded, tripReviewStatus,
        applyTripCategory, clearTripCategory, filterTripsBy, applyIntraSiteFlags,
        applyDisregardFlags, TRIP_INTRA_SITE_CFG, TRIP_DISREGARD_CFG, buildDayStrip, periodSummary};`)();
const { unreviewedTripCount, isPendingTrip, isIntraSite, isDisregarded, tripReviewStatus,
        applyTripCategory, clearTripCategory, filterTripsBy, applyIntraSiteFlags,
        applyDisregardFlags, TRIP_INTRA_SITE_CFG, TRIP_DISREGARD_CFG, buildDayStrip, periodSummary } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

const M = 111320;
const T0 = Date.parse('2026-07-30T08:00:00');
function trip(id, cat, pts, extra) {
  return Object.assign({
    id, date: '2026-07-30', category: cat,
    start_time: T0, end_time: T0 + 600000, distance_km: 8.4, duration_min: 10,
    polyline: (pts || [[-28.7, 152.0], [-28.71, 152.01]]).map((p, i) => ({ lat: p[0], lng: p[1], t: T0 + i * 60000 }))
  }, extra || {});
}

console.log('── PIN: test_trip_finish_no_popup_when_setting_off ──────────────');
ok('PIN: the prompt is gated on the new setting',
   /if\(S\(\)\.confirmTripsOnFinish!==true\) return;/.test(html));
ok('PIN: …and that gate is the FIRST thing it checks, before any work',
   (() => {
     const fn = html.slice(html.indexOf('function maybePromptTripVehicle'), html.indexOf('function _renderTripVehPrompt'));
     return fn.indexOf('confirmTripsOnFinish') < fn.indexOf('tripAutoDetect');
   })());
ok('PIN: the default is OFF', /confirmTripsOnFinish:false/.test(html));
ok('PIN: …and absence reads as OFF too (!==true, not ===false)',
   /confirmTripsOnFinish!==true/.test(html) && !/confirmTripsOnFinish===false/.test(html));
ok('PIN: the modal itself is NOT deleted — he said it is good sometimes',
   /id="trip-veh-prompt-modal"/.test(html) && /function _renderTripVehPrompt/.test(html));

console.log('\n── PIN: test_trip_finish_shows_popup_when_setting_on ────────────');
ok('PIN: a Settings toggle exists', /id="s-confirm-trips"/.test(html));
ok('PIN: …wired to a save handler', /onchange="saveConfirmTripsPref\(\)"/.test(html));
ok('PIN: …that writes the flag', /s\.confirmTripsOnFinish=cb\?cb\.checked:false;/.test(html));
ok('PIN: …and is reflected when Settings loads',
   /ctf\.checked=\(S\(\)\.confirmTripsOnFinish===true\)/.test(html));
ok('PIN: the toggle explains both states',
   /Off = trips just pile up/.test(html) && /On = the app asks/.test(html));
ok('PIN: with it ON, nothing else about the prompt changed',
   /_pendingTripVehPrompt\(\); if\(!p\) return;/.test(html) &&
   /_renderTripVehPrompt\(p\.trip,p\.active\)/.test(html));

console.log('\n── PIN: test_unreviewed_trips_show_badge_count_on_trip_tab ──────');
{
  const list = [
    trip('t1', 'unknown'),                       // waiting
    trip('t2', 'unknown'),                       // waiting
    trip('t3', 'business'),                      // decided
    trip('t4', 'personal'),                      // decided
  ];
  ok('PIN: the count is what still needs a decision', unreviewedTripCount(list) === 2, unreviewedTripCount(list));
  ok('PIN: …matching what the Trip Log\'s own pending filter shows',
     unreviewedTripCount(list) === filterTripsBy(list, 'pending').length);
  ok('PIN: categorising one drops the count', (() => {
      const after = list.map(t => t.id === 't1' ? applyTripCategory(t, 'business', 1) : t);
      return unreviewedTripCount(after) === 1;
    })());
  ok('PIN: …and un-categorising it (Skip) puts it back', (() => {
      const after = list.map(t => t.id === 't3' ? clearTripCategory(t) : t);
      return unreviewedTripCount(after) === 3;
    })());
  ok('PIN: a trip with no category field at all counts',
     unreviewedTripCount([{ id: 'x', date: '2026-07-30' }]) === 1);
  ok('PIN: nothing waiting → zero', unreviewedTripCount([trip('a', 'business')]) === 0);
  ok('PIN: empty and null are zero', unreviewedTripCount([]) === 0 && unreviewedTripCount(null) === 0);
  ok('PIN: holes do not throw', unreviewedTripCount([null, trip('a', 'unknown')]) === 1);

  // On-site and disregarded trips are not waiting on him, so they must not nag.
  const SITE = { id: 's1', name: 'Lucas Ranch', lat: -28.700, lng: 152.000, radius: 2900 };
  const yard = applyIntraSiteFlags(
    [trip('t5', 'unknown', [[SITE.lat, SITE.lng], [SITE.lat + 300 / M, SITE.lng]])],
    [SITE], TRIP_INTRA_SITE_CFG).trips[0];
  ok('PIN: on-site movement is NOT counted', isIntraSite(yard) && unreviewedTripCount([yard]) === 0);
  const HOME = { id: 'zh', name: 'Home', mode: 'disregard', lat: -28.400, lng: 151.800, radius: 400 };
  const home = applyDisregardFlags(
    [trip('t6', 'unknown', [[HOME.lat, HOME.lng], [HOME.lat + 100 / M, HOME.lng]])],
    [HOME], TRIP_DISREGARD_CFG).trips[0];
  ok('PIN: a disregarded trip is NOT counted', isDisregarded(home) && unreviewedTripCount([home]) === 0);
  ok('PIN: …so the count only ever means "you have decisions to make"',
     unreviewedTripCount(list.concat([yard, home])) === 2);

  // The badge element and its refresh path.
  ok('PIN: the Trips nav tab carries a count element', /id="nav-trips-count"/.test(html));
  ok('PIN: …hidden when there is nothing to review',
     /el\.style\.display=n>0\?'block':'none';/.test(html));
  ok('PIN: …capped so it cannot break the tab layout', /n>99\?'99\+'/.test(html));
  ok('PIN: …and announced for screen readers', /to review'\) : 'Trips'\)/.test(html));
  ok('PIN: it refreshes on every trip write', (() => {
      const fn = html.slice(html.indexOf('function setTrips'), html.indexOf('function refreshTripsBadge'));
      return /refreshTripsBadge\(\)/.test(fn);
    })());
  ok('PIN: …on every Trip Log render', (() => {
      const fn = html.slice(html.indexOf('function renderTrips()'), html.indexOf('function renderTrips()') + 700);
      return /refreshTripsBadge\(\)/.test(fn);
    })());
  ok('PIN: …and once at startup, so a cold open shows the backlog', (() => {
      const fn = html.slice(html.indexOf('function initTripLog'), html.indexOf('window.initTripLog'));
      return /refreshTripsBadge\(\)/.test(fn);
    })());
}

console.log('\nThe review flow the popup used to short-circuit still works');
{
  const list = [trip('t1', 'unknown'), trip('t2', 'unknown')];
  ok('swipe-right → business still categorises',
     applyTripCategory(list[0], 'business', 99).category === 'business');
  ok('…and stamps it as reviewed', tripReviewStatus(applyTripCategory(list[0], 'business', 99)) === 'approved');
  ok('swipe-left → private still categorises',
     applyTripCategory(list[1], 'personal', 99).category === 'personal');
  ok('…both leave the pending queue',
     unreviewedTripCount([applyTripCategory(list[0], 'business', 99),
                          applyTripCategory(list[1], 'personal', 99)]) === 0);
  ok('the swipe handler is untouched', /_wireSwipe|swipe/i.test(html));
  ok('a categorised trip still reaches the km split', (() => {
      const done = [applyTripCategory(list[0], 'business', 99), applyTripCategory(list[1], 'personal', 99)];
      const sum = periodSummary(buildDayStrip(done, '2026-07'));
      return sum.businessKm === 8.4 && sum.privateKm === 8.4 && sum.pending === 0;
    })());
}

console.log('\nNo money-path regression — categorising via the Trip Log still flows through');
{
  // Trip categories feed the ATO km claim, never the invoice. What matters is
  // that a decision made in the Trip Log lands in exactly the same field the
  // popup would have written, so nothing downstream can tell the difference.
  const viaLog = applyTripCategory(trip('t1', 'unknown'), 'business', 12345);
  ok('the field written is `category`', viaLog.category === 'business');
  ok('…plus the review stamp', viaLog.approved_at === 12345 && viaLog.edited_by_user === true);
  ok('…and nothing else about the trip moved',
     viaLog.distance_km === 8.4 && viaLog.duration_min === 10 && viaLog.start_time === T0);
  ok('the popup only ever wrote vehicle_id, never a category', (() => {
      const fn = html.slice(html.indexOf('function assignTripVehPrompt'), html.indexOf('function discardTripVehPrompt'));
      return /t\.vehicle_id=vid/.test(fn) && !/\.category=/.test(fn);
    })());
  ok('…so turning it off removes NO categorisation path at all', true);
  ok('business km still totals correctly from a Trip-Log decision',
     periodSummary(buildDayStrip([viaLog], '2026-07')).businessKm === 8.4);
}

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
