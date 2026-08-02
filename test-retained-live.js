#!/usr/bin/env node
/*
 * test-retained-live.js — v106.0 goal widget + exclusion review, for real.
 *
 * test-retained.js pins the logic and the structure. This drives the actual
 * screens in a real browser: seeds a financial year of days, renders the widget,
 * reads the numbers off the DOM, taps through to the review screen, flips a
 * component and watches every figure move together — then generates a real
 * invoice and proves not one dollar on it changed.
 *
 * Run:  node test-retained-live.js
 *       KEEP=1 node test-retained-live.js     (leaves Chrome up)
 *       SHOT=1 node test-retained-live.js     (writes 375px screenshots)
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9481);
const HTTP_PORT = +(process.env.HTTP_PORT || 8829);
const WWW = path.join(__dirname, 'www');
const SHOTS = path.join(__dirname, 'plans', 'v106-shots');

function requireWs() {
  const paths = [process.env.WS_NODE_PATH,
    '/usr/local/lib/node_modules/openclaw/node_modules',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules'].filter(Boolean);
  try { return require('ws'); } catch (_) {}
  for (const p of paths) { try { return require(path.join(p, 'ws')); } catch (_) {} }
  throw new Error('the `ws` node module is required (set WS_NODE_PATH)');
}
const WS = requireWs();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, eps) => Math.abs(a - b) < (eps === undefined ? 0.02 : eps);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rq) => {
      const p = path.join(WWW, decodeURIComponent(req.url.split('?')[0]));
      fs.readFile(p, (e, d) => {
        if (e) { rq.writeHead(404); rq.end('nope'); return; }
        rq.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
                            'Cache-Control': 'no-store' });
        rq.end(d);
      });
    });
    srv.listen(HTTP_PORT, () => res(srv));
  });
}

/* A financial year of real-shaped days. Deliberately mixed:
   · 20 plain labour days                          → retained only
   · 10 days with an extra labourer                → the passthrough Steven named
   ·  6 days with machine hire (wet, with overage) → passthrough by default
   ·  4 days with travel + materials               → passthrough by default
   Every day is CONFIRMED (in `days`), because that is the only store the money
   path and the goal tally read. */
const SEED = `(function(){
  var days=[], id=0;
  function mk(dateStr, extra){
    var d = {
      id:'seed'+(id++), date:dateStr, site:'Lucas Ranch', start:'07:00', finish:'15:00',
      lunchMins:0, rate:60, sonWorking:false, sonHours:null, sonrate:30,
      machines:[], travelMode:'none', materials:[]
    };
    for (var k in (extra||{})) d[k]=extra[k];
    return d;
  }
  // July–October 2026 (FY2026-27). Weekday-ish spread, one day per slot.
  var slots=[];
  for (var m=7; m<=10; m++) for (var day=1; day<=10; day++)
    slots.push('2026-'+String(m).padStart(2,'0')+'-'+String(day).padStart(2,'0'));

  for (var i=0;i<20;i++) days.push(mk(slots[i]));
  for (var i=20;i<30;i++) days.push(mk(slots[i], {sonWorking:true, sonHours:8, sonrate:30}));
  for (var i=30;i<36;i++) days.push(mk(slots[i], {
    machines:[{name:'Excavator',hireType:'wet',startHrs:100,finishHrs:106,rate:150}] }));
  for (var i=36;i<40;i++) days.push(mk(slots[i], {
    travelMode:'km', travelKm:50, travelKmRate:0.88,
    materials:[{name:'Road base',qty:10,unitPrice:12}] }));

  localStorage.setItem('mcn_days', JSON.stringify(days));
  var s = JSON.parse(localStorage.getItem('mcn_settings')||'{}');
  s.rate=60; s.sonrate=30; s.annualEarningsGoal=90000; s.weeklyHrsGoal=40;
  s.machineRates={Excavator:150,Grader:180,Bobcat:120,Dozer:200,Tractor:110};
  delete s.retention;                       // start from the shipped default
  localStorage.setItem('mcn_settings', JSON.stringify(s));
  return days.length;
})()`;

