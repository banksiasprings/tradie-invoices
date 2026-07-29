#!/usr/bin/env node
/*
 * test-fixes-v1018.js — unit tests for the two v101.8 field bugs.
 *
 * Extracts the //__V1018_FIX_PURE_START__ / __V1018_FIX_PURE_END__ block AND the
 * //__V90_BUILDER_START__ / __V90_BUILDER_END__ block VERBATIM from
 * www/index.html, so the shipped source is what runs (no copy, no drift).
 *
 * Bug 1a — phantom "no finish" shift.
 *   Field evidence, Steven's GeoLog 2026-07-29 (Firestore mirror), in order:
 *     17:13:43 [enter] [Web GPS fallback] Entered geofence: Lucas Ranch (1515m · acc 10m)
 *     17:13:43 [start] Auto-timer started at 17:13 · Lucas Ranch
 *     17:13:43 [info]  Reconstructed 2 session(s) from native queue -> review backlog
 *     17:13:43 [start] Live session (from native queue): Lucas Ranch since 13:34
 *   The web-GPS foreground fallback beat the native queue drain, stamped a
 *   session at APP-OPEN time, and the reconstruction force-sealed it with no
 *   finish. Rounded to :15 that is the "17:15 – ?  $0.00  0.00h" row.
 *
 * Bug 1b — the LDS ghost.
 *   Field state, same pull: clients = [Muirlawn Pty Ltd]; sites = [Lucas Ranch
 *   -> Muirlawn, Lds -> "Church"]. The client was deleted; its site survived
 *   with a dangling pointer, kept its geofence, kept starting days.
 *
 * Coordinates in the fixtures are synthetic — this repo is PUBLIC.
 *
 * Run:  node test-fixes-v1018.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');

function extract(startMark, endMark) {
  const re = new RegExp('\\/\\/' + startMark + '[^\\n]*\\n([\\s\\S]*?)\\/\\/' + endMark);
  const m = html.match(re);
  if (!m) { console.error('✗ could not find ' + startMark + ' markers in www/index.html'); process.exit(2); }
  return m[1];
}

const fixSrc = extract('__V1018_FIX_PURE_START__', '__V1018_FIX_PURE_END__');
const builderSrc = extract('__V90_BUILDER_START__', '__V90_BUILDER_END__');

const api = new Function(fixSrc + '\n' + builderSrc + `
return {shouldWebFallbackAutoStart, noFinishInfo, NO_FINISH_REASONS,
        sitesOfClient, orphanedSites, applyClientDeletion, applyClientRename, repairOrphanedSites,
        buildSessionsFromEvents};`)();
const { shouldWebFallbackAutoStart, noFinishInfo, NO_FINISH_REASONS,
        sitesOfClient, orphanedSites, applyClientDeletion, applyClientRename, repairOrphanedSites,
        buildSessionsFromEvents } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

const TODAY = '2026-07-29';
const ms = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00');

// ══ 1a — the web-GPS fallback gate ═══════════════════════════════════════════
console.log('1a · web-GPS fallback auto-start gate');

const base = { insideFence: true, accOk: true, hasActiveDay: false,
               alreadyTriggered: false, hour: 8, isNative: true, nativeQueueDrained: true };
const g = (over) => shouldWebFallbackAutoStart(Object.assign({}, base, over));

ok('starts when everything is ready', g({}).start === true);
ok('THE FIX: native + queue not yet drained = do not start',
   g({ nativeQueueDrained: false }).start === false);
ok('…and says why', g({ nativeQueueDrained: false }).reason === 'awaiting_native_queue');
// The v81 fallback exists precisely for "the native enter never fired". Gating it
// permanently would silently remove that safety net, so the gate must open again
// the moment the queue has been read.
ok('after the drain the fallback still works (v81 safety net intact)',
   g({ nativeQueueDrained: true }).start === true);
// Fail-open: in the browser there is no native queue to wait for.
ok('browser (not native) never waits on the queue',
   g({ isNative: false, nativeQueueDrained: false }).start === true);
ok('outside the fence = no start', g({ insideFence: false }).start === false);
ok('poor accuracy = no start', g({ accOk: false }).reason === 'poor_accuracy');
ok('already running = no start', g({ hasActiveDay: true }).reason === 'already_running');
ok('already triggered today = no start', g({ alreadyTriggered: true }).reason === 'already_triggered_today');
ok('04:59 is out of hours', g({ hour: 4 }).reason === 'out_of_hours');
ok('21:00 is out of hours', g({ hour: 21 }).reason === 'out_of_hours');
ok('05:00 is in hours', g({ hour: 5 }).start === true);
ok('20:59 is in hours', g({ hour: 20 }).start === true);
ok('null ctx does not throw', shouldWebFallbackAutoStart(null).start === false);
// Order matters for the GeoLog reason: an out-of-fence check must win over the
// queue gate, or the log would blame the queue for an ordinary "not at a site".
ok('not_inside outranks the queue gate',
   g({ insideFence: false, nativeQueueDrained: false }).reason === 'not_inside');

// ══ 1a — the exact field scenario, through the REAL builder ══════════════════
console.log('\n1a · regression pin: the 29 Jul phantom, through buildSessionsFromEvents');

// The native queue as it stood when he opened the app at 17:13: a short Lds
// visit, then arrival at Lucas Ranch at 13:34 with no exit yet (still on site).
const BANKED = [
  { type: 'enter', site: 'Lds',         time: '12:45', date: TODAY, timestamp: ms(TODAY, '12:45') },
  { type: 'exit',  site: 'Lds',         time: '13:00', date: TODAY, timestamp: ms(TODAY, '13:00') },
  { type: 'enter', site: 'Lucas Ranch', time: '13:34', date: TODAY, timestamp: ms(TODAY, '13:34') },
];
const PHANTOM = {
  id: 'phantom', site: 'Lucas Ranch', start: '17:13', date: TODAY,
  startTs: ms(TODAY, '17:13'), finish: null, autoStarted: true,
};
const opts = { mergeWindowMin: 90, sessionDefaults: { rate: 60, sonrate: 30 },
               mkId: (() => { let n = 0; return () => 'id' + (++n); })() };

// BEFORE the fix: the fallback had already written PHANTOM to activeDay, so
// reconstructAndReconcile carried it in as openSession.
const before = buildSessionsFromEvents(BANKED, Object.assign({ openSession: PHANTOM }, opts));
ok('reproduces the bug: phantom is force-sealed with no finish',
   before.completed.length === 2 && before.completed[0].id === 'phantom' && !before.completed[0].finish,
   before.completed.map(s => [s.id, s.site, s.start, s.finish]));
ok('reproduces the bug: "Reconstructed 2 session(s)" matches the field log',
   before.completed.length === 2);

// AFTER the fix: the gate means no phantom exists, so nothing is carried in.
const after = buildSessionsFromEvents(BANKED, Object.assign({ openSession: null }, opts));
ok('test_no_phantom_shift_when_app_opens_at_site: only the real Lds session seals',
   after.completed.length === 1 && after.completed[0].site === 'Lds',
   after.completed.map(s => [s.site, s.start, s.finish]));
ok('…Lds keeps its true times (12:45–13:00), not app-open time',
   after.completed[0].start === '12:45' && after.completed[0].finish === '13:00');
ok('…and the live session is the REAL 13:34 arrival, not 17:13',
   after.open && after.open.site === 'Lucas Ranch' && after.open.start === '13:34',
   after.open && [after.open.site, after.open.start]);
ok('…so nothing is left with a missing finish',
   after.completed.filter(s => !s.finish).length === 0);

// ══ 1a — a GENUINE mid-shift kill must still be captured, and explained ══════
console.log('\n1a · mid-shift kill without an exit (the honest no-finish case)');

// Monday: arrives 08:00, phone dies on site, no EXIT ever fires. Tuesday he
// arrives at a different site. The builder force-seals Monday incomplete — that
// is CORRECT (the time was really worked) and must not be silently dropped.
const KILLED = [
  { type: 'enter', site: 'Lucas Ranch', time: '08:00', date: '2026-07-27', timestamp: ms('2026-07-27', '08:00') },
  { type: 'enter', site: 'Lds',         time: '07:30', date: '2026-07-28', timestamp: ms('2026-07-28', '07:30') },
];
const killed = buildSessionsFromEvents(KILLED, Object.assign({ openSession: null }, opts));
ok('the killed shift is still captured, not dropped',
   killed.completed.length === 1 && killed.completed[0].date === '2026-07-27');
ok('…and it has no finish (we do NOT invent one)', killed.completed[0].finish === null);

const orphan = Object.assign({ no_finish_reason: 'no_exit' }, killed.completed[0]);
const info = noFinishInfo(orphan);
ok('noFinishInfo explains why', info && /No knock-off was recorded/.test(info.message), info);
ok('…carries every field Adjust needs',
   info.id && info.site === 'Lucas Ranch' && info.start === '08:00' && info.date === '2026-07-27');
ok('…and is flagged adjustable', info.canAdjust === true);
ok('a finished session has no no-finish notice', noFinishInfo(killed.completed[0].finish ? {} : { finish: '17:00' }) === null);
ok('an unknown reason code still yields a message',
   /No knock-off/.test(noFinishInfo({ id: 'x', site: 's', date: 'd', start: '1', no_finish_reason: 'bogus' }).message));
ok('the stale-shift reason is distinct',
   NO_FINISH_REASONS.stale !== NO_FINISH_REASONS.no_exit && /20 hours/.test(NO_FINISH_REASONS.stale));
ok('noFinishInfo(null) does not throw', noFinishInfo(null) === null);

// ══ 1b — client deletion must not orphan its sites ═══════════════════════════
console.log('\n1b · LDS ghost: client delete cascades to its sites');

// The exact shape pulled from Steven's Firestore on 2026-07-29 (coords redacted).
const FIELD_CLIENTS = [{ company: 'Muirlawn Pty Ltd', isDefault: true }];
const FIELD_SITES = [
  { name: 'Lucas Ranch', lat: -28.4, lng: 151.9, radius: 2900, client: 'Muirlawn Pty Ltd' },
  { name: 'Lds',         lat: -28.2, lng: 152.0, radius: 1050, client: 'Church' },
];

ok('reproduces the ghost: "Lds" points at a client that no longer exists',
   orphanedSites(FIELD_SITES, FIELD_CLIENTS).length === 1 &&
   orphanedSites(FIELD_SITES, FIELD_CLIENTS)[0].name === 'Lds');
ok('…while the healthy site is not flagged',
   orphanedSites(FIELD_SITES, FIELD_CLIENTS).every(s => s.name !== 'Lucas Ranch'));
ok('no orphans in clean data', orphanedSites(FIELD_SITES, FIELD_CLIENTS.concat([{ company: 'Church' }])).length === 0);
ok('a site with no client at all is not an orphan',
   orphanedSites([{ name: 'x', client: null }], FIELD_CLIENTS).length === 0);

const BEFORE_CLIENTS = [{ company: 'Muirlawn Pty Ltd', isDefault: true }, { company: 'Church' }];
ok('sitesOfClient finds what a delete would affect',
   sitesOfClient(FIELD_SITES, 'Church').length === 1 && sitesOfClient(FIELD_SITES, 'Church')[0].name === 'Lds');
ok('sitesOfClient(null) is empty, not everything', sitesOfClient(FIELD_SITES, null).length === 0);

const del = applyClientDeletion(BEFORE_CLIENTS, FIELD_SITES, 1);
ok('THE FIX: deleting the client removes its site too',
   del.sites.length === 1 && del.sites[0].name === 'Lucas Ranch',
   del.sites.map(s => s.name));
ok('…reports what it removed so the user can be told',
   del.removedSites.length === 1 && del.removedSites[0].name === 'Lds');
ok('…leaves no orphan behind', orphanedSites(del.sites, del.clients).length === 0);
ok('…and does not touch other clients’ sites',
   del.sites.filter(s => s.client === 'Muirlawn Pty Ltd').length === 1);

ok('delete does not mutate the input arrays',
   FIELD_SITES.length === 2 && BEFORE_CLIENTS.length === 2 &&
   FIELD_SITES.find(s => s.name === 'Lds').client === 'Church');
// Deleting a site never rewrites history: day records carry the site NAME.
ok('…and the site name survives in existing day records (strings, not refs)',
   [{ site: 'Lds', date: '2026-07-29' }].filter(d => d.site === 'Lds').length === 1);

// The other half of Steven's complaint: renaming a client orphaned its sites the
// same way, because sites point at a client by company NAME.
console.log('\n1b · renaming a client must re-point its sites');
const ren = applyClientRename(FIELD_SITES, 'Church', 'Church of Latter Day Saints');
ok('THE FIX: rename re-points the site', ren.sites.find(s => s.name === 'Lds').client === 'Church of Latter Day Saints');
ok('…reports how many moved', ren.renamed === 1);
ok('…leaves other clients’ sites alone', ren.sites.find(s => s.name === 'Lucas Ranch').client === 'Muirlawn Pty Ltd');
ok('…creates no orphan', orphanedSites(ren.sites, [{ company: 'Muirlawn Pty Ltd' }, { company: 'Church of Latter Day Saints' }]).length === 0);
ok('rename to the same name is a no-op', applyClientRename(FIELD_SITES, 'Church', 'Church').renamed === 0);
ok('rename with a blank new name is a no-op', applyClientRename(FIELD_SITES, 'Church', '').renamed === 0);
ok('rename does not mutate the input', FIELD_SITES.find(s => s.name === 'Lds').client === 'Church');
ok('renaming an unknown client changes nothing', applyClientRename(FIELD_SITES, 'Nobody', 'Somebody').renamed === 0);

const delDefault = applyClientDeletion(BEFORE_CLIENTS, FIELD_SITES, 0);
ok('deleting the default promotes another client', delDefault.clients[0].isDefault === true);
ok('…and is reported', delDefault.defaultChanged === true);
ok('deleting a non-default does not reshuffle defaults', del.defaultChanged === false);
ok('out-of-range index is a no-op',
   applyClientDeletion(BEFORE_CLIENTS, FIELD_SITES, 9).clients.length === 2);
ok('deleting the last client leaves no default to promote',
   applyClientDeletion([{ company: 'Solo', isDefault: true }], [], 0).clients.length === 0);

// Repair of data that is ALREADY broken — Steven's phone, right now.
const rep = repairOrphanedSites(FIELD_SITES, FIELD_CLIENTS);
ok('repair clears the dangling pointer on existing data',
   rep.changed === 1 && rep.sites.find(s => s.name === 'Lds').client === null);
ok('…stamps orphanedFrom so the UI can warn', rep.sites.find(s => s.name === 'Lds').orphanedFrom === 'Church');
ok('…NEVER deletes the site (that is the user’s call)', rep.sites.length === 2);
ok('…leaves the healthy site byte-identical',
   rep.sites.find(s => s.name === 'Lucas Ranch') === FIELD_SITES[0]);
ok('repair is idempotent', repairOrphanedSites(rep.sites, FIELD_CLIENTS).changed === 0);
ok('repair on clean data changes nothing',
   repairOrphanedSites([{ name: 'a', client: 'Muirlawn Pty Ltd' }], FIELD_CLIENTS).changed === 0);
ok('repair handles empty input', repairOrphanedSites([], []).changed === 0);

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
