#!/usr/bin/env node
/*
 * test-widget.js — v107.0 home-screen widget snapshot.
 *
 * Steven wants a widget he can add by long-pressing his home screen, styled like
 * his solar one: at-a-glance status, honest numbers, no dashboard squeezed into
 * two cells.
 *
 * The load-bearing idea is that the WIDGET PROCESS DOES NO MONEY MATH. The app
 * computes every figure and hands over a finished JSON blob; Java parses it and
 * derives exactly one thing for itself — which bucket is "this week" — because
 * that is calendar lookup, not arithmetic over dollars. These tests pin the JS
 * half of that contract: the shape of the blob, that unknowns are null rather
 * than 0, and that the wording is never softened.
 *
 * The Java half is verified by compiling it and by the emulator screenshots;
 * a node process cannot inflate a RemoteViews.
 *
 * Run:  node test-widget.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

function slice(startMark, endMark) {
  const a = html.indexOf(startMark), b = html.indexOf(endMark);
  if (a < 0 || b < 0) throw new Error('markers not found: ' + startMark);
  return html.slice(html.indexOf('\n', a) + 1, b);
}

const RETAINED = slice('//__V106_RETAINED_PURE_START__', '//__V106_RETAINED_PURE_END__');
const WIDGET   = slice('//__V107_WIDGET_PURE_START__',   '//__V107_WIDGET_PURE_END__');

/* Source scans must read CODE, not documentation. Every one of these files
   explains the constraint it is being checked against — "never `new Date()`",
   "no Firestore in the widget process" — so scanning the raw text makes the
   comment that states a rule the evidence that it was broken. Strip first. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// ── purity ──────────────────────────────────────────────────────────────────
console.log('── purity ──────────────────────────────────────────────────────');
const W = code(WIDGET);
ok('no DOM access', !/document\.|window\./.test(W));
ok('no store access', !/\bDB\.|localStorage/.test(W));
ok('no argless Date/now', !/new Date\(\s*\)|Date\.now\(\)/.test(W));
ok('no S() settings read', !/[^a-zA-Z]S\(\)/.test(W));
ok('no Capacitor bridge in the pure block', !/Capacitor/.test(W));
// The stripper must actually be doing something, or these five pass vacuously.
ok('…and the comment stripper is real', W.length < WIDGET.length && /function buildWidgetSnapshot/.test(W));

const ctx = {};
new Function('ctx', RETAINED + '\n' + WIDGET + '\n' +
  ['buildWidgetSnapshot', 'widgetGapText', 'widgetWeekKey', 'weekPace',
   'goalProgress', 'deriveMilestones', 'effectiveRetainedRate', 'splitDayRevenue']
    .map(n => `ctx.${n}=${n};`).join(''))(ctx);

const { buildWidgetSnapshot, widgetGapText, widgetWeekKey,
        deriveMilestones, effectiveRetainedRate } = ctx;

// Steven's real FY2026-27 shape, read off the synced Firestore blob 2026-08-03.
const REAL_WEEKS = [
  { key: '2026-06-29', hours: 15.75, retained: 945 },
  { key: '2026-07-06', hours: 17.5,  retained: 1050 },
  { key: '2026-07-27', hours: 32.28, retained: 1937 }
];
// 1 Jul → 3 Aug is 33 days, i.e. 4.714 weeks elapsed. Passed at full precision
// (the gap is a live figure that moves hourly) while paceCaveats rounds it to
// the "5 weeks into the year" it reports — the two are deliberately different.
const REAL_ELAPSED = 33 / 7;
const REAL = () => buildWidgetSnapshot({
  now: Date.parse('2026-08-03T09:00:00Z'),
  fyLabel: 'FY2026–27',
  retained: 3932,
  target: 140400,
  weeks: REAL_WEEKS,
  weeksElapsed: REAL_ELAPSED,
  milestones: deriveMilestones(140400, null),
  weekGoalHours: 45,
  effectiveRate: 60
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── PIN: test_widget_snapshot_never_fabricates_a_number ───────────');
{
  // The whole reason the widget carries nulls rather than zeroes: on a home
  // screen there is no room to explain that a 0 meant "nobody told me".
  const fresh = buildWidgetSnapshot({});
  ok('PIN: no target → target is null, not 0', fresh.target === null, fresh.target);
  ok('PIN: no target → pct is null, not 0%', fresh.pct === null, fresh.pct);
  ok('PIN: no target → remaining is null', fresh.remaining === null, fresh.remaining);
  ok('PIN: no days → state is no-data', fresh.state === 'no-data', fresh.state);
  ok('PIN: …and it says so in words', /No days confirmed yet/.test(fresh.gapText), fresh.gapText);
  ok('no days → hasData false', fresh.hasData === false);
  ok('no days → no pace note invented', fresh.paceNote === null, fresh.paceNote);
  ok('no rate → effectiveRate null, not $0/hr', fresh.effectiveRate === null, fresh.effectiveRate);
  ok('no weekly goal → null, not 0h', fresh.weekGoalHours === null, fresh.weekGoalHours);
  ok('no weeks → empty array, never undefined', Array.isArray(fresh.weeks) && fresh.weeks.length === 0);
  ok('no milestones invented from a missing target', fresh.milestones.length === 0);

  // Days but no goal is a DIFFERENT state from no days, and must read differently.
  const noGoal = buildWidgetSnapshot({ weeks: REAL_WEEKS, retained: 3932, weeksElapsed: 5 });
  ok('PIN: days but no goal → no-target, not no-data', noGoal.state === 'no-target', noGoal.state);
  ok('…and it says which', /No earnings goal set/.test(noGoal.gapText), noGoal.gapText);
  ok('…while still reporting what was retained', noGoal.retained === 3932);
}

console.log('\n── PIN: test_widget_never_says_on_track ──────────────────────────');
{
  const BANNED = /on track|on pace|caught up|keep it up|well done|nice work/i;
  const cases = [
    ['behind',  widgetGapText(3932, 140400, 5)],
    ['ahead',   widgetGapText(40000, 140400, 5)],
    ['level',   widgetGapText(13500, 140400, 5)],
    ['reached', widgetGapText(150000, 140400, 40)],
    ['notarget',widgetGapText(3932, 0, 5)]
  ];
  cases.forEach(([n, r]) => ok('PIN: "' + n + '" carries no reassurance', !BANNED.test(r.text), r.text));

  ok('behind states the signed distance',
     /^Behind by \$\d[\d,]* on a straight-line target\.$/.test(cases[0][1].text), cases[0][1].text);
  ok('ahead states it too, rather than praising',
     /^Ahead by \$\d[\d,]* on a straight-line target\.$/.test(cases[1][1].text), cases[1][1].text);
  ok('level is stated as level, not as success', cases[2][1].text === 'Level with a straight-line target.');
  ok('reached is a fact, not a cheer', cases[3][1].text === 'Goal reached.');

  // And through the full snapshot, including the pace note.
  const s = REAL();
  ok('PIN: neither gapText nor paceNote softens anything',
     !BANNED.test(s.gapText + ' ' + (s.paceNote || '')), s.gapText + ' | ' + s.paceNote);
}

console.log('\n── PIN: test_widget_snapshot_matches_his_real_year ───────────────');
{
  const s = REAL();
  ok('PIN: retained is his real figure', s.retained === 3932);
  ok('target rides along', s.target === 140400);
  ok('pct is derived, not shipped separately', Math.abs(s.pct - 2.8) < 0.05, s.pct);
  ok('remaining is derived', Math.round(s.remaining) === 136468, s.remaining);
  // 140400 × (33/7) ÷ 52 − 3932 = $8,796.57, the same gap v106.1 recorded from
  // his real data. The widget prints whole dollars above $100 (fmtUsd), so $8,797.
  ok('PIN: behind by the real gap', /^Behind by \$8,797 on a straight-line target\.$/.test(s.gapText), s.gapText);
  ok('PIN: the note separates worked weeks from elapsed ones',
     /3 of 5 weeks had hours/.test(s.paceNote), s.paceNote);
  ok('…and reports what those weeks looked like', /21\.8h\/wk/.test(s.paceNote), s.paceNote);
  ok('worked weeks counted', s.workedWeeks === 3);
  ok('elapsed weeks counted separately', s.elapsedWeeks === 5);
  ok('effective rate is his own rate', s.effectiveRate === 60);
  ok('weekly hours goal carried from settings, not hard-coded', s.weekGoalHours === 45);
  ok('three milestones, auto thirds', s.milestones.length === 3);
  ok('…none reached yet at 2.8%', s.milestones.every(m => !m.reached));
  ok('state is behind', s.state === 'behind');
  ok('fy label carried verbatim (en-dash intact)', s.fyLabel === 'FY2026–27');
  ok('generatedAt is stamped for staleness', s.generatedAt === Date.parse('2026-08-03T09:00:00Z'));
  ok('schema is versioned', s.v === 1);
}

console.log('\n── week buckets: the one thing native derives ────────────────────');
{
  const s = REAL();
  ok('buckets ride along', s.weeks.length === 3);
  ok('…keyed by Monday', s.weeks.map(w => w.k).join(',') === '2026-06-29,2026-07-06,2026-07-27');
  ok('…ascending, so "last" is the newest', s.weeks[2].k === '2026-07-27');
  ok('…carrying hours', s.weeks.map(w => w.h).join(',') === '15.75,17.5,32.28');
  ok('…and retained', s.weeks.map(w => w.r).join(',') === '945,1050,1937');

  // Trailing window: a widget shows a trend, not a ledger. Six by default.
  const many = Array.from({ length: 20 }, (_, i) => ({
    key: '2026-' + String(1 + (i % 12)).padStart(2, '0') + '-05', hours: i, retained: i * 60 }));
  ok('capped to the last 6 weeks', buildWidgetSnapshot({ weeks: many }).weeks.length === 6);
  ok('…and it is the LAST 6, not the first',
     buildWidgetSnapshot({ weeks: many }).weeks[5].h === 19);
  ok('the window is configurable', buildWidgetSnapshot({ weeks: many, maxWeeks: 4 }).weeks.length === 4);

  // widgetWeekKey must agree with retainedWeeks' bucketing, or native looks up
  // a key that can never match and "this week" silently reads as no data.
  ok('PIN: Monday maps to itself', widgetWeekKey(new Date('2026-07-27T09:00:00')) === '2026-07-27');
  ok('PIN: Sunday maps BACK to its Monday', widgetWeekKey(new Date('2026-08-02T23:00:00')) === '2026-07-27');
  ok('PIN: Wednesday maps back too', widgetWeekKey(new Date('2026-07-29T12:00:00')) === '2026-07-27');
  ok('month boundaries are handled', widgetWeekKey(new Date('2026-08-01T12:00:00')) === '2026-07-27');
  ok('year boundaries are handled', widgetWeekKey(new Date('2027-01-01T12:00:00')) === '2026-12-28');
}

console.log('\n── the snapshot cannot disagree with the app ─────────────────────');
{
  // effectiveRetainedRate is the SHARED helper; the Analytics tile and the
  // widget both call it, which is what makes them incapable of drifting.
  const pol = { labour: true, extra: false, machine: false, travel: false, materials: false };
  const rows = [
    { totals: { h: 8, myE: 480, sonE: 240, machineTotal: 0, travelTotal: 0, materialsTotal: 0 } },
    { totals: { h: 8, myE: 480, sonE: 0,   machineTotal: 900, travelTotal: 50, materialsTotal: 0 } }
  ];
  ok('PIN: effective rate uses retained, so $60/hr not $107/hr',
     effectiveRetainedRate(rows, pol) === 60, effectiveRetainedRate(rows, pol));
  ok('PIN: no hours → null, not 0', effectiveRetainedRate([{ totals: { h: 0, myE: 0 } }], pol) === null);
  ok('empty input → null', effectiveRetainedRate([], pol) === null);
  ok('bare totals objects work too (not just {totals})',
     effectiveRetainedRate([{ h: 8, myE: 480 }], pol) === 60);
  ok('a null row does not throw', effectiveRetainedRate([null, { h: 8, myE: 480 }], pol) === 60);
}

console.log('\n── wiring (source assertions) ────────────────────────────────────');
{
  ok('the snapshot is pushed from ONE debounced function', /function pushWidgetSnapshot\(\)\{/.test(html));
  ok('PIN: hooked into DB.set, not sprinkled at save sites',
     /if\(WIDGET_KEYS\[k\]\)\{ try\{ pushWidgetSnapshot\(\); \}catch\(e\)\{\} \}/.test(html));
  ok('PIN: …AFTER the local write, so a mirror failure cannot cost a save',
     /localStorage\.setItem\('mcn_'\+k,JSON\.stringify\(v\)\);[\s\S]{0,400}pushWidgetSnapshot\(\)/.test(html));
  ok('days and settings are the watched keys', /var WIDGET_KEYS=\{days:1,settings:1\}/.test(html));
  ok('a missing bridge is a silent no-op, not an error',
     /if\(!P\|\|!P\.updateSnapshot\) return;/.test(html));
  ok('pushed on cold open too (a widget added while the app was shut)',
     /try\{ pushWidgetSnapshot\(\); \}catch\(_\)\{\}/.test(html));
  ok('…and on resume (the week may have rolled over)',
     /window\.pushWidgetSnapshot\) window\.pushWidgetSnapshot\(\);/.test(html));
  ok('tap-to-open drains a natively-banked screen', /function drainWidgetTap\(\)\{/.test(html));
  ok('…targeting Stats', /idx=\{checkin:0,log:1,invoice:2,analytics:3/.test(html));
  ok('the snapshot reads the SAME tally as the Stats widget',
     /function collectWidgetSnapshot\(now\)\{[\s\S]{0,400}retainedYtd\(curFY\)/.test(html));
  ok('…and the SAME target', /function collectWidgetSnapshot\(now\)\{[\s\S]{0,500}retainedTarget\(\)/.test(html));
  ok('confirmed days only — days(), never the unconfirmed queue',
     /effectiveRate:effectiveRetainedRate\(days\(\)\.map/.test(html)
     && !/collectWidgetSnapshot[\s\S]{0,900}unconfirmedQueue/.test(html));
}

console.log('\n── native side (source assertions) ───────────────────────────────');
{
  const j = f => fs.readFileSync(path.join(__dirname, 'android/app/src/main/java/com/banksiasprings/invoices', f), 'utf8');
  const rawStore = j('WidgetStore.java'), rawProv = j('GoalWidgetProvider.java'),
        rawWork = j('WidgetRefreshWorker.java'), rawRend = j('WidgetRenderer.java'),
        rawPlug = j('StatsWidgetPlugin.java');
  const store = code(rawStore), prov = code(rawProv), work = code(rawWork),
        rend = code(rawRend), plug = code(rawPlug);
  const ALL = store + prov + work + rend + plug;

  ok('PIN: no Firestore in the widget process',
     !/[Ff]irestore|FirebaseFirestore/.test(ALL));
  ok('PIN: no auth in the widget process',
     !/FirebaseAuth|signIn|getIdToken/.test(ALL));
  ok('PIN: no network in the widget process',
     !/HttpURLConnection|OkHttp|URLConnection|\.openConnection/.test(ALL));
  ok('…and the Java stripper is real too (these are asserted in the comments)',
     ALL.length < (rawStore + rawProv + rawWork + rawRend + rawPlug).length
     && /class WidgetStore/.test(store));
  ok('PIN: the provider only enqueues — nothing reads on the main thread',
     !/WidgetStore\.load/.test(prov));
  ok('PIN: …the read happens in the Worker', /WidgetStore\.load\(ctx\)/.test(work));
  ok('the worker is a WorkManager Worker', /extends Worker/.test(work));
  ok('periodic refresh is 30 minutes', /REFRESH_MINUTES = 30/.test(prov));
  ok('…and is cancelled when the last widget is removed',
     /onDisabled[\s\S]{0,240}cancelUniqueWork/.test(prov));
  ok('platform updatePeriodMillis is off (WorkManager owns the cadence)',
     /android:updatePeriodMillis="0"/.test(fs.readFileSync(
       path.join(__dirname, 'android/app/src/main/res/xml/goal_widget_info.xml'), 'utf8')));
  ok('a corrupt blob yields an empty snapshot, not a crash',
     /catch \(Exception e\) \{[\s\S]{0,160}return new Snapshot\(\);/.test(store));
  ok('PIN: absent figures are boxed Doubles so null survives',
     /public Double target = null;/.test(store) && /public Double effectiveRate = null;/.test(store));
  ok('PIN: a week with no bucket returns null, not 0.0h',
     /hoursForWeekOf[\s\S]{0,260}return null;/.test(store));
  ok('PendingIntent is IMMUTABLE (a hard crash on API 31+ otherwise)',
     /FLAG_IMMUTABLE/.test(rend));
  ok('tap opens Stats', /EXTRA_OPEN_SCREEN, "analytics"/.test(rend));
  ok('PIN: colours are never resolved in our process for text',
     !/setTextColor/.test(rend));
  ok('API 31+ gets a responsive size map', /new RemoteViews\(m\)/.test(work));
  ok('…and older releases fall back to the options bundle',
     /OPTION_APPWIDGET_MIN_WIDTH/.test(work));
  ok('three size layouts exist', ['small', 'medium', 'large'].every(z =>
     fs.existsSync(path.join(__dirname, 'android/app/src/main/res/layout/widget_goal_' + z + '.xml'))));
  ok('dark mode has its own palette',
     fs.existsSync(path.join(__dirname, 'android/app/src/main/res/values-night/widget_colors.xml')));
  ok('Material You radius is behind an API-31 qualifier',
     /system_app_widget_background_radius/.test(fs.readFileSync(
       path.join(__dirname, 'android/app/src/main/res/values-v31/widget_dimens.xml'), 'utf8')));
  ok('…with a pre-31 fallback so the card is never square-cornered',
     /<dimen name="widget_radius">16dp<\/dimen>/.test(fs.readFileSync(
       path.join(__dirname, 'android/app/src/main/res/values/widget_dimens.xml'), 'utf8')));
  ok('the receiver is declared and exported',
     /android:name="\.GoalWidgetProvider"[\s\S]{0,200}android:exported="true"/.test(
       fs.readFileSync(path.join(__dirname, 'android/app/src/main/AndroidManifest.xml'), 'utf8')));
  ok('the plugin is registered on the bridge',
     /registerPlugin\(StatsWidgetPlugin\.class\)/.test(j('MainActivity.java')));
  ok('PIN: native carries no money arithmetic — no rate, no multiply-by-hours',
     !/\* *rate|rate *\*|hours *\* |dayTotals/.test(store + rend));
}

console.log('\n' + '─'.repeat(66));
console.log(fail === 0 ? `✓ ALL ${pass} PASSED` : `✗ ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
