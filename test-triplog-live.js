#!/usr/bin/env node
/*
 * test-triplog-live.js — v101.6 JS-side tests against the LIVE app in the
 * emulator (Chrome DevTools Protocol). Called by test-triplog-service.sh.
 *
 * These exercise the REAL shipped functions in the real app — not a copy — so
 * they catch wiring bugs the pure tests structurally cannot:
 *   • applyBankedTripFixes() turns a natively-banked fix stream into trips
 *   • replay is idempotent (a re-drain must not double-log)
 *   • _sealStaleActiveDay() clears the stuck record AND unblocks auto-start
 *   • the native trip-logging bridge reports honest running state
 *   • Setup Health surfaces trip logging without ever making it blocking
 */
const { connect, evalInApp } = require('./cdp-lib');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('    ✓ ' + name); }
  else { fail++; console.log('    ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

// A realistic banked stream: 2 min parked, ~30 min at ~36 km/h, 6 min stopped.
// The base time is computed ONCE and cached on window, so the idempotency test
// really does replay the SAME stream. (Regenerating it per call produced fresh
// timestamps → different derived ids → a false idempotency failure. The bug was
// in the test, but it is exactly the mistake the product must not make.)
const SEED_FIXES = `(window.__seedFixes || (window.__seedFixes = (function(){
  var base = Date.now() - 6*3600000, lat=-28.650, lng=151.930, t=base, f=[];
  for(var i=0;i<4;i++){ f.push({lat:lat,lng:lng,t:t,acc:8}); t+=30000; }
  for(var j=0;j<60;j++){ lat-=0.0027; f.push({lat:lat,lng:lng,t:t,acc:8}); t+=30000; }
  for(var k=0;k<12;k++){ f.push({lat:lat,lng:lng,t:t,acc:8}); t+=30000; }
  return f;
})()))`;

(async () => {
  const { ws } = await connect();
  const ev = (e) => evalInApp(ws, e);

  // ── version + wiring present ───────────────────────────────────────────────
  // Read the expected version from source rather than pinning a literal: this
  // assertion exists to catch "the emulator is running a stale build", not to
  // fail every time APP_VERSION is legitimately bumped (which it did on v101.7).
  const SRC_VERSION = (require('fs')
    .readFileSync(require('path').join(__dirname, 'www', 'index.html'), 'utf8')
    .match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
  const ver = await ev('APP_VERSION');
  ok('emulator is running the build in www/ (' + SRC_VERSION + ')', ver === SRC_VERSION,
     { running: ver, source: SRC_VERSION });
  ok('applyBankedTripFixes is wired', await ev('typeof applyBankedTripFixes') === 'function');
  ok('_sealStaleActiveDay is wired', await ev('typeof window._sealStaleActiveDay') === 'function');
  ok('ensureTripLogging is wired (re-arm path)', await ev('typeof window.ensureTripLogging') === 'function');
  ok('drainTripFixes is wired', await ev('typeof window.drainTripFixes') === 'function');

  // ── native bridge reports honest state ─────────────────────────────────────
  const st = await ev(`(async()=>{const ng=window.Capacitor.Plugins.NativeGeo;
    if(!ng||typeof ng.getTripLoggingStatus!=='function') return null;
    return await ng.getTripLoggingStatus();})()`);
  ok('native getTripLoggingStatus bridge exists', st !== null, st);
  if (st) {
    ok('trip logging is ENABLED', st.enabled === true, st);
    ok('trip logging service is RUNNING', st.running === true, st);
    ok('no recorded startup error', !st.error, st.error);
  }

  // ── TEST 4: reconstruction from a banked stream ────────────────────────────
  await ev(`(function(){ DB.set('trips',[]); localStorage.removeItem('mcn_activeTrip'); return 1; })()`);
  const added = await ev(`applyBankedTripFixes(${SEED_FIXES})`);
  ok('banked stream produced exactly 1 trip', added === 1, added);

  const trip = await ev(`(function(){ var a=trips(); return a.length?{n:a.length,km:a[0].distance_km,auto:a[0].auto,id:a[0].id,pts:(a[0].polyline||[]).length,cat:a[0].category}:{n:0}; })()`);
  ok('trip stored in mcn_trips', trip.n === 1, trip);
  ok('distance ≈ 18km', trip.km >= 16 && trip.km <= 20, trip.km);
  ok('marked auto-captured', trip.auto === true, trip.auto);
  ok('polyline preserved for the map preview', trip.pts > 5, trip.pts);
  ok('category starts as unknown (user tags it)', trip.cat === 'unknown', trip.cat);

  const again = await ev(`applyBankedTripFixes(${SEED_FIXES})`);
  ok('PIN: replaying the same stream adds nothing (idempotent)', again === 0, again);
  const nAfter = await ev(`trips().length`);
  ok('still exactly 1 trip after replay', nAfter === 1, nAfter);

  // A trip still in progress must be carried, not force-closed into history.
  await ev(`(function(){ DB.set('trips',[]); localStorage.removeItem('mcn_activeTrip'); return 1; })()`);
  const warmAdded = await ev(`applyBankedTripFixes((function(){
      var base=Date.now()-32*60000, lat=-28.650, t=base, f=[];
      for(var i=0;i<4;i++){ f.push({lat:lat,lng:151.930,t:t,acc:8}); t+=30000; }
      for(var j=0;j<60;j++){ lat-=0.0027; f.push({lat:lat,lng:151.930,t:t,acc:8}); t+=30000; }
      return f; })())`);
  ok('mid-drive stream logs 0 completed trips', warmAdded === 0, warmAdded);
  ok('mid-drive stream becomes the LIVE activeTrip', await ev(`!!activeTrip()`) === true);
  await ev(`(function(){ localStorage.removeItem('mcn_activeTrip'); DB.set('trips',[]); return 1; })()`);

  // ── TEST 5: the stuck activeDay ────────────────────────────────────────────
  // Steven's real record, as read from Firestore users/{uid}/data/activeDay.
  await ev(`(function(){
    DB.set('unconfirmed',[]);
    DB.set('activeDay',{id:'mridhdq89hyul',site:'Lds',start:'08:30',date:'2026-07-12',
      startTs:1783809047318,finish:null,finishTs:null,rate:60,sonrate:30,sonWorking:false,
      sonHours:null,lunchMins:5,lunchStart:null,machines:[],autoStarted:true,
      rawStart:'08:30',rawFinish:null,status:'UNCONFIRMED',edited_by_user:false,
      createdAt:1783809047318,merged:true});
    geoAutoStartTriggered = true;   // as it would be after that day's auto-start
    return 1; })()`);

  ok('precondition: a stuck activeDay exists', await ev(`!!activeDay()`) === true);
  ok('precondition: auto-start is blocked by it', await ev(`!!activeDay()`) === true);

  const sealed = await ev(`window._sealStaleActiveDay()`);
  ok('PIN: the 15-day stuck activeDay is sealed', sealed === true, sealed);
  ok('activeDay cleared → auto-start unblocked', await ev(`activeDay()===null`) === true);
  ok('geoAutoStartTriggered re-armed', await ev(`geoAutoStartTriggered===false`) === true);

  const backlog = await ev(`(function(){ var u=unconfirmed(); return {n:u.length, site:u[0]&&u[0].site, status:u[0]&&u[0].status, finish:u[0]&&u[0].finish}; })()`);
  ok('sealed into the review backlog', backlog.n === 1 && backlog.site === 'Lds', backlog);
  ok('status UNCONFIRMED (not billable)', backlog.status === 'UNCONFIRMED', backlog.status);
  ok('finish left unset — no invented hours', !backlog.finish, backlog.finish);
  ok('MONEY GUARD: it did NOT land in days[]',
     await ev(`days().filter(d=>d&&d.id==='mridhdq89hyul').length===0`) === true);

  // A same-day running session must be left completely alone.
  await ev(`(function(){ DB.set('unconfirmed',[]);
    DB.set('activeDay',{id:'fresh1',site:'Lucas Ranch',start:'07:00',date:'2026-07-27',
      startTs:Date.now()-3*3600000,finish:null,rate:60}); return 1; })()`);
  ok('a 3h-old running session is NOT sealed', await ev(`window._sealStaleActiveDay()`) === false);
  ok('…and its activeDay survives', await ev(`!!activeDay()`) === true);
  await ev(`(function(){ DB.set('activeDay',null); DB.set('unconfirmed',[]); return 1; })()`);

  // ── Health card ────────────────────────────────────────────────────────────
  const h = await ev(`(async()=>{const r=await Health.run();
    const t=r.checks.find(c=>c.id==='triplog');
    return {found:!!t,status:t&&t.status,critical:t&&t.critical,detail:t&&t.detail,
            criticalFails:r.criticalFails.length};})()`);
  ok('Health has a trip-logging row', h.found === true, h);
  ok('trip logging reports PASS (service running)', h.status === 'pass', h);
  ok('MONEY/SHIFT GUARD: trip logging is never critical', h.critical === false, h.critical);
  ok('no critical fails introduced', h.criticalFails === 0, h.criticalFails);

  // ── OTA-ahead-of-APK: newer JS on an older APK ─────────────────────────────
  // This is Steven's actual situation the moment v101.6 OTAs to a phone still
  // running the v101.4 APK, and it is the exact shape of the v92.1 Health bug
  // (0-of-0 rendered as a green "All good"). The trip row must degrade to a
  // greyed n/a — never a false green, and never anything that blocks Start Day.
  const oldApk = await ev(`(async()=>{
    const raw = await window.Capacitor.Plugins.NativeGeo.getHealthStatus();
    delete raw.tripLogging;                      // an APK without the v101.6 bridge
    const r = await Health.run(raw);
    const t = r.checks.find(c=>c.id==='triplog');
    return {status:t&&t.status, critical:t&&t.critical, detail:t&&t.detail,
            criticalFails:r.criticalFails.length, bridgeUnavailable:r.bridgeUnavailable};})()`);
  ok('old APK → trip row is n/a, not a false green', oldApk.status === 'na', oldApk);
  ok('old APK → tells the user to update', /[Uu]pdate the app/.test(oldApk.detail || ''), oldApk.detail);
  ok('old APK → still never critical', oldApk.critical === false, oldApk.critical);
  ok('old APK → introduces no critical fails (Start Day stays open)',
     oldApk.criticalFails === 0, oldApk.criticalFails);
  ok('old APK → not mistaken for a dead bridge', oldApk.bridgeUnavailable === false, oldApk);

  const browser = await ev(`(async()=>{ const r = await Health.run(null);
    const t = r.checks.find(c=>c.id==='triplog');
    return {status:t&&t.status, critical:t&&t.critical};})()`);
  ok('browser/PWA → trip row is n/a', browser.status === 'na', browser);
  ok('browser/PWA → never critical', browser.critical === false, browser);
  await ev(`Health.run()`);   // restore the real state

  // ── GeoLog date is local, not UTC ──────────────────────────────────────────
  const gl = await ev(`(function(){ GeoLog.add('info','v101.6 selftest');
    var e=GeoLog.get()[0]; return {date:e.date, time:e.time, today:todayStr()}; })()`);
  ok('GeoLog files entries under the LOCAL date', gl.date === gl.today, gl);

  console.log('    ── live: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('    ✗ live suite error: ' + e.message); process.exit(1); });