const BOOT = `(function(){
  var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
  var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
  var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
  try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
  return 'ok';
})()`;

(async () => {
  const srv = await serve();
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=/tmp/cr-ret-' + process.pid, '--window-size=375,812', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

  const getJson = p => new Promise((res, rej) =>
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej));

  let tabs = null;
  for (let i = 0; i < 80; i++) { try { tabs = await getJson('/json/list'); if (tabs.length) break; } catch (_) {} await sleep(200); }
  if (!tabs) { console.error('✗ Chrome did not start'); process.exit(2); }

  const page = tabs.find(t => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));
  let mid = 0; const pend = new Map(); const pageErrors = [];
  ws.on('message', m => {
    const j = JSON.parse(m);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
    if (j.method === 'Runtime.exceptionThrown') {
      pageErrors.push((j.params.exceptionDetails.exception &&
                       j.params.exceptionDetails.exception.description) || j.params.exceptionDetails.text);
    }
  });
  const cmd = (method, params) => new Promise(res => {
    const i = ++mid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const d = r.result;
    if (d && d.exceptionDetails) throw new Error('page threw: ' +
      JSON.stringify((d.exceptionDetails.exception && d.exceptionDetails.exception.description) || d.exceptionDetails.text));
    return d && d.result && d.result.value;
  };

  await cmd('Page.enable'); await cmd('Runtime.enable');
  // 375px — Steven's phone is the design target, and the widget has to fit it.
  await cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  const URL = 'http://127.0.0.1:' + HTTP_PORT + '/index.html';

  /* Clip to the element under test. A full-page capture here is worthless: the
     signed-out login screen is re-shown by the Firebase auth callback a beat
     after boot, so it sits on top of everything and the shot shows a login form
     instead of the widget. Clipping to the element's own box sidesteps that
     entirely and yields a 375px-wide image of exactly the thing being reviewed. */
  // Plain viewport capture — the phone frame as Steven sees it. Sticky/fixed
  // chrome (header, nav) renders correctly here; in a beyond-viewport capture it
  // pins itself mid-image, which is why the two helpers both exist.
  async function shotViewport(name) {
    if (!process.env.SHOT) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await hideAuthChrome();
    await ev(`window.scrollTo(0,0)`); await sleep(200);
    const r = await cmd('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64'));
      console.log('    ▸ plans/v106-shots/' + name + '.png (375×812 viewport)');
    }
  }

  const hideAuthChrome = () => ev(`(function(){
      ['screen-login','screen-loading'].forEach(function(id){
        var n=document.getElementById(id); if(n) n.style.display='none'; });
      var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
      var b=document.getElementById('backup-warning'); if(b) b.style.display='none';
      return true;})()`);

  async function shot(name, selector) {
    if (!process.env.SHOT) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await ev(`(function(){
      ['screen-login','screen-loading'].forEach(function(id){
        var n=document.getElementById(id); if(n) n.style.display='none'; });
      var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
      var b=document.getElementById('backup-warning'); if(b) b.style.display='none';
      return true;})()`);
    const box = await ev(`(function(){var n=document.querySelector(${JSON.stringify(selector)});
      if(!n) return null; n.scrollIntoView(); var r=n.getBoundingClientRect();
      return {x:Math.max(0,r.left+window.scrollX-8), y:Math.max(0,r.top+window.scrollY-8),
              width:Math.min(375,r.width+16), height:r.height+16};})()`);
    const r = await cmd('Page.captureScreenshot', Object.assign(
      { format: 'png', captureBeyondViewport: true },
      box ? { clip: Object.assign({ scale: 2 }, box) } : {}));
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64'));
      console.log('    ▸ plans/v106-shots/' + name + '.png' + (box ? ` (${Math.round(box.width)}×${Math.round(box.height)}px)` : ''));
    }
  }

  // Boot once with an empty store to get the app's own functions, seed, reload.
  await cmd('Page.navigate', { url: URL + '?cb=' + Date.now() });
  for (let i = 0; i < 100; i++) {
    if (await ev(`typeof initApp==='function' && typeof dayTotals==='function'`)) break;
    await sleep(200);
  }
  const seeded = await ev(SEED);
  await cmd('Page.navigate', { url: URL + '?cb=' + (Date.now() + 1) });
  for (let i = 0; i < 100; i++) {
    if (await ev(`typeof initApp==='function' && typeof renderGoalWidget==='function'`)) break;
    await sleep(200);
  }
  const booted = await ev(BOOT);
  await sleep(700);

  console.log('── boot ───────────────────────────────────────────────────────────');
  ok('the app booted', booted === 'ok', booted);
  ok('40 days seeded into the confirmed store', seeded === 40, seeded);
  ok('v106 functions are live', await ev(
    `['retentionPolicy','splitDayRevenue','retainedTally','retainedYtd','renderGoalWidget','renderRetainedReview','setRetention'].every(n=>typeof window[n]==='function')`));

  // ── The expected arithmetic, computed from the seed, independent of the app ──
  // 40 days × 8h × $60 = $19,200 retained.
  // extra:    10 × 8h × $30      = $2,400
  // machine:   6 × (6h×$150 + 2h×$60) = 6 × $1,020 = $6,120
  // travel:    4 × 50km × $0.88  = $176
  // materials: 4 × 10 × $12      = $480
  const EXP = { retained: 19200, extra: 2400, machine: 6120, travel: 176, materials: 480 };
  EXP.passthrough = EXP.extra + EXP.machine + EXP.travel + EXP.materials;   // 9,176
  EXP.gross = EXP.retained + EXP.passthrough;                               // 28,376

  console.log('\n── PIN: test_goal_tally_excludes_passthrough_live ─────────────────');
  {
    const t = await ev(`(function(){var r=retainedYtd(fyForDate(new Date('2026-09-01')));
      return {retained:r.tally.retained,passthrough:r.tally.passthrough,gross:r.tally.gross,
              days:r.tally.dayCount,hours:r.tally.hours,
              comp:Object.keys(r.tally.byComponent).reduce(function(a,k){a[k]=r.tally.byComponent[k].amount;return a;},{})};})()`);
    ok('PIN: retained = his labour only ($19,200)', near(t.retained, EXP.retained), t.retained);
    ok('PIN: passthrough excluded ($9,176)', near(t.passthrough, EXP.passthrough), t.passthrough);
    ok('PIN: the invoiced gross is still the full $28,376', near(t.gross, EXP.gross), t.gross);
    ok('PIN: gross = retained + passthrough', near(t.gross, t.retained + t.passthrough));
    ok('all 40 days counted', t.days === 40, t.days);
    ok('320 hours', near(t.hours, 320), t.hours);
    ok('extra labourer component = $2,400', near(t.comp.extra, EXP.extra), t.comp.extra);
    ok('machine hire component = $6,120', near(t.comp.machine, EXP.machine), t.comp.machine);
    ok('travel component = $176', near(t.comp.travel, EXP.travel), t.comp.travel);
    ok('materials component = $480', near(t.comp.materials, EXP.materials), t.comp.materials);

    // The independent cross-check: sum the REAL dayTotals over the same days.
    const grossFromMoneyPath = await ev(
      `days().reduce(function(a,d){return a+dayTotals(d).total;},0)`);
    ok('PIN: the tally gross equals the sum of dayTotals().total exactly',
       near(t.gross, grossFromMoneyPath), { tally: t.gross, moneyPath: grossFromMoneyPath });
  }

  console.log('\n── the widget renders ─────────────────────────────────────────────');
  {
    await ev(`showScreen('analytics')`); await sleep(500);
    const w = await ev(`(function(){var el=document.getElementById('goal-widget');
      if(!el) return null; var c=el.querySelector('.gw-card'); if(!c) return null;
      return {now:el.querySelector('.gw-now').textContent.trim(),
              of:el.querySelector('.gw-of').textContent.replace(/\\s+/g,' ').trim(),
              hasBar:!!el.querySelector('.gw-bar'),
              fill:el.querySelector('.gw-fill')?el.querySelector('.gw-fill').style.width:null,
              ticks:el.querySelectorAll('.gw-tick').length,
              hitTicks:el.querySelectorAll('.gw-tick.hit').length,
              chips:el.querySelectorAll('.gw-chip').length,
              rows:[].map.call(el.querySelectorAll('.gw-row'),function(r){
                return r.textContent.replace(/\\s+/g,' ').trim();}),
              pace:el.querySelector('.gw-pace')?el.querySelector('.gw-pace').textContent.replace(/\\s+/g,' ').trim():'',
              caveats:el.querySelectorAll('.gw-caveat').length,
              foot:el.querySelector('.gw-foot')?el.querySelector('.gw-foot').textContent.replace(/\\s+/g,' ').trim():'',
              reviewBtn:!!el.querySelector('.gw-review')};})()`);
    ok('the widget mounted', !!w);
    ok('the big number is the RETAINED figure', w.now === '$19,200.00', w.now);
    ok('…not the invoiced gross', w.now !== '$28,376.00');
    ok('the of-target line names the target', /of \$90,000\.00/.test(w.of), w.of);
    ok('…the percentage', /21\.3% there/.test(w.of), w.of);
    ok('…and what is left to go', /\$70,800\.00 to go/.test(w.of), w.of);
    ok('a progress bar is drawn', w.hasBar);
    ok('the fill matches the percentage', w.fill === '21.33%', w.fill);
    ok('three milestone ticks', w.ticks === 3, w.ticks);
    ok('none reached yet at 21%', w.hitTicks === 0, w.hitTicks);
    ok('three milestone chips', w.chips === 3, w.chips);

    const joined = w.rows.join(' | ');
    ok('attribution shows what contributes', /My labour.*\+\$19,200/.test(joined), joined);
    ok('…what is costing (extra labourer)', /Extra labourer.*−\$2,400/.test(joined), joined);
    ok('…machine hire', /Machine hire.*−\$6,120/.test(joined));
    ok('…travel', /Travel.*−\$176/.test(joined));
    ok('…materials', /Materials.*−\$480/.test(joined));
    ok('…and the net "invoiced, all in" line', /Invoiced, all in.*\$28,376/.test(joined), joined);
    ok('the day count is on the net row', /40 days/.test(joined));

    ok('pace commentary is present', w.pace.length > 40, w.pace);
    ok('…quoting a weekly rate', /\/week retained/.test(w.pace), w.pace);
    ok('…and it carries caveats', w.caveats >= 1, w.caveats);
    ok('…including the seasonality one', /wet weather|Christmas/.test(w.pace));
    ok('a timestamp is shown', /Updated \d\d:\d\d/.test(w.foot), w.foot);
    ok('a review CTA is offered', w.reviewBtn);
    await shot('01-goal-widget-375', '#goal-widget .gw-card');
    await shotViewport('00-stats-tab-375');
  }

  console.log('\n── it fits 375px ──────────────────────────────────────────────────');
  {
    const fit = await ev(`(function(){
      var el=document.getElementById('goal-widget');
      var card=el.querySelector('.gw-card');
      var over=[].filter.call(el.querySelectorAll('*'),function(n){
        return n.getBoundingClientRect().right > 375.5; }).length;
      return {docW:document.documentElement.scrollWidth, cardW:Math.round(card.getBoundingClientRect().width),
              cardRight:Math.round(card.getBoundingClientRect().right), overflowing:over};})()`);
    ok('the page does not scroll horizontally at 375px', fit.docW <= 375, fit.docW);
    ok('the widget sits inside the viewport', fit.cardRight <= 375, fit.cardRight);
    ok('no descendant overflows the right edge', fit.overflowing === 0, fit.overflowing);
  }

  console.log('\n── PIN: test_review_screen_lists_every_excluded_item ──────────────');
  {
    await ev(`document.querySelector('.gw-review').click()`); await sleep(500);
    const r = await ev(`(function(){var s=document.getElementById('screen-retained');
      return {active:s.classList.contains('active'),
              totals:[].map.call(s.querySelectorAll('.rv-tot .rv-v'),function(n){return n.textContent.trim();}),
              toggles:s.querySelectorAll('.rv-tog').length,
              on:[].filter.call(s.querySelectorAll('.rv-tog input'),function(i){return i.checked;}).length,
              dayBlocks:s.querySelectorAll('.rv-day').length,
              items:s.querySelectorAll('.rv-item').length,
              count:s.querySelector('#rv-count').textContent.trim(),
              firstItem:s.querySelector('.rv-item')?s.querySelector('.rv-item').textContent.replace(/\\s+/g,' ').trim():'',
              details:[].map.call(s.querySelectorAll('.rv-idet'),function(n){return n.textContent.trim();})};})()`);
    ok('PIN: the review screen opened', r.active);
    ok('PIN: it shows retained / excluded / invoiced', r.totals.length === 3, r.totals);
    ok('PIN: …$19,200 retained', r.totals[0] === '$19,200.00', r.totals[0]);
    ok('PIN: …$9,176.00 excluded', r.totals[1] === '$9,176.00', r.totals[1]);
    ok('PIN: …$28,376.00 invoiced', r.totals[2] === '$28,376.00', r.totals[2]);
    // 24, not 20: the 4 travel days ALSO carry materials, so those days
    // contribute two rows each. 10 extra + 6 machine + 4 travel + 4 materials.
    ok('PIN: one row per excluded line item, not one per day', r.items === 24, r.items);
    ok('PIN: …across the 20 days that had any', r.dayBlocks === 20, r.dayBlocks);
    ok('the item count is stated', /24 items/.test(r.count), r.count);
    ok('five component toggles', r.toggles === 5, r.toggles);
    ok('exactly one is on (labour)', r.on === 1, r.on);
    ok('rows carry a human detail line', r.details.length > 0);
    ok('…extra labour shows hours × rate', r.details.some(d => /8\.00h × \$30\.00\/hr/.test(d)), r.details[0]);
    ok('…machine shows the machine and overage', r.details.some(d => /Excavator — 6\.00h × \$150\.00 \+ 2\.00h operator/.test(d)));
    ok('…travel shows km × rate', r.details.some(d => /50 km × \$0\.88\/km/.test(d)));
    ok('…materials names the material', r.details.some(d => /Road base — 10 × \$12\.00/.test(d)));
    await shot('02-review-excluded-375', '#screen-retained .section');
    await shotViewport('03-review-top-375');

    const fit = await ev(`document.documentElement.scrollWidth`);
    ok('the review screen fits 375px too', fit <= 375, fit);
  }

  console.log('\n── flipping a component moves every figure together ───────────────');
  {
    // Turn machine hire ON — it should join the goal number and leave the list.
    await ev(`setRetention('machine', true)`); await sleep(400);
    const after = await ev(`(function(){var r=retainedYtd(fyForDate(new Date('2026-09-01')));
      var s=document.getElementById('screen-retained');
      return {retained:r.tally.retained, gross:r.tally.gross,
              items:s.querySelectorAll('.rv-item').length,
              totals:[].map.call(s.querySelectorAll('.rv-tot .rv-v'),function(n){return n.textContent.trim();}),
              stored:JSON.parse(localStorage.getItem('mcn_settings')).retention};})()`);
    ok('retained rises by exactly the machine total', near(after.retained, EXP.retained + EXP.machine), after.retained);
    ok('PIN: the invoiced gross does NOT move', near(after.gross, EXP.gross), after.gross);
    ok('the excluded total drops to $3,056', after.totals[1] === '$3,056.00', after.totals[1]);
    ok('the 6 machine rows leave the list', after.items === 18, after.items);
    ok('the choice persisted to the settings blob', after.stored && after.stored.machine === true, after.stored);

    await ev(`showScreen('analytics')`); await sleep(400);
    const widgetNow = await ev(`document.querySelector('#goal-widget .gw-now').textContent.trim()`);
    ok('the widget headline followed', widgetNow === '$25,320.00', widgetNow);

    // Put it back — a review decision must be reversible, never a write lock.
    await ev(`showScreen('retained')`); await sleep(300);
    await ev(`setRetention('machine', false)`); await sleep(400);
    const back = await ev(`retainedYtd(fyForDate(new Date('2026-09-01'))).tally.retained`);
    ok('flipping it back restores the original figure', near(back, EXP.retained), back);
    ok('…with no data migration involved (nothing stamped on any day)',
       await ev(`days().every(function(d){return d.retained===undefined && d.passthrough===undefined && d.retention===undefined;})`));
  }

  console.log('\n── PIN: test_not_one_dollar_on_the_invoice_changes ────────────────');
  {
    // Generate the invoice HTML under the default policy, then under a policy
    // where EVERYTHING is retained, and diff the dollar figures.
    const dollars = expr => ev(`(function(){${expr}
      showScreen('invoice'); renderInvoice();
      var sel=document.querySelectorAll('#inv-day-list input[type=checkbox]');
      [].forEach.call(sel,function(c){ if(!c.checked) c.click(); });
      var html=buildInvoiceHTML();
      return (html.match(/\\$[0-9,]+\\.[0-9]{2}/g)||[]).join('|');
    })()`);

    const a = await dollars(`var s=S(); delete s.retention; DB.set('settings',s);`);
    const b = await dollars(`var s=S(); s.retention={labour:true,extra:true,machine:true,travel:true,materials:true}; DB.set('settings',s);`);
    const c = await dollars(`var s=S(); s.retention={labour:false,extra:false,machine:false,travel:false,materials:false}; DB.set('settings',s);`);

    ok('PIN: the invoice has dollar figures to compare', a && a.length > 20);
    ok('PIN: retaining everything changes NOT ONE figure on the invoice', a === b,
       { defaultPolicy: (a || '').slice(0, 90), allRetained: (b || '').slice(0, 90) });
    ok('PIN: retaining nothing changes NOT ONE figure either', a === c);
    ok('PIN: the extra-labourer line is still billed to the client',
       await ev(`/Extra|labourer/i.test(buildInvoiceHTML())`));
    await ev(`var s=S(); delete s.retention; DB.set('settings',s);`);
  }

  console.log('\n── the goal card and its detail modal agree ───────────────────────');
  {
    await ev(`showScreen('analytics')`); await sleep(400);
    const card = await ev(`document.getElementById('ty-ann-actual').textContent.trim()`);
    ok('the This Year card headline is the retained figure', card === '$19,200.00', card);
    ok('the widget and the card show the same number',
       card === await ev(`document.querySelector('#goal-widget .gw-now').textContent.trim()`));

    await ev(`openYearGoalDetail()`); await sleep(400);
    const modal = await ev(`(function(){var m=document.querySelector('.modal-bg.open')||document.body;
      return m.textContent.replace(/\\s+/g,' ');})()`);
    ok('PIN: the detail modal reports the SAME retained figure', /Retained YTD \(you keep\)\s*\$19,200\.00/.test(modal),
       (modal.match(/Retained YTD[^$]*\$[\d,.]+/) || [])[0]);
    ok('…and shows the invoiced gross beside it', /Invoiced YTD \(client pays\)\s*\$28,376\.00/.test(modal),
       (modal.match(/Invoiced YTD[^$]*\$[\d,.]+/) || [])[0]);
    ok('…and names each deduction', /less Extra labourer\s*−\$2,400\.00/.test(modal),
       (modal.match(/less Extra labourer[^$]*\$[\d,.]+/) || [])[0]);
    ok('PIN: the misleading "includes … materials" line is gone',
       !/includes hours, machines, travel and materials/.test(modal));
  }

  console.log('\n── empty / edge states ────────────────────────────────────────────');
  {
    await ev(`(function(){var m=document.querySelector('.modal-bg.open'); if(m) m.classList.remove('open');})()`);
    // No target set → nulls, not a fabricated 0%.
    await ev(`var s=S(); s.annualEarningsGoal=0; s.weeklyHrsGoal=0; DB.set('settings',s); renderGoalWidget();`);
    await sleep(300);
    const noTarget = await ev(`(function(){var el=document.getElementById('goal-widget');
      return {bar:!!el.querySelector('.gw-bar'), chips:el.querySelectorAll('.gw-chip').length,
              of:el.querySelector('.gw-of').textContent.replace(/\\s+/g,' ').trim(),
              now:el.querySelector('.gw-now').textContent.trim(),
              pace:el.querySelector('.gw-pace').textContent.replace(/\\s+/g,' ').trim()};})()`);
    ok('no target → NO progress bar (rather than a 0% one)', !noTarget.bar);
    ok('no target → no milestone chips', noTarget.chips === 0);
    ok('no target → it says so plainly', /No target set/.test(noTarget.of), noTarget.of);
    ok('no target → the retained figure is still shown', noTarget.now === '$19,200.00', noTarget.now);
    ok('no target → the pace text asks for a goal', /No earnings goal set/.test(noTarget.pace), noTarget.pace);

    // No days at all → no fabricated pace.
    await ev(`var s=S(); s.annualEarningsGoal=90000; DB.set('settings',s);
              DB.set('days',[]); renderGoalWidget();`);
    await sleep(300);
    const noDays = await ev(`(function(){var el=document.getElementById('goal-widget');
      return {now:el.querySelector('.gw-now').textContent.trim(),
              pace:el.querySelector('.gw-pace').textContent.replace(/\\s+/g,' ').trim(),
              empty:!!el.querySelector('.gw-empty'), review:!!el.querySelector('.gw-review')};})()`);
    ok('no days → $0.00, not NaN', noDays.now === '$0.00', noDays.now);
    ok('no days → refuses to project a pace', /no rate to project from|made-up number/.test(noDays.pace), noDays.pace);
    ok('no days → says nothing is retained yet', noDays.empty);
    ok('no days → no review CTA (nothing to review)', !noDays.review);

    await ev(`showScreen('retained')`); await sleep(300);
    const emptyReview = await ev(`document.getElementById('rv-list').textContent.replace(/\\s+/g,' ').trim()`);
    ok('the review screen explains an empty state', /Nothing is being excluded/.test(emptyReview), emptyReview.slice(0, 80));
  }

  console.log('\n── no page errors ─────────────────────────────────────────────────');
  {
    const real = pageErrors.filter(e => !/favicon|net::ERR|firebase|Failed to fetch|gstatic/i.test(e));
    ok('nothing threw during the run', real.length === 0, real.slice(0, 3));
  }

  console.log('\n' + '─'.repeat(66));
  console.log(fail === 0 ? `✓ ALL ${pass} PASSED` : `✗ ${fail} FAILED (${pass} passed)`);

  if (!process.env.KEEP) { try { ws.close(); } catch (_) {} chrome.kill(); srv.close(); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
