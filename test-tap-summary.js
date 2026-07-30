#!/usr/bin/env node
/*
 * test-tap-summary.js — v104.9 the Loads tap bug, and the invoice auto-summary.
 *
 * THE TAP BUG (Steven, after a real day of dump loops): "all of the loads are
 * showing up altogether as a big group. When I try to click on them
 * individually, sometimes it works, sometimes it doesn't ... maybe it's getting
 * confused because it's got a long pressed edit, and then maybe a short press to
 * select it."
 *
 * He was close. The rows were discrete and the thresholds were fine. The v104.0
 * wiring listened to BOTH touch and mouse events, and a touchscreen tap fires
 * touchstart/touchend and then a SYNTHESISED mousedown/mouseup for the same
 * finger. Both `touchend` and `mouseup` ran the tap action, so every tap
 * selected the lap and immediately deselected it — net zero, which is why the
 * map kept drawing the whole day. Intermittent because browsers suppress the
 * synthesised pair in some conditions.
 *
 * Run:  node test-tap-summary.js
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
  extract('__V102_CIRCUIT_PURE_START__', '__V102_CIRCUIT_PURE_END__') + '\n' +
  extract('__V104_LOADS_PURE_START__', '__V104_LOADS_PURE_END__') + `
return {daySummaryLines, buildWorkSummary, loadSegments, loadsRollup, applyLoadVoid};`)();
const { daySummaryLines, buildWorkSummary, loadSegments, loadsRollup, applyLoadVoid } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

// ── A DOM-free harness for the shipped gesture wiring ───────────────────────
// wireRowGestures is impure (touches the DOM), so it is lifted out of source and
// run against a stub element. That way the ACTUAL shipped code is what's tested,
// not a paraphrase of it.
function gestureHarness(hasPointerEvent) {
  const src = html.slice(html.indexOf('function wireRowGestures'),
                        html.indexOf('window.wireRowGestures=wireRowGestures;'));
  const handlers = {};
  const el = {
    addEventListener: (k, f) => { (handlers[k] = handlers[k] || []).push(f); },
    fire: (k, e) => (handlers[k] || []).forEach(f => {
      const ev = Object.assign({ clientX: 0, clientY: 0, button: 0, preventDefault(){} }, e || {});
      ev.touches = [{ clientX: ev.clientX, clientY: ev.clientY }];   // touch events carry a list
      f(ev);
    })
  };
  const win = { PointerEvent: hasPointerEvent ? function(){} : undefined };
  const fn = new Function('window', 'navigator', 'setTimeout', 'clearTimeout', src + '; return wireRowGestures;');
  const timers = [];
  const st = (cb, ms) => { const t = { cb, ms, dead: false }; timers.push(t); return t; };
  const ct = t => { if (t) t.dead = true; };
  const wire = fn(win, {}, st, ct);
  return {
    el, wire,
    // Advance time far enough to fire any live timer.
    tick: () => timers.forEach(t => { if (!t.dead) { t.dead = true; t.cb(); } }),
    handlers
  };
}
function countFor(hasPointerEvent, script) {
  const h = gestureHarness(hasPointerEvent);
  let taps = 0, holds = 0;
  h.wire(h.el, { onTap: () => taps++, onHold: () => holds++ });
  script(h);
  return { taps, holds, has: k => !!h.handlers[k] };
}

console.log('── PIN: test_tap_and_long_press_never_fire_together ─────────────');
{
  // A real touchscreen tap on Android: touch pair, then a synthesised mouse pair.
  const r = countFor(true, h => {
    h.el.fire('pointerdown'); h.el.fire('pointerup');
    h.el.fire('mousedown');   h.el.fire('mouseup');     // synthesised — must be ignored
  });
  ok('PIN: one tap fires the tap action exactly ONCE', r.taps === 1, r);
  ok('PIN: …and never the hold action', r.holds === 0, r);
  ok('PIN: the synthesised mouse pair is not even listened for under Pointer Events',
     !r.has('mousedown') && !r.has('mouseup'), { mousedown: r.has('mousedown') });
}
{
  const r = countFor(true, h => {
    h.el.fire('pointerdown');
    h.tick();                       // held past the threshold
    h.el.fire('pointerup');
  });
  ok('PIN: a long press fires the hold action once', r.holds === 1, r);
  ok('PIN: …and the release does NOT then also fire a tap', r.taps === 0, r);
}
{
  // The mid-length case the brief asked about: released before the threshold.
  const r = countFor(true, h => { h.el.fire('pointerdown'); h.el.fire('pointerup'); h.tick(); });
  ok('PIN: a press released BEFORE the threshold is a tap, and the timer is dead',
     r.taps === 1 && r.holds === 0, r);
}
{
  const r = countFor(true, h => {
    h.el.fire('pointerdown');
    h.el.fire('pointermove', { clientX: 40, clientY: 60 });   // a scroll
    h.el.fire('pointerup');
    h.tick();
  });
  ok('PIN: scrolling the sheet is neither a tap nor a hold', r.taps === 0 && r.holds === 0, r);
}
{
  const r = countFor(true, h => {
    h.el.fire('pointerdown');
    h.el.fire('pointermove', { clientX: 3, clientY: 4 });     // within slop
    h.el.fire('pointerup');
  });
  ok('PIN: a slightly wobbly finger is still a tap', r.taps === 1 && r.holds === 0, r);
}
{
  const r = countFor(true, h => { h.el.fire('pointerdown'); h.el.fire('pointercancel'); h.tick(); });
  ok('PIN: a cancelled pointer fires nothing', r.taps === 0 && r.holds === 0, r);
}
{
  const r = countFor(true, h => { h.el.fire('pointerdown', { button: 2 }); h.el.fire('pointerup'); });
  ok('PIN: a right-button press is not a tap', r.taps === 0, r);
  const r2 = countFor(true, h => { h.el.fire('contextmenu'); });
  ok('PIN: …it reaches the hold action instead', r2.holds === 1 && r2.taps === 0, r2);
}
{
  // The legacy path, for a WebView with no Pointer Events.
  const r = countFor(false, h => {
    h.el.fire('touchstart'); h.el.fire('touchend');
    h.el.fire('mousedown');  h.el.fire('mouseup');
  });
  ok('PIN: without Pointer Events, touch still wins and the mouse pair is swallowed',
     r.taps === 1 && r.holds === 0, r);
  const r2 = countFor(false, h => { h.el.fire('mousedown'); h.el.fire('mouseup'); });
  ok('PIN: …while a real mouse-only click still taps', r2.taps === 1, r2);
}
{
  // The exact regression: the v104.0 wiring double-fired. Prove the new one doesn't.
  const r = countFor(true, h => {
    for (let i = 0; i < 3; i++) { h.el.fire('pointerdown'); h.el.fire('pointerup'); h.el.fire('mousedown'); h.el.fire('mouseup'); }
  });
  ok('PIN: three taps are three actions, not six', r.taps === 3, r);
}

console.log('\n── PIN: test_loads_tab_renders_discrete_rows_per_cycle ──────────');
{
  const DAY = '2026-07-30', T0 = Date.parse(DAY + 'T07:00:00');
  const lap = (id, m) => ({ id, date: DAY, pickup_name: 'Ranch Pit', dump_name: 'Dam Site',
    start_ts: T0 + m * 60000, end_ts: T0 + (m + 10) * 60000, duration_s: 600,
    load_s: 120, haul_s: 180, dump_s: 90, return_s: 210 });
  const day = [0, 10, 20, 30].map((m, i) => lap('c' + i, m));
  const segs = loadSegments(day);
  ok('PIN: one row per cycle', segs.length === 4, segs.length);
  ok('PIN: …each with its own id', new Set(segs.map(s => s.id)).size === 4);
  ok('PIN: …numbered for the eye', segs.map(s => s.n).join(',') === '1,2,3,4');
  ok('PIN: the rendered row carries a per-row tap target',
     /data-lap="/.test(html) && /querySelectorAll\('\[data-lap\]'\)/.test(html));
  ok('PIN: …wired individually, not on the container',
     /Array\.prototype\.forEach\.call\(body\.querySelectorAll\('\[data-lap\]'\)/.test(html));
  ok('PIN: nothing above the rows swallows the gesture — no capture, no preventDefault on tap',
     !/addEventListener\('pointerdown'[^)]*,\s*true\)/.test(html));
}

console.log('\n── PIN: test_short_tap_opens_individual_load_detail_only ────────');
ok('PIN: a tap focuses that one lap', /onTap:\s*function\(\)\{ ldToggleFocus\(id\); \}/.test(html));
ok('PIN: …and focus narrows what is drawn to that lap',
   /if\(ldFocus\) return all\.filter\(function\(c\)\{ return c\.id===ldFocus; \}\);/.test(html));
ok('PIN: …the focused row shows what that lap contributed', /ld-focus-detail/.test(html));
ok('PIN: …its LCM³ share', /LCM³ of the day/.test(html));
ok('PIN: …and its share of the day\'s lap time', /of the day\\'s lap time/.test(html));

console.log('\n── PIN: test_long_press_opens_context_menu_not_detail_view ──────');
ok('PIN: a hold opens the lap editor', /onHold:\s*function\(\)\{ openLoadModal\(id\); \}/.test(html));
ok('PIN: …which carries Edit, Flag and Delete in one place',
   /id="lm-mins"/.test(html) && /id="lm-reasons"/.test(html) && /Delete this lap/.test(html));
ok('PIN: trip rows use the same primitive, so the two screens behave alike',
   /wireRowGestures\(el,\{ onHold:function\(\)\{ tlRowActions\(id\); \} \}\)/.test(html));

console.log('\n── PIN: test_invoice_auto_summary_generates_from_days_loads_and_trips ──');
{
  const DAY = '2026-07-30', T0 = Date.parse(DAY + 'T07:00:00');
  const lap = (id, m, pick, dump) => ({ id, date: DAY, pickup_name: pick, dump_name: dump,
    start_ts: T0 + m * 60000, end_ts: T0 + (m + 16) * 60000, duration_s: 960 });
  const circuits = Array.from({ length: 12 }, (_, i) => lap('c' + i, i * 16, 'Ranch Pit', 'Dam Site'));
  const lines = daySummaryLines({
    date: DAY, circuits, capacityLcm: 12,
    subActivities: [{ name: 'Charcoal shed', hours: 2.5, output: 45, unit: 'kg', batches: 2 }],
    businessKm: 34.6
  });
  ok('PIN: the haul line leads', /^12 loads \(144 LCM³\) hauled from Ranch Pit to Dam Site$/.test(lines[0]), lines[0]);
  ok('PIN: …volume is loads × capacity', /144 LCM³/.test(lines[0]));
  ok('PIN: …and it names both ends in plain words, no zone ids',
     /Ranch Pit to Dam Site/.test(lines[0]) && !/z[0-9]/.test(lines.join(' ')));
  ok('PIN: productive hauling hours', lines[1] === '3.2h hauling', lines[1]);
  ok('PIN: the sub-activity reads as English',
     lines[2] === 'Charcoal shed — 2.5h, 45 kg over 2 batches', lines[2]);
  ok('PIN: business travel is included', lines[3] === '34.6 km travel', lines[3]);
  ok('PIN: no timestamps anywhere', !/\d\d:\d\d/.test(lines.join(' ')));
  ok('PIN: exactly four lines for this day', lines.length === 4, lines);

  // A two-face day reads as two lines, not one averaged fiction.
  const twoFace = daySummaryLines({
    date: DAY, capacityLcm: 12,
    circuits: [lap('a1', 0, 'Pit A', 'Dam Site'), lap('a2', 20, 'Pit A', 'Dam Site'),
               lap('b1', 40, 'Pit B', 'Stockpile')]
  });
  ok('PIN: two pickup→dump pairs give two haul lines',
     /^2 loads \(24 LCM³\) hauled from Pit A to Dam Site$/.test(twoFace[0]) &&
     /^1 load \(12 LCM³\) hauled from Pit B to Stockpile$/.test(twoFace[1]), twoFace);
  ok('PIN: …and "1 load" is singular', /1 load \(/.test(twoFace[1]));
  ok('PIN: flagged laps are excluded from the words as well as the numbers', (() => {
      const l = daySummaryLines({ date: DAY, capacityLcm: 12,
        circuits: circuits.map((c, i) => i < 2 ? applyLoadVoid(c, 'break', 1) : c) });
      return /^10 loads \(120 LCM³\)/.test(l[0]);
    })());
  ok('PIN: with no truck capacity the volume is simply omitted, never zero', (() => {
      const l = daySummaryLines({ date: DAY, circuits, capacityLcm: 0 });
      return l[0] === '12 loads hauled from Ranch Pit to Dam Site' && !/LCM/.test(l[0]);
    })());
}

console.log('\n── PIN: test_auto_summary_hides_sections_with_no_data ───────────');
{
  const DAY = '2026-07-30', T0 = Date.parse(DAY + 'T07:00:00');
  const one = [{ id: 'c1', date: DAY, pickup_name: 'Pit', dump_name: 'Tip',
                 start_ts: T0, end_ts: T0 + 600000, duration_s: 600 }];
  const lines = daySummaryLines({ date: DAY, circuits: one, capacityLcm: 12 });
  ok('PIN: a hauling-only day is two lines, not padded with blanks', lines.length === 2, lines);
  ok('PIN: …no empty travel line', !lines.some(l => /km travel/.test(l)));
  ok('PIN: …no empty sub-activity line', !lines.some(l => /—/.test(l)));
  ok('PIN: a charcoal-only day mentions only charcoal', (() => {
      const l = daySummaryLines({ date: DAY, subActivities: [{ name: 'Charcoal shed', hours: 4, output: 45, unit: 'kg', batches: 1 }] });
      return l.length === 1 && /^Charcoal shed — 4h, 45 kg$/.test(l[0]);
    })());
  ok('PIN: …and a single batch does not say "over 1 batches"', (() => {
      const l = daySummaryLines({ date: DAY, subActivities: [{ name: 'Shed', hours: 1, output: 5, unit: 'kg', batches: 1 }] });
      return !/batches/.test(l[0]);
    })());
  ok('PIN: a day with nothing recorded produces no lines at all',
     daySummaryLines({ date: DAY }).length === 0);
  ok('PIN: …and therefore no block on the invoice', buildWorkSummary([{ date: DAY }], d => d) === '');
  ok('PIN: null input is safe', daySummaryLines(null).length === 0 && buildWorkSummary(null) === '');
  ok('PIN: travel-only day is one line',
     daySummaryLines({ date: DAY, businessKm: 12.4 }).join('') === '12.4 km travel');
}

console.log('\nMulti-day invoices date their blocks; single-day ones do not');
{
  const mk = (date, n) => ({ date, capacityLcm: 12, circuits: Array.from({ length: n }, (_, i) => ({
    id: date + i, date, pickup_name: 'Pit', dump_name: 'Tip',
    start_ts: Date.parse(date + 'T07:00:00') + i * 6e5, end_ts: Date.parse(date + 'T07:10:00') + i * 6e5, duration_s: 600 })) });
  const single = buildWorkSummary([mk('2026-07-30', 3)], d => 'THE-DATE');
  ok('a single-day invoice has no date heading', !/THE-DATE/.test(single), single);
  ok('…and every line is bulleted', single.split('\n').every(l => l.startsWith('• ')), single);
  const multi = buildWorkSummary([mk('2026-07-29', 2), mk('2026-07-30', 3)], d => 'D:' + d);
  ok('a multi-day invoice heads each block with its date', (multi.match(/D:/g) || []).length === 2, multi);
  ok('…oldest first', multi.indexOf('D:2026-07-29') < multi.indexOf('D:2026-07-30'));
  ok('…separated by a blank line', /\n\n/.test(multi));
  ok('days with no data are dropped entirely, not left as an empty heading',
     !/D:2026-07-28/.test(buildWorkSummary([{ date: '2026-07-28' }, mk('2026-07-30', 1)], d => 'D:' + d)));
}

console.log('\n── PIN: test_auto_summary_editable_before_invoice_send ──────────');
ok('PIN: the Invoice screen has an editable summary box', /id="inv-summary-text"/.test(html));
ok('PIN: …a textarea, so line breaks survive', /<textarea id="inv-summary-text"/.test(html));
ok('PIN: …typing marks it as his', /oninput="invSummaryEdited\(\)"/.test(html));
ok('PIN: …and the edit is what reaches the invoice',
   /if\(el && el\.dataset\.userEdited==='1'\) return el\.value;/.test(html));
ok('PIN: …surviving a re-render', /if\(sumEl\.dataset\.userEdited!=='1'\)\{\s*\n\s*sumEl\.value=buildWorkSummary/.test(html));
ok('PIN: …with a way back to the generated text', /invSummaryReset/.test(html) && /↻ Rebuild/.test(html));
ok('PIN: the block renders on the printed invoice',
   /\$\{_summaryBlockHTML\(invoiceSummaryText\(ui\),true\)\}/.test(html));
ok('PIN: …and on the on-screen preview',
   /\$\{_summaryBlockHTML\(invoiceSummaryText\(ui\),false\)\}/.test(html));
ok('PIN: the card hides when there is nothing to say',
   /sumCard\.style\.display=\(selectedCount&&\(sumEl\.value\|\|''\)\.trim\(\)\)\?'block':'none';/.test(html));

console.log('\nThe printed block formats safely');
{
  // _summaryBlockHTML is impure-ish (uses escHtml) so it is exercised in the
  // live suite; here we check the contract it relies on.
  ok('lines are split on newlines, not rendered as one run', /String\(text\)\.split\('\\n'\)/.test(html));
  ok('bullets get a hanging indent so a long line wraps under itself',
     /text-indent:-12px/.test(html));
  ok('a date heading renders bold rather than as a bullet', /font-weight:700;margin-top:6px/.test(html));
  ok('the text is escaped — a client name with an ampersand cannot break the page',
     /escHtml\(t\)/.test(html));
  ok('an empty summary produces no block at all',
     /if\(!text\|\|!String\(text\)\.trim\(\)\) return '';/.test(html));
}

console.log('\nThe money path is untouched by any of this');
{
  const DAY = '2026-07-30', T0 = Date.parse(DAY + 'T07:00:00');
  const circuits = Array.from({ length: 5 }, (_, i) => ({ id: 'c' + i, date: DAY,
    pickup_name: 'Pit', dump_name: 'Tip', start_ts: T0 + i * 6e5, end_ts: T0 + (i + 1) * 6e5, duration_s: 600 }));
  const before = JSON.stringify(loadsRollup(circuits, 12));
  daySummaryLines({ date: DAY, circuits, capacityLcm: 12 });
  ok('generating a summary mutates nothing', JSON.stringify(loadsRollup(circuits, 12)) === before);
  ok('the summary computes no money — no $ anywhere in its output',
     !/\$/.test(daySummaryLines({ date: DAY, circuits, capacityLcm: 12,
        subActivities: [{ name: 'Shed', hours: 1, output: 5, unit: 'kg', batches: 1 }], businessKm: 10 }).join(' ')));
}

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
