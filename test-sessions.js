#!/usr/bin/env node
/*
 * test-sessions.js — unit tests for the v90 PURE session reconstruction logic.
 *
 * Extracts buildSessionsFromEvents() VERBATIM from www/index.html (between the
 * //__V90_BUILDER_START__ / //__V90_BUILDER_END__ markers) and runs it against
 * synthetic native geo-event sequences. Tests the SHIPPED source — no copy, no
 * drift. Pure logic → no emulator/browser needed → sub-second feedback loop.
 *
 * This is the heart of "set and forget": it proves that a week of ENTER/EXIT
 * events banked while the app was closed reconstructs into the right sessions.
 *
 * Run:  node test-sessions.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
const m = html.match(/\/\/__V90_BUILDER_START__[^\n]*\n([\s\S]*?)\/\/__V90_BUILDER_END__/);
if (!m) { console.error('✗ could not find builder markers in www/index.html'); process.exit(2); }
// eval the extracted source inside an isolated Function scope, return the fn
const buildSessionsFromEvents = new Function(m[1] + '\nreturn buildSessionsFromEvents;')();

// ── helpers ──────────────────────────────────────────────────────────────────
// Brisbane is UTC+10 (no DST). Build a ms timestamp from a local date+time so
// the test is timezone-independent regardless of where it runs.
function ts(dateStr, timeStr){
  const [Y,M,D] = dateStr.split('-').map(Number);
  const [h,mi]  = timeStr.split(':').map(Number);
  return Date.UTC(Y, M-1, D, h-10, mi); // -10h to convert AEST→UTC
}
function ev(type, site, date, time){ return { type, site, date, time, timestamp: ts(date,time) }; }
const DEFS = { rate:60, sonrate:30 };
let seed = 1;
function build(events, opts){
  return buildSessionsFromEvents(events, Object.assign({
    sessionDefaults: DEFS, mergeWindowMin: 90,
    mkId: () => 's' + (seed++)
  }, opts||{}));
}

let pass=0, fail=0;
function check(name, cond, detail){
  if(cond){ console.log('  ✓ '+name); pass++; }
  else { console.log('  ✗ '+name + (detail?('\n      '+detail):'')); fail++; }
}

// ── 1. Single day (the validated 2026-07-01 $433 scenario) ───────────────────
(() => {
  const r = build([ ev('enter','Muirlawn','2026-07-01','09:37'), ev('exit','Muirlawn','2026-07-01','16:50') ]);
  check('single day → 1 completed session, no open',
    r.completed.length===1 && r.open===null,
    JSON.stringify({completed:r.completed.length, open:!!r.open}));
  const s=r.completed[0];
  check('single day → correct site/start/finish',
    s && s.site==='Muirlawn' && s.start==='09:37' && s.finish==='16:50' && s.status==='UNCONFIRMED',
    JSON.stringify(s));
})();

// ── 2. FLAGSHIP: 5-day week, app never opened, opened Fri night ───────────────
(() => {
  const days=['2026-06-29','2026-06-30','2026-07-01','2026-07-02','2026-07-03'];
  const events=[];
  days.forEach(d=>{ events.push(ev('enter','Muirlawn',d,'09:00')); events.push(ev('exit','Muirlawn',d,'17:00')); });
  const r = build(events);
  check('5-day week → 5 completed sessions, no open',
    r.completed.length===5 && r.open===null,
    JSON.stringify({completed:r.completed.length, open:!!r.open}));
  check('5-day week → each is a distinct day 09:00–17:00',
    r.completed.every((s,i)=> s.date===days[i] && s.start==='09:00' && s.finish==='17:00'),
    JSON.stringify(r.completed.map(s=>s.date+' '+s.start+'-'+s.finish)));
  check('5-day week → unique ids',
    new Set(r.completed.map(s=>s.id)).size===5);
})();

// ── 3. Same-day rejoin merge (off-site lunch, 30 min < 90) ───────────────────
(() => {
  const r = build([
    ev('enter','Muirlawn','2026-07-01','09:00'),
    ev('exit','Muirlawn','2026-07-01','12:00'),
    ev('enter','Muirlawn','2026-07-01','12:30'),   // 30 min gap → merge
    ev('exit','Muirlawn','2026-07-01','17:00')
  ]);
  check('merge → 1 session (not 2)', r.completed.length===1 && r.open===null,
    JSON.stringify({completed:r.completed.length}));
  const s=r.completed[0];
  check('merge → spans 09:00–17:00 with 30min lunch',
    s && s.start==='09:00' && s.finish==='17:00' && s.lunchMins===30 && s.merged===true,
    JSON.stringify(s && {start:s.start,finish:s.finish,lunch:s.lunchMins,merged:s.merged}));
})();

// ── 4. Gap LONGER than merge window (120 min) → two separate sessions ─────────
(() => {
  const r = build([
    ev('enter','Muirlawn','2026-07-01','09:00'),
    ev('exit','Muirlawn','2026-07-01','12:00'),
    ev('enter','Muirlawn','2026-07-01','14:00'),   // 120 min gap → NO merge
    ev('exit','Muirlawn','2026-07-01','17:00')
  ]);
  check('long gap → 2 separate sessions', r.completed.length===2 && r.open===null,
    JSON.stringify({completed:r.completed.length}));
})();

// ── 5. Multi-site same day → 2 independent sessions (no merge across sites) ───
(() => {
  const r = build([
    ev('enter','Site A','2026-07-01','08:00'),
    ev('exit','Site A','2026-07-01','11:00'),
    ev('enter','Site B','2026-07-01','11:20'),     // 20 min but DIFFERENT site → no merge
    ev('exit','Site B','2026-07-01','15:00')
  ]);
  check('multi-site → 2 independent sessions', r.completed.length===2 && r.open===null,
    JSON.stringify(r.completed.map(s=>s.site+' '+s.start+'-'+s.finish)));
  check('multi-site → sites A then B, no lunch merged',
    r.completed[0].site==='Site A' && r.completed[1].site==='Site B' &&
    r.completed[0].lunchMins===0 && r.completed[1].lunchMins===0);
})();

// ── 6. Dangling ENTER (still on site) → open session, no completed ───────────
(() => {
  const r = build([ ev('enter','Muirlawn','2026-07-01','09:00') ]);
  check('dangling enter → open session, 0 completed',
    r.completed.length===0 && r.open && r.open.site==='Muirlawn' && r.open.start==='09:00' && !r.open.finish,
    JSON.stringify({completed:r.completed.length, open:r.open&&r.open.start}));
})();

// ── 7. Carried-in openSession + a later EXIT closes it ───────────────────────
(() => {
  const openSess = { id:'live1', site:'Muirlawn', date:'2026-07-01', start:'09:00',
    startTs: ts('2026-07-01','09:00'), finish:null, lunchMins:0, status:'UNCONFIRMED' };
  const r = build([ ev('exit','Muirlawn','2026-07-01','17:00') ], { openSession: openSess });
  check('carried openSession + exit → completes it, id preserved (caller supersedes by id)',
    r.completed.length===1 && r.completed[0].id==='live1' && r.completed[0].finish==='17:00' && r.open===null,
    JSON.stringify({completed:r.completed.length, id:r.completed[0]&&r.completed[0].id}));
})();

// ── 8. Cross-drain merge: recentUnconfirmed + re-enter within window ──────────
(() => {
  const recent = [{ id:'u1', site:'Muirlawn', date:'2026-07-01', start:'09:00', finish:'12:00',
    startTs: ts('2026-07-01','09:00'), finishTs: ts('2026-07-01','12:00'), lunchMins:0, status:'UNCONFIRMED' }];
  const r = build([ ev('enter','Muirlawn','2026-07-01','12:40'), ev('exit','Muirlawn','2026-07-01','17:00') ],
    { recentUnconfirmed: recent });
  check('cross-drain merge → reuses u1, 40min lunch, 09:00–17:00',
    r.completed.length===1 && r.completed[0].id==='u1' && r.completed[0].lunchMins===40 &&
    r.completed[0].start==='09:00' && r.completed[0].finish==='17:00',
    JSON.stringify(r.completed[0] && {id:r.completed[0].id,lunch:r.completed[0].lunchMins,s:r.completed[0].start,f:r.completed[0].finish}));
})();

// ── 9. Out-of-order arrival of events still sorts by timestamp ───────────────
(() => {
  const r = build([
    ev('exit','Muirlawn','2026-07-01','17:00'),
    ev('enter','Muirlawn','2026-07-01','09:00')
  ]);
  check('out-of-order → sorted into 1 session 09:00–17:00',
    r.completed.length===1 && r.completed[0].start==='09:00' && r.completed[0].finish==='17:00',
    JSON.stringify(r.completed[0]&&{s:r.completed[0].start,f:r.completed[0].finish}));
})();

// ── 10. Stray exit with no enter → ignored ───────────────────────────────────
(() => {
  const r = build([ ev('exit','Muirlawn','2026-07-01','17:00') ]);
  check('stray exit → nothing built', r.completed.length===0 && r.open===null);
})();

// ── 11. Missed exit then next-day enter → prior day sealed incomplete ─────────
(() => {
  const r = build([
    ev('enter','Muirlawn','2026-07-01','09:00'),   // exit missed
    ev('enter','Muirlawn','2026-07-02','09:00'),
    ev('exit','Muirlawn','2026-07-02','17:00')
  ]);
  check('missed exit → 2 sessions (day1 incomplete, day2 complete)',
    r.completed.length===2 && r.open===null &&
    r.completed[0].date==='2026-07-01' && !r.completed[0].finish &&
    r.completed[1].date==='2026-07-02' && r.completed[1].finish==='17:00',
    JSON.stringify(r.completed.map(s=>s.date+' '+s.start+'-'+(s.finish||'?'))));
})();

// ── 12. v101.2 REGRESSION: today's field fragmentation (2 Jul, Lucas Ranch) ────
// Steven was on site continuously 08:45–13:30 (one work day, one site, no real
// departures). Rural GMS fence flutter produced a stream of accepted same-site
// same-day re-ENTERs (each garbage EXIT got accuracy-rejected, so the fence
// re-armed and fired a clean-accuracy re-ENTER). Carried-in openSession = the
// 08:49 web-GPS-fallback activeDay; accepted enters 10:15/11:45/13:15/13:21;
// the one genuine EXIT at 13:28 when he left.
// PRE-FIX (v90 builder, no guard): 4 incomplete $0 fragments (08:49, 10:15,
//   11:45, 13:15) + one 13:21–13:28 session → the fragmented Work Log Steven saw.
// POST-FIX (v89 idempotency restored): ONE session 08:49–13:28, 4 ignored ENTERs.
(() => {
  const openSess = { id:'live-0849', site:'Lucas Ranch', date:'2026-07-02', start:'08:49',
    startTs: ts('2026-07-02','08:49'), finish:null, lunchMins:0, status:'UNCONFIRMED' };
  const r = build([
    ev('enter','Lucas Ranch','2026-07-02','10:15'),
    ev('enter','Lucas Ranch','2026-07-02','11:45'),
    ev('enter','Lucas Ranch','2026-07-02','13:15'),
    ev('enter','Lucas Ranch','2026-07-02','13:21'),
    ev('exit','Lucas Ranch','2026-07-02','13:28')
  ], { openSession: openSess });
  check('today field case → ONE session (not fragmented)',
    r.completed.length===1 && r.open===null,
    JSON.stringify({completed:r.completed.length, open:!!r.open}));
  check('today field case → session spans 08:49–13:28, id preserved',
    r.completed[0] && r.completed[0].id==='live-0849' &&
    r.completed[0].start==='08:49' && r.completed[0].finish==='13:28',
    JSON.stringify(r.completed[0]&&{id:r.completed[0].id,s:r.completed[0].start,f:r.completed[0].finish}));
  check('today field case → 4 duplicate ENTERs ignored (surfaced to caller)',
    r.ignored && r.ignored.length===4 && r.ignored.every(e=>e.type==='enter' && e.site==='Lucas Ranch'),
    JSON.stringify({ignored:r.ignored&&r.ignored.length}));
})();

// ── 13. v101.2 REGRESSION: yesterday's control day (1 Jul, closed-app test) ────
// Identical flutter pattern — accepted phantom re-enters at 10:08/11:26/11:32/
// 14:17 on top of the first real enter 09:37, one real exit 16:50. This day
// replayed under v89 code (v90 shipped ~50 min later) and produced ONE clean
// session; the fix reproduces that behaviour under the current builder.
(() => {
  const r = build([
    ev('enter','Lucas Ranch','2026-07-01','09:37'),
    ev('enter','Lucas Ranch','2026-07-01','10:08'),
    ev('enter','Lucas Ranch','2026-07-01','11:26'),
    ev('enter','Lucas Ranch','2026-07-01','11:32'),
    ev('enter','Lucas Ranch','2026-07-01','14:17'),
    ev('exit','Lucas Ranch','2026-07-01','16:50')
  ]);
  check('control day → ONE clean session 09:37–16:50 (v89 parity)',
    r.completed.length===1 && r.open===null &&
    r.completed[0].start==='09:37' && r.completed[0].finish==='16:50',
    JSON.stringify(r.completed.map(s=>s.start+'-'+(s.finish||'?'))));
  check('control day → 4 duplicate ENTERs ignored',
    r.ignored && r.ignored.length===4,
    JSON.stringify({ignored:r.ignored&&r.ignored.length}));
})();

// ── 14. MULTI-DAY still splits (guard scoped to same DATE, not just same site) ─
// enter Mon (exit lost) → enter Tue same site: different dates → Mon must still
// seal incomplete and Tue opens fresh. The guard must NOT swallow this.
(() => {
  const r = build([
    ev('enter','Muirlawn','2026-07-06','08:00'),   // Monday, exit missed
    ev('enter','Muirlawn','2026-07-07','08:00'),    // Tuesday same site, different day
    ev('exit','Muirlawn','2026-07-07','16:00')
  ]);
  check('multi-day → 2 sessions, Mon incomplete, nothing ignored',
    r.completed.length===2 && r.open===null &&
    r.completed[0].date==='2026-07-06' && !r.completed[0].finish &&
    r.completed[1].date==='2026-07-07' && r.completed[1].finish==='16:00' &&
    (!r.ignored || r.ignored.length===0),
    JSON.stringify({completed:r.completed.length, ignored:r.ignored&&r.ignored.length}));
})();

// ── 15. MULTI-SITE same day still splits (guard scoped to same SITE) ──────────
// enter A → enter B same day, no exits: different site → A seals incomplete, B
// opens. The guard must NOT swallow this (it's a legit multi-site day).
(() => {
  const r = build([
    ev('enter','Site A','2026-07-08','07:00'),
    ev('enter','Site B','2026-07-08','10:00')       // different site → not a duplicate
  ]);
  check('multi-site (no exits) → A incomplete completed, B open, nothing ignored',
    r.completed.length===1 && r.completed[0].site==='Site A' && !r.completed[0].finish &&
    r.open && r.open.site==='Site B' && !r.open.finish &&
    (!r.ignored || r.ignored.length===0),
    JSON.stringify({completed:r.completed.map(s=>s.site),open:r.open&&r.open.site,ignored:r.ignored&&r.ignored.length}));
})();

// ── 16. Existing merge path unaffected: re-ENTER AFTER a genuine EXIT merges ───
// enter → EXIT (accepted, closes session) → re-enter within window: the guard
// only triggers while a session is OPEN, so this still takes the merge path.
(() => {
  const r = build([
    ev('enter','Muirlawn','2026-07-09','09:00'),
    ev('exit','Muirlawn','2026-07-09','12:00'),      // accepted exit → session closed
    ev('enter','Muirlawn','2026-07-09','12:20'),     // 20 min → merge, NOT ignored
    ev('exit','Muirlawn','2026-07-09','17:00')
  ]);
  check('re-enter after accepted exit → merges (not ignored), 20min lunch',
    r.completed.length===1 && r.completed[0].lunchMins===20 && r.completed[0].merged===true &&
    (!r.ignored || r.ignored.length===0),
    JSON.stringify({completed:r.completed.length,lunch:r.completed[0]&&r.completed[0].lunchMins,ignored:r.ignored&&r.ignored.length}));
})();

console.log('\n  RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail===0 ? 0 : 1);
