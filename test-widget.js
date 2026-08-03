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
  // v108.1 routed the widget's $/hr through allTimeSplitRows() so it shares the
  // travel split with the Analytics tile. The billing boundary is unchanged: that
  // helper reads days(), the CONFIRMED store, and nothing else.
  ok('confirmed days only — days(), never the unconfirmed queue',
     /effectiveRate:effectiveRetainedRate\(allTimeSplitRows\(\),policy\)/.test(html)
     && /function allTimeSplitRows\(dayList\)\{[\s\S]{0,200}list=dayList\|\|days\(\)/.test(html)
     && !/function allTimeSplitRows[\s\S]{0,300}unconfirmed\(\)/.test(html)
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
  // v108.0 routed both taps through one activity() builder so the bar intents
  // could not drift from the card intent. Assert the DESTINATION, not the call
  // shape — the previous spelling was a refactor tripwire, not a behaviour test.
  ok('the whole-card tap still opens Stats',
     /openStatsIntent\(Context ctx\) \{\s*return activity\(ctx, ROOT_RC, "analytics", null\);/.test(rend));
  ok('…and the screen still travels as EXTRA_OPEN_SCREEN',
     /putExtra\(MainActivity\.EXTRA_OPEN_SCREEN, screen\)/.test(rend));
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


// ═══════════════════════════════════════════════════════════════════════════
// v108.0 — the widget follows the system theme
// ═══════════════════════════════════════════════════════════════════════════
const res = f => fs.readFileSync(path.join(__dirname, 'android/app/src/main/res', f), 'utf8');
const colours = xml => {
  const out = {};
  const re = /<color name="([^"]+)">\s*([^<]+?)\s*<\/color>/g;
  let m; while ((m = re.exec(xml))) out[m[1]] = m[2];
  return out;
};
/* WCAG 2.1 relative luminance + contrast ratio. Written out rather than pulled
   from a package because a devDependency that silently changes its rounding
   would move a shipped colour decision. */
const lum = hex => {
  const c = hex.replace('#', '').match(/../g).map(h => parseInt(h, 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

console.log('\n── PIN: test_widget_palette_passes_wcag_aa_in_both_themes ────────');
{
  /* Steven asked for the widget to follow day/night. The trap in doing that is
     that the brand amber was only ever validated against NAVY: on the new cream
     card it scores 4.05:1 and FAILS AA. This block is why the shipped light
     accent is a darkened amber instead — and it reads the real resource files,
     so nobody can quietly put the brand value back. */
  for (const [mode, file, bg] of [['light', 'values/widget_colors.xml', null],
                                  ['dark',  'values-night/widget_colors.xml', null]]) {
    const c = colours(res(file));
    const card = c.widget_bg;
    ok(mode + ': every colour is a literal hex (v31 overrides handle Material You)',
       Object.values(c).every(v => /^#[0-9A-Fa-f]{6}$/.test(v)));
    for (const key of ['widget_ink', 'widget_ink_dim', 'widget_accent', 'widget_good']) {
      const r = ratio(c[key], card);
      ok(mode + ': ' + key + ' passes AA on the card (' + r.toFixed(2) + ':1)', r >= 4.5, r);
    }
    // Non-text UI (WCAG 1.4.11): what carries the state is the bar FILL, so that
    // is what must clear 3:1 — both against the card and against its own track.
    const fillVsCard = ratio(c.widget_bar_fill, card);
    const fillVsTrack = ratio(c.widget_bar_fill, c.widget_bar_track);
    ok(mode + ': bar fill clears 3:1 on the card (' + fillVsCard.toFixed(2) + ':1)', fillVsCard >= 3, fillVsCard);
    ok(mode + ': bar fill clears 3:1 on its own track (' + fillVsTrack.toFixed(2) + ':1)', fillVsTrack >= 3, fillVsTrack);
    ok(mode + ': the current week is a different colour from the rest',
       c.widget_bar_fill !== c.widget_bar_current);
    ok(mode + ': the track is not the same colour as the fill',
       c.widget_bar_track !== c.widget_bar_fill);
  }
  // The CONTROL. Without it the loop above proves only that SOME numbers pass —
  // not that the check would catch the specific mistake it exists to prevent.
  const cream = colours(res('values/widget_colors.xml')).widget_bg;
  ok('CONTROL: raw brand amber would FAIL on the light card — which is why it is not used',
     ratio('#C1583A', cream) < 4.5, +ratio('#C1583A', cream).toFixed(2));
  ok('CONTROL: the shipped light accent is NOT the raw brand amber',
     colours(res('values/widget_colors.xml')).widget_accent.toUpperCase() !== '#C1583A');
}

console.log('\n── the two themes are genuinely different ────────────────────────');
{
  const day = colours(res('values/widget_colors.xml'));
  const night = colours(res('values-night/widget_colors.xml'));
  ok('v107.0 kept one navy card in both themes; v108.0 does not',
     day.widget_bg !== night.widget_bg);
  ok('…and the day card really is the lighter of the two',
     lum(day.widget_bg) > lum(night.widget_bg));
  ok('…with the ink inverted to match', lum(day.widget_ink) < lum(night.widget_ink));
  ok('every name defined in one theme exists in the other',
     Object.keys(day).every(k => night[k] !== undefined) &&
     Object.keys(night).every(k => day[k] !== undefined));
}

console.log('\n── Material You (API 31+) ────────────────────────────────────────');
{
  const v31 = colours(res('values-v31/widget_colors.xml'));
  const v31n = colours(res('values-night-v31/widget_colors.xml'));
  const tone = v => { const m = /_(\d+)$/.exec(v || ''); return m ? +m[1] : null; };
  ok('light overlay uses the system tonal palette',
     Object.values(v31).every(v => v.startsWith('@android:color/system_')));
  ok('dark overlay uses the system tonal palette',
     Object.values(v31n).every(v => v.startsWith('@android:color/system_')));
  ok('the brief asked for system_accent1_* and it is used',
     /system_accent1_/.test(JSON.stringify(v31)) && /system_accent1_/.test(JSON.stringify(v31n)));
  /* Tones run 0 = white to 1000 = black, so a LIGHT surface takes a LOW tone and
     its ink a HIGH one — inverted at night. Getting this backwards yields
     white-on-white and is the single most likely mistake in this file. */
  ok('light: surface tone is low, ink tone is high',
     tone(v31.widget_bg) < 200 && tone(v31.widget_ink) > 700);
  ok('dark: surface tone is high, ink tone is low',
     tone(v31n.widget_bg) > 700 && tone(v31n.widget_ink) < 200);
  ok('light: ink and surface are at least 500 tones apart (past AA for any hue)',
     tone(v31.widget_ink) - tone(v31.widget_bg) >= 500);
  ok('dark: ink and surface are at least 500 tones apart',
     tone(v31n.widget_bg) - tone(v31n.widget_ink) >= 500);
  ok('the accent moves darker on light and lighter on dark',
     tone(v31.widget_accent) > tone(v31n.widget_accent));
  ok('the pre-31 brand pair still exists as the fallback',
     /#F8F4ED/.test(res('values/widget_colors.xml')) && /#121B2C/.test(res('values-night/widget_colors.xml')));
}

console.log('\n── PIN: test_widget_bar_bitmap_follows_the_theme ─────────────────');
{
  const rend = fs.readFileSync(path.join(__dirname,
    'android/app/src/main/java/com/banksiasprings/invoices/WidgetRenderer.java'), 'utf8');
  const r = code(rend);
  /* The bitmap is the one thing drawn in OUR process, so it was the one thing
     that could stay in day colours on a night home screen. v107.0 hard-coded
     0xFFC1583A / 0x33FFFFFF, which was defensible only while the card was navy
     in both themes. */
  ok('PIN: no hard-coded ARGB literals left in the renderer',
     !/0x[0-9A-Fa-f]{8}/.test(r), (r.match(/0x[0-9A-Fa-f]{8}/g) || []));
  ok('bar colours are resolved from resources', /getColor\(R\.color\.widget_bar_/.test(r));
  ok('…all three of them', ['fill', 'current', 'track']
     .every(n => new RegExp('R\\.color\\.widget_bar_' + n).test(r)));
  ok('…and the stripper is real here too', r.length < rend.length && /class WidgetRenderer/.test(r));
  ok('text colour is still never set from our process', !/setTextColor/.test(r));
}


// ═══════════════════════════════════════════════════════════════════════════
// v108.0 — the graph, and tapping a week bar
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── PIN: test_week_bar_tap_opens_that_weeks_log ───────────────────');
{
  const rend = fs.readFileSync(path.join(__dirname,
    'android/app/src/main/java/com/banksiasprings/invoices/WidgetRenderer.java'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname,
    'android/app/src/main/java/com/banksiasprings/invoices/MainActivity.java'), 'utf8');
  const plug = fs.readFileSync(path.join(__dirname,
    'android/app/src/main/java/com/banksiasprings/invoices/StatsWidgetPlugin.java'), 'utf8');
  const med = res('layout/widget_goal_medium.xml');
  const lrg = res('layout/widget_goal_large.xml');

  ok('a bar tap opens the Log, not Stats', /activity\(ctx, BAR_RC \+ index, "log", weekKey\)/.test(code(rend)));
  /* The request code is the ONLY thing keeping six bars apart: PendingIntent
     identity uses Intent.filterEquals, which ignores extras. Sharing one code
     makes every bar open the last week written, silently. */
  ok('PIN: each bar gets its own request code', /BAR_RC \+ index/.test(code(rend)));
  ok('…distinct from the whole-card tap', /ROOT_RC/.test(code(rend)) && /BAR_RC = /.test(code(rend)));
  ok('…and FLAG_UPDATE_CURRENT so the week a bar points at can change',
     /FLAG_UPDATE_CURRENT/.test(code(rend)));

  ok('the week key rides the intent', /EXTRA_OPEN_WEEK/.test(code(rend)) && /EXTRA_OPEN_WEEK/.test(code(main)));
  ok('native banks it rather than calling into the WebView',
     /putString\("pending_week", week\)/.test(code(main)));
  ok('screen and week are cleared together', /remove\("pending_screen"\)\.remove\("pending_week"\)/.test(code(plug)));

  // Both sizes carry the chart and its six cells; 2x1 deliberately does not.
  for (const [name, xml] of [['2x2', med], ['4x2', lrg]]) {
    ok(name + ': the chart is a container, so it can hold tap targets', /@\+id\/w_chart/.test(xml));
    ok(name + ': six hit cells, one per bucket',
       [0,1,2,3,4,5].every(i => new RegExp('@\\+id/w_hit' + i).test(xml)));
    ok(name + ': cells are FrameLayout — RemoteViews will not inflate Space or View',
       !/<Space|<View\s/.test(xml));
  }
  ok('2x1 stays unchanged — no chart at 110x40dp',
     !/w_chart|w_hit0/.test(res('layout/widget_goal_small.xml')));
  ok('the empty state hides the CONTAINER, not just the bitmap',
     /hide\(v, R\.id\.w_chart\)/.test(code(rend)));
  ok('cells past the drawn bars are hidden, not left live with stale intents',
     /hide\(v, HIT_IDS\[i\]\)/.test(code(rend)));

  // JS half — the Log actually scopes to the week.
  ok('the Log accepts a week filter', /function setLogWeekFilter\(k\)/.test(html));
  ok('…derived by the SAME rule that bucketed the bars', /widgetWeekKey\(new Date\(dateStr\+'T00:00:00'\)\)===weekKey/.test(html));
  ok('…and always offers a way out', /function clearLogWeekFilter\(\)/.test(html) && /Show all<\/button>/.test(html));
  ok('a plain card tap clears a week left over from a bar tap',
     /setLogWeekFilter\(r\.screen==='log'\?\(r\.week\|\|null\):null\)/.test(html));
  /* Transient on purpose: a filter persisted to settings would still be
     narrowing the Log next week, long after the tap that asked for it. */
  ok('the filter is a variable, never persisted', /^let _logWeekFilter=null;$/m.test(html) &&
     !/mcn_logWeek|logWeekFilter'\s*[,:]/.test(html));
}

console.log('\n── the graph still refuses to fabricate ──────────────────────────');
{
  const rend = code(fs.readFileSync(path.join(__dirname,
    'android/app/src/main/java/com/banksiasprings/invoices/WidgetRenderer.java'), 'utf8'));
  ok('a lone bucket is still not drawn as a full-height bar',
     /weeks\.size\(\) < 2/.test(rend));
  ok('a zero-hour week still draws as a track, not an absent bar',
     /Math\.max\(0\.06/.test(rend));
  ok('the bar loop and the cell loop share one n, so they cannot drift',
     /int n = Math\.min\(weeks\.size\(\), HIT_IDS\.length\)/.test(rend) &&
     /bindBarTaps\(ctx, v, weeks, n\)/.test(rend));
}

console.log('\n── version ───────────────────────────────────────────────────────');
{
  ok('APP_VERSION bumped to v108.1', /const APP_VERSION = 'v108\.1';/.test(html));
  ok('Capgo builtin tracks it (the v82 cache-trap rule)',
     /"version": "1\.108\.1"/.test(fs.readFileSync(path.join(__dirname, 'capacitor.config.json'), 'utf8')));
  ok('versionCode bumped — new layouts and resource folders need an APK',
     /versionCode 19/.test(fs.readFileSync(path.join(__dirname, 'android/app/build.gradle'), 'utf8')));
}

console.log('\n' + '─'.repeat(66));
console.log(fail === 0 ? `✓ ALL ${pass} PASSED` : `✗ ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
