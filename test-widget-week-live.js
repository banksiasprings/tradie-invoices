#!/usr/bin/env node
/*
 * test-widget-week-live.js — v108.0 "tap a week bar, get that week's log".
 *
 * test-widget.js proves the wiring exists and the native request codes keep the
 * six bars apart. This drives the JS half in a real browser: it stubs the
 * Capacitor bridge to answer consumePendingScreen() the way a bar tap does, runs
 * the REAL drainWidgetTap(), and reads the resulting Log off the DOM.
 *
 * The assertion that matters most is the CONTROL at the end. "Only that week's
 * days are listed" passes trivially if the filter simply hides everything, and
 * it passes for the wrong reason if the seed happens to contain one week — so
 * the seed spans four weeks, the unfiltered count is asserted first, and a plain
 * whole-card tap has to put every day back.
 *
 * Run:  node test-widget-week-live.js
 *       KEEP=1 node test-widget-week-live.js   (leaves Chrome up)
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9487);
const HTTP_PORT = +(process.env.HTTP_PORT || 8835);
const WWW = path.join(__dirname, 'www');

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

/* Four Mondays, two days in each — so a week filter has something to EXCLUDE.
   Dates are chosen off the real calendar: 2026-07-06, -13, -20 and -27 are all
   Mondays, and each pair sits inside its own week. */
const WEEKS = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'];
const SEED = `(function(){
  var days=[], id=0;
  ${JSON.stringify(WEEKS)}.forEach(function(mon){
    [0,1].forEach(function(off){
      var d=new Date(mon+'T00:00:00'); d.setDate(d.getDate()+off);
      var ds=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      days.push({id:'w'+(id++), date:ds, site:'Lucas Ranch', start:'07:00', finish:'15:00',
                 lunchMins:0, rate:60, sonWorking:false, sonHours:null, sonrate:30,
                 machines:[], travelMode:'none', materials:[]});
    });
  });
  localStorage.setItem('mcn_days', JSON.stringify(days));
  var s=JSON.parse(localStorage.getItem('mcn_settings')||'{}');
  s.rate=60; localStorage.setItem('mcn_settings', JSON.stringify(s));
  return days.length;
})()`;

const BOOT = `(function(){
  var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
  var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
  var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
  try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
  return 'ok';
})()`;

/* The bridge a widget tap arrives through. Installed AFTER boot: window.Capacitor
   is assigned by the type="module" Firebase/Capacitor scripts, which load
   asynchronously, so a stub placed during boot gets clobbered a moment later —
   the harness note recorded in the v105.0 work, and it applies here too. */
const stubBridge = (screen, week) => `(function(){
  window.Capacitor = window.Capacitor || {};
  window.Capacitor.Plugins = window.Capacitor.Plugins || {};
  window.__consumed = 0;
  window.Capacitor.Plugins.StatsWidget = {
    consumePendingScreen: function(){
      window.__consumed++;
      return Promise.resolve({ screen: ${JSON.stringify(screen)}, week: ${week === null ? 'null' : JSON.stringify(week)} });
    }
  };
  return true;
})()`;

const logRows = `(function(){
  var el=document.getElementById('log-list');
  return Array.prototype.slice.call(el.querySelectorAll('.date')).map(function(n){return n.textContent.trim();});
})()`;

