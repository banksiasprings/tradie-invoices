#!/usr/bin/env node
/*
 * test-retained.js — v106.0 retained revenue: the goal tally excludes
 * passthrough, and the invoice does not move.
 *
 * Steven (2026-08-03): the goal tally was summing line items he doesn't keep —
 * extra labour that goes straight back out to whoever worked. He wants it out of
 * his goal number and still on the invoice, because the client is billed the
 * full amount either way.
 *
 * The load-bearing test here is the PARTITION pin: the five components sum to
 * exactly dayTotals().total. Not approximately — exactly, against the REAL
 * shipped money function, extracted from source and run with stubs. If that
 * holds, "the invoice is untouched" is arithmetic rather than a promise.
 *
 * Run:  node test-retained.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}
const near = (a, b, eps) => Math.abs(a - b) < (eps === undefined ? 1e-9 : eps);

// ── Extract the pure block verbatim ─────────────────────────────────────────
function slice(startMark, endMark) {
  const a = html.indexOf(startMark), b = html.indexOf(endMark);
  if (a < 0 || b < 0) throw new Error('markers not found: ' + startMark);
  // The start marker carries a trailing "(extracted by …)" note on the same
  // line, so the block begins at the NEXT newline, not at the end of the marker.
  return html.slice(html.indexOf('\n', a) + 1, b);
}
const PURE = slice('//__V106_RETAINED_PURE_START__', '//__V106_RETAINED_PURE_END__');

// Purity gate — the block must not reach for the DOM, the store, or the clock.
console.log('── purity ──────────────────────────────────────────────────────');
ok('no DOM access', !/document\.|window\./.test(PURE));
ok('no store access', !/\bDB\.|localStorage/.test(PURE));
ok('no argless Date/now', !/new Date\(\s*\)|Date\.now\(\)/.test(PURE));
ok('no S() settings read', !/[^a-zA-Z]S\(\)/.test(PURE));

const ctx = {};
new Function('ctx', PURE + '\n' +
  ['RETAINED_COMPONENTS','retentionPolicy','splitDayRevenue','retainedTally',
   'excludedItemsForDay','excludedDetail','deriveMilestones','goalProgress',
   'paceNarrative','fmtUsd','fmtWeeks']
    .map(n => `ctx.${n}=${n};`).join(''))(ctx);

const { RETAINED_COMPONENTS, retentionPolicy, splitDayRevenue, retainedTally,
        excludedItemsForDay, deriveMilestones, goalProgress, paceNarrative,
        fmtWeeks } = ctx;

// ── Extract the REAL dayTotals so the partition is pinned against shipped
//    money code, not a re-implementation of it. ────────────────────────────
const dtStart = html.indexOf('function dayTotals(d){');
const dtEnd = html.indexOf('\n}', html.indexOf('return{h,myE,sonH,sonE,total:', dtStart)) + 2;
const DAYTOTALS_SRC = html.slice(dtStart, dtEnd);
const SETTINGS = { sonrate: 30, travelKmRate: 0.88, travelHrRate: 30,
                   machineRates: { Excavator: 150, Bobcat: 120 } };
// timeDiffHours is lifted from source too — a re-implementation here could
// diverge from the shipped one and quietly invalidate every money assertion.
const TDH_SRC = html.slice(html.indexOf('function timeDiffHours(s,f){'),
                           html.indexOf('\n', html.indexOf('function timeDiffHours(s,f){')));
const dayTotals = new Function('S', 'getMachineRate',
  TDH_SRC + '\n' + DAYTOTALS_SRC + '\nreturn dayTotals;')(
  () => SETTINGS, n => SETTINGS.machineRates[n] || 0);

// A full-fat day: every one of the five components non-zero.
const FULL_DAY = {
  date: '2026-07-15', site: 'Lucas Ranch', start: '07:00', finish: '16:00',
  lunchMins: 60, rate: 60, sonWorking: true, sonHours: 8, sonrate: 30,
  machines: [{ name: 'Excavator', hireType: 'wet', startHrs: 100, finishHrs: 106, rate: 150 }],
  travelMode: 'km', travelKm: 50, travelKmRate: 0.88,
  materials: [{ name: 'Road base', qty: 10, unitPrice: 12 }]
};
const LABOUR_ONLY_DAY = {
  date: '2026-07-16', site: 'Lucas Ranch', start: '07:00', finish: '15:00',
  lunchMins: 0, rate: 60, sonWorking: false, machines: [], travelMode: 'none', materials: []
};

console.log('\n── PIN: test_goal_tally_excludes_passthrough_but_invoice_total_unchanged ──');
{
  const t = dayTotals(FULL_DAY);
  const p = retentionPolicy({});                 // shipped default: labour only
  const sp = splitDayRevenue(t, p);

  ok('PIN: the five components partition dayTotals().total EXACTLY',
     near(sp.gross, t.total), { gross: sp.gross, total: t.total });
  ok('PIN: …so the invoice figure is arithmetically untouched', near(sp.retained + sp.passthrough, t.total));
  ok('PIN: retained is his labour only', near(sp.retained, t.myE), { retained: sp.retained, myE: t.myE });
  ok('PIN: extra labour is excluded', sp.components.find(c => c.key === 'extra').retained === false);
  ok('PIN: …and it is a real, non-zero amount being excluded', t.sonE > 0, t.sonE);
  ok('PIN: passthrough = extra + machine + travel + materials',
     near(sp.passthrough, t.sonE + t.machineTotal + t.travelTotal + t.materialsTotal));

  // The concrete numbers, so a silent drift in dayTotals is caught here too.
  ok('8h × $60 = $480 retained', near(sp.retained, 480), sp.retained);
  ok('$1,424 of passthrough on the day', near(sp.passthrough, 1424), sp.passthrough);
  ok('$1,904 still invoiced', near(sp.gross, 1904), sp.gross);
}

console.log('\n── PIN: test_retention_policy_absence_reads_as_default ────────────');
{
  ok('PIN: an empty settings blob = the shipped default',
     JSON.stringify(retentionPolicy({})) ===
     JSON.stringify({ labour: true, extra: false, machine: false, travel: false, materials: false }));
  ok('PIN: a pre-v106 blob (no `retention` key) classifies identically',
     JSON.stringify(retentionPolicy({ rate: 55, sonrate: 30 })) === JSON.stringify(retentionPolicy({})));
  ok('PIN: null settings does not throw', retentionPolicy(null).labour === true);
  ok('an explicit false is honoured', retentionPolicy({ retention: { labour: false } }).labour === false);
  ok('an explicit true is honoured', retentionPolicy({ retention: { machine: true } }).machine === true);
  ok('a null value falls back to the default, not to false',
     retentionPolicy({ retention: { machine: null } }).machine === false &&
     retentionPolicy({ retention: { labour: null } }).labour === true);
  ok('an unknown key is ignored', retentionPolicy({ retention: { nonsense: true } }).nonsense === undefined);
  ok('a truthy non-boolean does NOT flip it on (strict === true)',
     retentionPolicy({ retention: { machine: 1 } }).machine === false);
}

console.log('\n── the taxonomy ───────────────────────────────────────────────────');
{
  ok('five components, no more', RETAINED_COMPONENTS.length === 5);
  ok('each names a dayTotals field',
     RETAINED_COMPONENTS.every(c => ['myE','sonE','machineTotal','travelTotal','materialsTotal'].includes(c.field)));
  ok('the fields are distinct (a partition, not an overlap)',
     new Set(RETAINED_COMPONENTS.map(c => c.field)).size === 5);
  ok('only labour is retained by default', RETAINED_COMPONENTS.filter(c => c.retained).map(c => c.key).join() === 'labour');
  ok('every component explains itself to the user', RETAINED_COMPONENTS.every(c => c.why && c.why.length > 20));
}

console.log('\n── splitDayRevenue ────────────────────────────────────────────────');
{
  const t = dayTotals(FULL_DAY);
  ok('flipping machine hire on moves it to retained, gross unchanged', (() => {
    const a = splitDayRevenue(t, retentionPolicy({}));
    const b = splitDayRevenue(t, retentionPolicy({ retention: { machine: true } }));
    return near(a.gross, b.gross) && near(b.retained, a.retained + t.machineTotal);
  })());
  ok('everything retained → passthrough is 0', (() => {
    const all = { labour: true, extra: true, machine: true, travel: true, materials: true };
    const s = splitDayRevenue(t, all);
    return near(s.passthrough, 0) && near(s.retained, t.total);
  })());
  ok('nothing retained → retained is 0, gross still intact', (() => {
    const s = splitDayRevenue(t, {});
    return near(s.retained, 0) && near(s.gross, t.total);
  })());
  ok('a labour-only day has zero passthrough', near(splitDayRevenue(dayTotals(LABOUR_ONLY_DAY), retentionPolicy({})).passthrough, 0));
  ok('empty totals does not throw', splitDayRevenue({}, retentionPolicy({})).gross === 0);
  ok('null totals does not throw', splitDayRevenue(null, null).gross === 0);
}

console.log('\n── retainedTally ──────────────────────────────────────────────────');
{
  const p = retentionPolicy({});
  const rows = [FULL_DAY, LABOUR_ONLY_DAY, FULL_DAY].map(d => ({ day: d, totals: dayTotals(d) }));
  const T = retainedTally(rows, p);
  ok('day count', T.dayCount === 3);
  ok('retained sums per-day retained', near(T.retained, 480 + 480 + 480), T.retained);
  ok('gross sums per-day gross', near(T.gross, 1904 + 480 + 1904), T.gross);
  ok('gross = retained + passthrough', near(T.gross, T.retained + T.passthrough));
  ok('hours aggregate', near(T.hours, 8 + 8 + 8), T.hours);
  ok('byComponent counts only the days a component actually appeared',
     T.byComponent.extra.days === 2 && T.byComponent.labour.days === 3,
     { extra: T.byComponent.extra.days, labour: T.byComponent.labour.days });
  ok('contributing lists only retained-and-nonzero', T.contributing.map(c => c.key).join() === 'labour');
  ok('costing lists the passthrough in taxonomy order',
     T.costing.map(c => c.key).join() === 'extra,machine,travel,materials', T.costing.map(c => c.key));
  ok('an empty year tallies to zero, not NaN',
     (() => { const e = retainedTally([], p); return e.retained === 0 && e.gross === 0 && e.dayCount === 0; })());
  ok('null rows does not throw', retainedTally(null, p).dayCount === 0);
  ok('a zero-amount component never enters costing (no $0.00 rows)',
     retainedTally([{ day: LABOUR_ONLY_DAY, totals: dayTotals(LABOUR_ONLY_DAY) }], p).costing.length === 0);
}

console.log('\n── excludedItemsForDay (the review screen’s raw rows) ─────────────');
{
  const p = retentionPolicy({});
  const items = excludedItemsForDay(FULL_DAY, dayTotals(FULL_DAY), p);
  ok('one row per excluded, non-zero component', items.length === 4, items.map(i => i.key));
  ok('labour never appears (it is retained)', !items.some(i => i.key === 'labour'));
  ok('rows carry the date and site', items.every(i => i.date === '2026-07-15' && i.site === 'Lucas Ranch'));
  ok('amounts are positive', items.every(i => i.amount > 0));
  ok('extra labour detail states hours × rate', /8\.00h × \$30\.00\/hr/.test(items.find(i => i.key === 'extra').detail),
     items.find(i => i.key === 'extra').detail);
  ok('machine detail names the machine and its hours',
     /Excavator — 6\.00h × \$150\.00/.test(items.find(i => i.key === 'machine').detail),
     items.find(i => i.key === 'machine').detail);
  ok('machine detail surfaces the wet-hire operator overage',
     /2\.00h operator/.test(items.find(i => i.key === 'machine').detail));
  ok('travel detail states km × rate', /50 km × \$0\.88\/km/.test(items.find(i => i.key === 'travel').detail));
  ok('materials detail names the material', /Road base — 10 × \$12\.00/.test(items.find(i => i.key === 'materials').detail));
  ok('a labour-only day yields no rows', excludedItemsForDay(LABOUR_ONLY_DAY, dayTotals(LABOUR_ONLY_DAY), p).length === 0);
  ok('retaining everything yields no rows',
     excludedItemsForDay(FULL_DAY, dayTotals(FULL_DAY),
       { labour: true, extra: true, machine: true, travel: true, materials: true }).length === 0);
  ok('travel by time renders hours, not km', (() => {
    const d = Object.assign({}, FULL_DAY, { travelMode: 'time', travelHrs: 1.5, travelHrRate: 30 });
    return /1\.5h × \$30\.00\/hr/.test(excludedItemsForDay(d, dayTotals(d), p).find(i => i.key === 'travel').detail);
  })());
  ok('a day-rate machine says so rather than printing 0.00h', (() => {
    const d = Object.assign({}, FULL_DAY, { machines: [{ name: 'Bobcat', hireType: 'day', dayRate: 700 }] });
    return /Bobcat — day rate/.test(excludedItemsForDay(d, dayTotals(d), p).find(i => i.key === 'machine').detail);
  })());
  ok('null day does not throw', excludedItemsForDay(null, null, p).length === 0);
}

console.log('\n── deriveMilestones ───────────────────────────────────────────────');
{
  const m = deriveMilestones(90000);
  ok('thirds by default', m.length === 3 && m[0].usd === 30000 && m[1].usd === 60000 && m[2].usd === 90000);
  ok('the last one is the goal itself', m[2].label === 'goal');
  ok('labels are present', m.every(x => x.label));
  ok('NO milestones when there is no target (not three $0 markers)', deriveMilestones(0).length === 0);
  ok('…nor for a negative target', deriveMilestones(-5).length === 0);
  ok('custom milestones are honoured and sorted',
     (() => { const c = deriveMilestones(100, [{ usd: 80, label: 'b' }, { usd: 20, label: 'a' }]);
              return c.length === 2 && c[0].usd === 20 && c[1].usd === 80; })());
  ok('bare numbers work as custom milestones', deriveMilestones(100, [50])[0].usd === 50);
  ok('zero/garbage custom entries are dropped', deriveMilestones(100, [0, -1, 40]).length === 1);
}

console.log('\n── goalProgress — null, never a fabricated zero ───────────────────');
{
  const ms = deriveMilestones(90000);
  const g = goalProgress(30000, 90000, ms);
  ok('pct', near(g.pct, 33.3333, 1e-3), g.pct);
  ok('remaining', near(g.remaining, 60000));
  ok('hasTarget', g.hasTarget === true);
  ok('the first milestone reads as reached', g.milestones[0].reached === true);
  ok('…and the goal does not', g.milestones[2].reached === false);
  ok('tick positions are percentages of the target', near(g.milestones[0].at, 33.3333, 1e-3));

  const none = goalProgress(1234, 0, deriveMilestones(0));
  ok('PIN: no target → pct is NULL, not 0', none.pct === null);
  ok('PIN: no target → remaining is NULL, not 0', none.remaining === null);
  ok('no target → hasTarget false', none.hasTarget === false);
  ok('no target → retained still reported', none.retained === 1234);

  const over = goalProgress(120000, 90000, ms);
  ok('overshoot clamps the BAR at 100%', near(over.pct, 100));
  ok('…but pctRaw keeps the truth', over.pctRaw > 100);
  ok('overshoot never shows negative remaining', over.remaining === 0);
  ok('overshoot marks every milestone reached', over.milestones.every(m => m.reached));
  ok('a $0 milestone is never "reached" vacuously', goalProgress(0, 100, [{ usd: 0, label: 'x' }]).milestones[0].reached === false);
}

console.log('\n── paceNarrative — refuses to invent a number ─────────────────────');
{
  const base = { weeksElapsed: 10, weeksRemaining: 42, dayCount: 40 };

  const noTarget = paceNarrative(Object.assign({ retained: 5000, target: 0 }, base));
  ok('no target → state no-target', noTarget.state === 'no-target');
  ok('no target → weeksToGoal is null', noTarget.weeksToGoal === null);

  const noData = paceNarrative({ retained: 0, target: 90000, weeksElapsed: 2, weeksRemaining: 50, dayCount: 0 });
  ok('PIN: no confirmed days → refuses to project', noData.state === 'no-data');
  ok('…and says a pace built on nothing is made up', /made-up number/.test(noData.text));

  const noPace = paceNarrative(Object.assign({ retained: 0, target: 90000 }, base));
  ok('PIN: nothing retained → no honest time-to-goal', noPace.state === 'no-pace');
  ok('…and refuses a weeksToGoal', noPace.weeksToGoal === null);

  const onTrack = paceNarrative(Object.assign({ retained: 20000, target: 90000 }, base));
  ok('on-track state', onTrack.state === 'on-track');
  ok('per-week rate is right', near(onTrack.perWeek, 2000));
  ok('weeksToGoal is right', near(onTrack.weeksToGoal, 35));
  ok('the text quotes the rate and the day count', /\$2,000\/week/.test(onTrack.text) && /40 confirmed days/.test(onTrack.text));
  ok('it says the goal lands inside the FY', /inside the financial year/.test(onTrack.text));

  const behind = paceNarrative(Object.assign({ retained: 5000, target: 90000 }, base));
  ok('behind state', behind.state === 'behind');
  ok('…and names it as past the end of the FY', /past the end of the financial year/.test(behind.text));

  const done = paceNarrative(Object.assign({ retained: 95000, target: 90000 }, base));
  ok('reached state', done.state === 'reached');
  ok('…and reports the retained figure', /\$95,000/.test(done.text));

  // Caveats have to be earned.
  ok('PIN: seasonality caveat is always present on a live projection',
     onTrack.caveats.some(c => /wet weather|Christmas/.test(c)));
  ok('a thin sample earns its own caveat',
     paceNarrative({ retained: 2000, target: 90000, weeksElapsed: 2, weeksRemaining: 50, dayCount: 3 })
       .caveats.some(c => /3 confirmed days/.test(c)));
  ok('…and a fat sample does not', !onTrack.caveats.some(c => /too few/.test(c)));
  ok('a hot recent stretch is called out as better',
     paceNarrative(Object.assign({ retained: 20000, target: 90000, recentWeeks: 4, recentRetained: 16000 }, base))
       .caveats.some(c => /better than this projection/.test(c)));
  ok('a cold recent stretch is called out as worse',
     paceNarrative(Object.assign({ retained: 20000, target: 90000, recentWeeks: 4, recentRetained: 1000 }, base))
       .caveats.some(c => /worse than this projection/.test(c)));
  ok('a recent stretch matching the average earns NO recency caveat',
     !paceNarrative(Object.assign({ retained: 20000, target: 90000, recentWeeks: 4, recentRetained: 8000 }, base))
       .caveats.some(c => /recent rate is/.test(c)));
  ok('no args at all does not throw', paceNarrative().state === 'no-target');
  ok('undefined arg does not throw', paceNarrative(undefined).state === 'no-target');
}

console.log('\n── fmtWeeks ───────────────────────────────────────────────────────');
{
  ok('sub-week', fmtWeeks(0.4) === 'under a week');
  ok('weeks', fmtWeeks(3) === '3 weeks');
  ok('singular week', fmtWeeks(1.2) === '1 week');
  ok('months', fmtWeeks(20) === '5 months');
  ok('years', fmtWeeks(120) === '2.3 years');
  ok('zero does not print "0 weeks"', fmtWeeks(0) === 'under a week');
}

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL — the guardrail: nothing here may reach the invoice.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── PIN: test_invoice_and_accountant_csv_untouched_by_retention ────');
{
  function fnBody(name) {
    const i = html.indexOf('function ' + name + '(');
    if (i < 0) return '';
    // brace-match to the end of the function
    let depth = 0, started = false;
    for (let j = i; j < html.length; j++) {
      if (html[j] === '{') { depth++; started = true; }
      else if (html[j] === '}') { depth--; if (started && depth === 0) return html.slice(i, j + 1); }
    }
    return '';
  }
  const RETENTION_IDS = /retentionPolicy|splitDayRevenue|retainedTally|retainedYtd|retainedRows|excludedItemsForDay|RETAINED_COMPONENTS|\.retained\b|passthrough/;

  const MONEY_FNS = ['dayTotals', 'buildInvoiceHTML', 'previewInvoice', 'generateInvoice'];
  MONEY_FNS.forEach(fn => {
    const body = fnBody(fn);
    ok('PIN: ' + fn + '() exists', body.length > 0);
    ok('PIN: ' + fn + '() never references the retention layer', body.length > 0 && !RETENTION_IDS.test(body));
  });

  // dayTotals must still return the exact same shape the invoice destructures.
  ok('PIN: dayTotals still returns the full invoice total',
     /return\{h,myE,sonH,sonE,total:myE\+sonE\+machineTotal\+travelTotal\+materialsTotal/.test(html));
  ok('PIN: the invoice grand total still sums every component',
     /const grandTotal=te\+sonTotal\+grandMachineTotal\+grandTravelTotal\+grandMaterialsTotal/.test(html));
  ok('PIN: GST is still charged on the full grand total', /grandTotal\*0\.1/.test(html));
  ok('PIN: the extra-labourer line is still ON the invoice',
     /\$\{getExtraLabel\(\)\}: \$\{sonTotalHrs/.test(html));

  // The accountant/Xero CSV must describe what was invoiced.
  const csv = fnBody('exportDaysCSV');
  ok('PIN: the accountant/Xero days CSV exists', csv.length > 0);
  ok('PIN: …and is untouched by the retention layer', csv.length > 0 && !RETENTION_IDS.test(csv));

  // The v106 CSV is a separate artefact, not a change to that one.
  ok('the excluded-items CSV is its own export', /function exportExcludedCSV\(/.test(html));
  ok('…with its own filename', /excluded_from_goal_/.test(html));
}

console.log('\n── PIN: test_review_screen_ships_with_the_exclusion ───────────────');
{
  ok('PIN: a review screen exists', /<div id="screen-retained"/.test(html));
  ok('PIN: it is reachable from the goal widget', /showScreen\('retained'\)/.test(html));
  ok('PIN: showScreen renders it', /if\(id==='retained'\) renderRetainedReview\(\);/.test(html));
  ok('PIN: it lists RAW per-item rows, not just a rollup', /excludedItemsForDay\(r\.day,r\.totals,policy\)/.test(html));
  ok('the widget renders on the Analytics screen', /function renderAnalytics\(\)\{\s*renderGoalWidget\(\);/.test(html));
  ok('the widget has a mount point', /<div id="goal-widget"><\/div>/.test(html));
  ok('flipping a component is reversible (no write lock)', /function setRetention\(key,on\)/.test(html));
  ok('…and it persists to the synced settings blob', /s\.retention\[key\]=!!on;\s*\n?\s*DB\.set\('settings',s\);/.test(html));
  ok('…and is logged', /GeoLog\.add\('info','Retention: '/.test(html));
}

console.log('\n── PIN: test_goal_card_and_detail_agree ───────────────────────────');
{
  ok('PIN: the headline uses the shared tally', /const ytdEarnings=retainedYtd\(curFY\)\.tally\.retained;/.test(html));
  ok('PIN: the detail modal uses the same tally', /const totalH=tally\.hours, totalEarn=tally\.retained, grossEarn=tally\.gross;/.test(html));
  ok('PIN: the old "includes … machines, travel and materials" line is GONE',
     !/includes hours, machines, travel and materials from each day/.test(html));
  ok('the detail modal shows the gross alongside', /Invoiced YTD \(client pays\)/.test(html));
  ok('…and names each deduction', /less '\+escHtml\(c\.label\)/.test(html));
  ok('past FYs are retained too, so the comparison is like-for-like',
     /fyMap\[f\]\.earn\+=splitDayRevenue\(t,policy\)\.retained;/.test(html));
  ok('…including the Analytics past-FY list', /byFY\[fy\]\.earn\+=splitDayRevenue\(dayTotals\(d\),policy\)\.retained;/.test(html));
  ok('the card label says "Retained earnings", not "Annual earnings"', /Retained earnings<\/div>/.test(html));
}

console.log('\n── version ────────────────────────────────────────────────────────');
{
  ok('APP_VERSION bumped to v106.0', /const APP_VERSION = 'v106\.0';/.test(html));
  ok('DEFAULTS carries the retention policy', /retention:\{labour:true,extra:false,machine:false,travel:false,materials:false\}/.test(html));
}

console.log('\n' + '─'.repeat(66));
console.log(fail === 0 ? `✓ ALL ${pass} PASSED` : `✗ ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
