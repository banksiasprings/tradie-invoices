#!/usr/bin/env node
/* shots-v109.js — evidence images for v109.0 (BCC · send-confirm · resend).
   Same CDP harness the live suites use; writes PNGs to plans/v109-shots/. */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9494);
const HTTP_PORT = +(process.env.HTTP_PORT || 8843);
const WWW = path.join(__dirname, 'www');
const OUT = path.join(__dirname, 'plans', 'v109-shots');
fs.mkdirSync(OUT, { recursive: true });

function requireWs() {
  const p = [process.env.WS_NODE_PATH, '/usr/local/lib/node_modules/openclaw/node_modules',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules'].filter(Boolean);
  try { return require('ws'); } catch (_) {}
  for (const q of p) { try { return require(path.join(q, 'ws')); } catch (_) {} }
  throw new Error('need ws');
}
const WS = requireWs();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

(async () => {
  const srv = http.createServer((req, rq) => {
    const p = path.join(WWW, decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(p, (e, d) => {
      if (e) { rq.writeHead(404); rq.end(''); return; }
      rq.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      rq.end(d);
    });
  });
  await new Promise(r => srv.listen(HTTP_PORT, r));

  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=/tmp/cr-shot-' + process.pid, '--window-size=375,812', '--hide-scrollbars',
    '--force-device-scale-factor=2', '--no-first-run', 'about:blank'], { stdio: 'ignore' });

  const getJson = p => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
  let tabs = null;
  for (let i = 0; i < 80; i++) { try { tabs = await getJson('/json/list'); if (tabs.length) break; } catch (_) {} await sleep(200); }
  const page = tabs.find(t => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));
  let mid = 0; const pend = new Map();
  ws.on('message', m => { const j = JSON.parse(m); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } });
  const cmd = (m, p) => new Promise(res => { const i = ++mid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const ev = async e => { const r = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result && r.result.result.value; };
  /* Firebase's onAuthStateChanged lands asynchronously and re-shows the login
     screen over the app — the first run of this script captured it three times
     and produced three byte-identical PNGs. Re-hide immediately before each
     capture, and refuse to write a shot that is still showing login. */
  const shot = async name => {
    await ev(`(function(){
      document.getElementById('screen-login').style.display='none';
      document.getElementById('screen-loading').style.display='none';
      document.getElementById('main-app-wrapper').style.display='block';
    })()`);
    await sleep(250);
    if (await ev(`getComputedStyle(document.getElementById('screen-login')).display !== 'none'`)) {
      console.error('  ✗ ' + name + ': login screen still up — refusing to write it');
      process.exitCode = 1; return;
    }
    const r = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
    console.log('  wrote ' + name + '.png');
  };

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  const URL = 'http://127.0.0.1:' + HTTP_PORT + '/index.html';

  await cmd('Page.navigate', { url: URL });
  for (let i = 0; i < 100; i++) { if (await ev(`typeof initApp === 'function'`)) break; await sleep(200); }
  await ev(`(function(){
    localStorage.setItem('mcn_settings', JSON.stringify({rate:60,incpct:7.8,invnum:45,
      name:'Steven McNichol', bccEmail:'smcnichol@outlook.com', client:'Muirlawn Pty Ltd'}));
    localStorage.setItem('mcn_clients', JSON.stringify([{company:'Muirlawn Pty Ltd',contact:'Muirlawn',
      email:'accounts@muirlawn.com.au',isDefault:true}]));
    localStorage.setItem('mcn_days', JSON.stringify([
      {id:'a1',date:'2026-08-03',site:'Lucas Ranch',start:'07:00',finish:'15:00',lunchMins:0,rate:60,
       sonWorking:false,machines:[],travelMode:'none',materials:[]},
      {id:'a2',date:'2026-08-04',site:'Lucas Ranch',start:'07:00',finish:'15:00',lunchMins:0,rate:60,
       sonWorking:false,machines:[],travelMode:'none',materials:[]}]));
  })()`);
  await cmd('Page.navigate', { url: URL });
  for (let i = 0; i < 100; i++) { if (await ev(`typeof initApp === 'function'`)) break; await sleep(200); }
  await ev(`(function(){
    document.getElementById('screen-login').style.display='none';
    document.getElementById('screen-loading').style.display='none';
    document.getElementById('main-app-wrapper').style.display='block';
    initApp();
  })()`);
  await sleep(900);

  console.log('v109 shots →', OUT);

  // 1 — the BCC settings field + Gmail filter help
  await ev(`showScreen('settings')`); await sleep(600);
  await ev(`(function(){
    var c=document.getElementById('s-bcc-email').closest('.card');
    c.classList.remove('collapsed');
    var b=c.querySelector('.card-body'); if(b) b.style.display='';
    var r=document.getElementById('s-bcc-email').getBoundingClientRect();
    window.scrollTo(0, window.scrollY + r.top - 90);
  })()`); await sleep(500);
  await shot('01-bcc-settings-field');

  // 2 — the typo warning
  await ev(`(function(){
    var f=document.getElementById('s-bcc-email'); f.value='steve@localhost'; refreshBccWarning();
    var r=f.getBoundingClientRect(); window.scrollTo(0, window.scrollY + r.top - 90);
  })()`); await sleep(400);
  await shot('02-bcc-typo-warning');
  await ev(`(function(){var f=document.getElementById('s-bcc-email'); f.value='smcnichol@outlook.com'; refreshBccWarning(); saveSettings({silent:true});})()`);

  // 3 — the send-confirm modal, mid-send
  await ev(`(function(){
    window.Capacitor={isNativePlatform:function(){return true;},Plugins:{
      Filesystem:{writeFile:function(){return Promise.resolve({});},getUri:function(){return Promise.resolve({uri:'file:///c/i.pdf'});}},
      Share:{share:function(){return Promise.resolve();}},
      EmailComposer:{open:function(){return Promise.resolve();}}}};
    window.loadScript=function(){return Promise.resolve();};
    window.html2canvas=function(){return Promise.resolve({width:820,height:1000,toDataURL:function(){return 'data:image/jpeg;base64,AAAA';}});};
    window.jspdf={jsPDF:function(){return {addPage:function(){},addImage:function(){},
      output:function(k){return k==='datauristring'?'data:application/pdf;base64,QkJC':new Blob(['x']);}};}};
    window.confirm=function(){return true;};
  })()`);
  await ev(`showScreen('invoice')`); await sleep(500);
  await ev(`(function(){ generateInvoice(); return 1; })()`); await sleep(1400);
  await shot('03-send-confirm-modal');

  // 4 — answered No: the days are still there
  await ev(`answerSendConfirm(false)`); await sleep(800);
  await ev(`window.scrollTo(0,0)`); await sleep(300);
  await shot('04-cancelled-nothing-archived');

  // 5 — Saved Invoices with the Resend button
  await ev(`(function(){ generateInvoice(); return 1; })()`); await sleep(1400);
  await ev(`answerSendConfirm(true)`); await sleep(1600);
  await ev(`showScreen('settings')`); await sleep(900);
  await ev(`(function(){
    var el=document.getElementById('settings-saved-invoices-list');
    var c=el.closest('.card'); if(c){ c.classList.remove('collapsed'); var b=c.querySelector('.card-body'); if(b) b.style.display=''; }
    var r=el.getBoundingClientRect(); window.scrollTo(0, window.scrollY + r.top - 120);
  })()`); await sleep(600);
  await shot('05-resend-button-on-list');

  chrome.kill(); srv.close();
  console.log('done');
  process.exit(0);
})();
