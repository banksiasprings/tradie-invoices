#!/usr/bin/env node
/*
 * test-earthmoving-mode-live.js — v101.9 single-user earthmoving mode, driven
 * against the REAL shipped app in a real browser (headless Chrome + CDP).
 *
 * The pure tests prove the rules. These prove the WIRING: that the cards are
 * actually hidden in the DOM with the flag on, that the hidden dev section
 * appears after five taps on the version number, and — the requirement that
 * matters most — that turning the flag OFF genuinely restores the full config
 * surface. Nothing is deleted, so this must be reversible in both directions.
 *
 * Run:  node test-earthmoving-mode-live.js
 *       KEEP=1 node test-earthmoving-mode-live.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9463);
const HTTP_PORT = +(process.env.HTTP_PORT || 8803);
const WWW = path.join(__dirname, 'www');

function requireWs() {
  const paths = [
    process.env.WS_NODE_PATH,
    '/usr/local/lib/node_modules/openclaw/node_modules',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules',
  ].filter(Boolean);
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

const SEED = `(function(){
  localStorage.setItem('mcn_settings',JSON.stringify({rate:60,tradeType:'earthmoving',namePlaces:false}));
  localStorage.setItem('mcn_vehicles',JSON.stringify([{id:'v1',name:'City',cents_per_km:0.88,is_default:true}]));
  localStorage.setItem('mcn_trips',JSON.stringify([]));
  localStorage.setItem('mcn_clients',JSON.stringify([{company:'Muirlawn Pty Ltd',isDefault:true}]));
  localStorage.setItem('mcn_sites',JSON.stringify([]));
  return 'seeded';
})()`;

const BOOT = `(function(){
  var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
  var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
  var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
  window.CloudSync={pushAll:function(){return Promise.resolve();},syncKey:function(){return Promise.resolve();},
                    fetchTeam:function(){return Promise.resolve([]);}};
  try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
  showScreen('settings',document.querySelector('.nav-btn[onclick*="settings"]'));
  return 'ok';
})()`;

const shown = id => `(function(){var e=document.getElementById('${id}');
  return !!e && e.offsetParent!==null && e.style.display!=='none';})()`;

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

(async () => {
  const srv = await serve();
  const prof = '/tmp/cr-em-test-' + process.pid;
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + prof,
    '--window-size=375,812', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

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
  let mid = 0; const pend = new Map();
  ws.on('message', m => { const j = JSON.parse(m); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } });
  const cmd = (method, params) => new Promise(res => { const i = ++mid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const d = r.result;
    if (d && d.exceptionDetails) throw new Error('page threw: ' + JSON.stringify((d.exceptionDetails.exception && d.exceptionDetails.exception.description) || d.exceptionDetails.text));
    return d && d.result && d.result.value;
  };

  const pageErrors = [];
  ws.on('message', m => {
    const j = JSON.parse(m);
    if (j.method === 'Runtime.exceptionThrown') {
      pageErrors.push((j.params.exceptionDetails.exception && j.params.exceptionDetails.exception.description) || j.params.exceptionDetails.text);
    }
  });

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

  const URL = 'http://127.0.0.1:' + HTTP_PORT + '/index.html';
  await cmd('Page.navigate', { url: URL });
  await sleep(1400);
  await ev(SEED);
  await cmd('Page.navigate', { url: URL + '?cb=' + Date.now() });
  await sleep(2200);

  console.log('Boot');
  ok('app shell boots', await ev(BOOT) === 'ok');
  await sleep(600);

  console.log('\nFlag ON by default — the simplified surface');
  ok('mode defaults ON with no saved setting', await ev('isEarthmovingModeOn(S())') === true);
  ok('Trade / Industry card is hidden', await ev(shown('trade-selector-card')) === false);
  ok('Team / Business Code card is hidden', await ev(shown('team-settings-card')) === false);
  ok('Employee details card is hidden', await ev(shown('employee-settings-card')) === false);
  ok('“+ Add vehicle” is hidden (he has one)', await ev(shown('vehicles-add-btn')) === false);
  ok('the dev section is NOT visible by default', await ev(shown('dev-mode-card')) === false);

  console.log('\n…while everything he actually uses stays');
  ok('Business details card still shown', await ev(shown('business-settings-card')) === true);
  ok('Clients & Sites still shown', await ev(`!!document.getElementById('clients-sites-list')`) === true);
  ok('Vehicles & Trip Log card still shown (it holds the cents/km rate)',
     await ev(shown('vehicles-card')) === true);
  ok('Tax exports still shown', await ev(shown('tax-exports-card')) === true);
  ok('ATO logbook still shown', await ev(shown('logbook-card')) === true);
  ok('Setup Health still shown', await ev(`!!document.getElementById('health-check-list')`) === true);
  ok('his machine library is untouched', await ev(`getMachinesLib().length > 0`));

  console.log('\nThe hidden dev section');
  ok('four taps is not enough', await ev(`(function(){for(var i=0;i<4;i++)devTapVersion();
    var e=document.getElementById('dev-mode-card');return e.style.display;})()`) === 'none');
  ok('the fifth tap reveals it', await ev(`(function(){devTapVersion();
    var e=document.getElementById('dev-mode-card');return e.style.display;})()`) === 'block');
  ok('…and the toggle reflects the current state',
     await ev(`document.getElementById('s-earthmoving-mode').checked`) === true);

  console.log('\nFlag OFF — the full config surface returns');
  await ev(`(function(){document.getElementById('s-earthmoving-mode').checked=false;
    saveEarthmovingModePref();})()`);
  await sleep(300);
  ok('the setting persisted', await ev(`S().earthmovingMode`) === false);
  ok('Trade / Industry card is back', await ev(shown('trade-selector-card')) === true);
  ok('…and is populated with every trade', await ev(`document.querySelectorAll('#trade-selector-grid .trade-btn').length`) > 1,
     await ev(`document.querySelectorAll('#trade-selector-grid .trade-btn').length`));
  ok('Team card is back', await ev(shown('team-settings-card')) === true);
  ok('“+ Add vehicle” is back', await ev(shown('vehicles-add-btn')) === true);

  console.log('\nBack ON — reversible, and nothing was lost');
  await ev(`(function(){document.getElementById('s-earthmoving-mode').checked=true;
    saveEarthmovingModePref();})()`);
  await sleep(300);
  ok('the setting persisted', await ev(`S().earthmovingMode`) === true);
  ok('Trade / Industry hidden again', await ev(shown('trade-selector-card')) === false);
  ok('Team card hidden again', await ev(shown('team-settings-card')) === false);
  ok('trade type was never mutated by the toggle', await ev(`S().tradeType`) === 'earthmoving');
  ok('the vehicle survived the full cycle', await ev('vehicles().length') === 1);
  ok('…with its cents/km rate intact', await ev('vehicles()[0].cents_per_km') === 0.88);
  ok('machines survived the full cycle', await ev(`getMachinesLib().length > 0`));
  ok('clients survived the full cycle', await ev('clientsData().length') === 1);

  console.log('\nEmployee mode is not trapped');
  await ev(`(function(){var s=S();s.tradeType='employee';s.earthmovingMode=true;DB.set('settings',s);
    applyTradeVisibility();renderTradeSelector();})()`);
  await sleep(200);
  ok('an employee keeps the trade selector (the only way back out)',
     await ev(shown('trade-selector-card')) === true);
  ok('…and sees their own settings card', await ev(shown('employee-settings-card')) === true);
  await ev(`(function(){var s=S();s.tradeType='earthmoving';DB.set('settings',s);applyTradeVisibility();})()`);

  ok('no uncaught page errors across the whole run', pageErrors.length === 0, pageErrors);

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
  if (!process.env.KEEP) { try { chrome.kill(); } catch (_) {} srv.close(); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); process.exit(2); });