(async () => {
  const srv = await serve();
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=/tmp/cr-wk-' + process.pid, '--window-size=375,812', '--hide-scrollbars',
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
  await cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  const URL = 'http://127.0.0.1:' + HTTP_PORT + '/index.html';

  await cmd('Page.navigate', { url: URL }); await sleep(1200);
  await ev(`localStorage.clear()`);
  const seeded = await ev(SEED);
  await cmd('Page.navigate', { url: URL }); await sleep(1400);
  const boot = await ev(BOOT); await sleep(400);
  if (boot !== 'ok') { console.error('✗ boot failed: ' + boot); process.exit(2); }

  console.log('\n── the seed spans four weeks ─────────────────────────────────────');
  {
    ok('8 days seeded across 4 weeks', seeded === 8, seeded);
    await ev(`showScreen('log')`); await sleep(300);
    const rows = await ev(logRows);
    // Asserted BEFORE any filtering: without this, "3 of 8 shown" below could
    // just as well mean the Log never renders more than 3 rows.
    ok('CONTROL: unfiltered, the Log lists all 8', rows.length === 8, rows.length);
    ok('…and the week banner is hidden',
       await ev(`document.getElementById('log-week-banner').style.display === 'none'`));
  }

  console.log('\n── PIN: test_week_bar_tap_scopes_the_log_to_that_week ────────────');
  {
    await ev(stubBridge('log', '2026-07-13'));
    await ev(`drainWidgetTap()`); await sleep(500);

    ok('the bridge was actually consumed', await ev(`window.__consumed`) === 1);
    ok('it landed on the Log', await ev(`document.getElementById('screen-log').classList.contains('active')
        || document.getElementById('screen-log').style.display !== 'none'`));
    const rows = await ev(logRows);
    ok('only that week is listed — 2 of 8', rows.length === 2, rows);
    ok('and they are the RIGHT two (13th and 14th)',
       rows.join('|').includes('13') && rows.join('|').includes('14'), rows);
    ok('the banner names the week',
       (await ev(`document.getElementById('log-week-title').textContent`)).indexOf('Week of') === 0);
    ok('…and says where the scope came from',
       (await ev(`document.getElementById('log-week-sub').textContent`)).includes('home-screen widget'));
    ok('…and is visible', await ev(`document.getElementById('log-week-banner').style.display !== 'none'`));
  }

  console.log('\n── the way out ───────────────────────────────────────────────────');
  {
    await ev(`clearLogWeekFilter()`); await sleep(300);
    ok('"Show all" restores every day', (await ev(logRows)).length === 8);
    ok('…and hides the banner',
       await ev(`document.getElementById('log-week-banner').style.display === 'none'`));
  }

  console.log('\n── PIN: a plain card tap must not inherit a stale week ───────────');
  {
    // Scope it again, then arrive the way the WHOLE CARD arrives: screen only.
    await ev(stubBridge('log', '2026-07-20'));
    await ev(`drainWidgetTap()`); await sleep(400);
    ok('scoped again first', (await ev(logRows)).length === 2);

    await ev(stubBridge('log', null));
    await ev(`drainWidgetTap()`); await sleep(400);
    ok('PIN: a tap carrying no week clears the previous one',
       (await ev(logRows)).length === 8, await ev(logRows));
    ok('…and the banner goes with it',
       await ev(`document.getElementById('log-week-banner').style.display === 'none'`));
  }

  console.log('\n── a week with nothing in it says so ─────────────────────────────');
  {
    await ev(stubBridge('log', '2026-09-07'));   // a Monday with no seeded days
    await ev(`drainWidgetTap()`); await sleep(400);
    const txt = await ev(`document.getElementById('log-list').textContent`);
    ok('an empty week explains itself rather than showing a blank list',
       /Nothing confirmed that week/.test(txt), txt.slice(0, 80));
    ok('…and still offers the way out', /Show all days/.test(txt));
    // Never a fabricated zero: the Log must not imply the week was worked for $0.
    ok('…without inventing a $0.00 row', !/\$0\.00/.test(txt));
    await ev(`clearLogWeekFilter()`); await sleep(200);
  }

  console.log('\n── the filter is transient ───────────────────────────────────────');
  {
    await ev(stubBridge('log', '2026-07-06'));
    await ev(`drainWidgetTap()`); await sleep(400);
    ok('scoped', (await ev(logRows)).length === 2);
    // A reload is the cheapest proof it was never written anywhere persistent.
    await cmd('Page.navigate', { url: URL }); await sleep(1400);
    await ev(BOOT); await sleep(400);
    await ev(`showScreen('log')`); await sleep(300);
    ok('PIN: it does not survive a relaunch', (await ev(logRows)).length === 8);
    ok('…and nothing was persisted to localStorage',
       await ev(`Object.keys(localStorage).filter(function(k){return /week/i.test(k);}).length === 0`));
  }

  console.log('\n── no page errors ────────────────────────────────────────────────');
  {
    const real = pageErrors.filter(e => !/favicon|net::ERR|firebase|Failed to fetch|gstatic/i.test(e));
    ok('nothing threw during the run', real.length === 0, real.slice(0, 3));
  }

  console.log('\n' + '─'.repeat(66));
  console.log(fail === 0 ? `✓ ALL ${pass} PASSED` : `✗ ${fail} FAILED (${pass} passed)`);

  if (!process.env.KEEP) { try { ws.close(); } catch (_) {} chrome.kill(); srv.close(); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
