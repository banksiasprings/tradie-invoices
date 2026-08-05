#!/usr/bin/env node
/*
 * test-invoice-send-live.js — v109.0 in a real browser.
 *
 * test-invoice-send.js proves the pure decisions and scans the wiring. This
 * drives the REAL generateInvoice() / generatePDF() / resendInvoice() against a
 * stubbed Capacitor bridge that CAPTURES what EmailComposer.open() was actually
 * handed — which is the only way to prove the BCC reaches the plugin.
 *
 * That gap is not hypothetical. Deleting the one line that attaches
 * `openOpts.bcc` left all 127 pure assertions green, because they verified the
 * list was COMPUTED and never that it was SENT. This file is the answer to that
 * mutation, so the capture assertions here are the load-bearing ones.
 *
 * The PDF toolchain is stubbed rather than fetched from a CDN: the subject under
 * test is our send path, not html2canvas, and a network dependency would make a
 * money-path regression suite flaky.
 *
 * Run:  node test-invoice-send-live.js
 *       KEEP=1 node test-invoice-send-live.js   (leaves Chrome up)
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9491);
const HTTP_PORT = +(process.env.HTTP_PORT || 8839);
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

/* Two billable days at Lucas Ranch and one client with a real address, so a
   send has something to archive and somewhere to send it. */
const SEED = `(function(){
  localStorage.setItem('mcn_days', JSON.stringify([
    {id:'a1',date:'2026-08-03',site:'Lucas Ranch',start:'07:00',finish:'15:00',lunchMins:0,
     rate:60,sonWorking:false,sonHours:null,sonrate:30,machines:[],travelMode:'none',materials:[]},
    {id:'a2',date:'2026-08-04',site:'Lucas Ranch',start:'07:00',finish:'15:00',lunchMins:0,
     rate:60,sonWorking:false,sonHours:null,sonrate:30,machines:[],travelMode:'none',materials:[]}
  ]));
  localStorage.setItem('mcn_clients', JSON.stringify([
    {company:'Muirlawn Pty Ltd',contact:'Muirlawn',abn:'',address:'',email:'accounts@muirlawn.com.au',phone:'',isDefault:true}
  ]));
  var s=JSON.parse(localStorage.getItem('mcn_settings')||'{}');
  s.rate=60; s.incpct=7.8; s.invnum=45; s.name='Steven McNichol';
  s.bccEmail='smcnichol@outlook.com';
  localStorage.setItem('mcn_settings', JSON.stringify(s));
  localStorage.setItem('mcn_invoices', JSON.stringify([]));
  return 'seeded';
})()`;

const BOOT = `(function(){
  var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
  var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
  var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
  try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
  return 'ok';
})()`;

/* Installed AFTER boot: window.Capacitor is assigned by the type="module"
   scripts, which load asynchronously, so a stub placed during boot is silently
   clobbered a moment later (the harness note from the v105.0 work).
 *
 * The PDF toolchain is stubbed here too. generatePDF's real body still runs —
 * it builds the wrap div, calls html2canvas, paginates, writes to Filesystem
 * and calls EmailComposer — only the two CDN libraries are fakes. */
const stubBridge = `(function(){
  window.__sent = [];          // every EmailComposer.open() payload
  window.__shared = [];        // every Share.share() payload
  window.__mailto = [];        // every web mailto: URL

  window.loadScript = function(){ return Promise.resolve(); };
  window.html2canvas = function(){
    return Promise.resolve({ width: 820, height: 1000,
      toDataURL: function(){ return 'data:image/jpeg;base64,AAAA'; } });
  };
  window.jspdf = { jsPDF: function(){
    return { addPage: function(){}, addImage: function(){},
             output: function(kind){
               return kind === 'datauristring'
                 ? 'data:application/pdf;base64,QkJC'
                 : new Blob(['%PDF-1.4'], {type:'application/pdf'});
             } };
  }};

  window.Capacitor = window.Capacitor || {};
  window.Capacitor.isNativePlatform = function(){ return true; };
  window.Capacitor.Plugins = window.Capacitor.Plugins || {};
  window.Capacitor.Plugins.Filesystem = {
    writeFile: function(){ return Promise.resolve({uri:'file:///cache/inv.pdf'}); },
    getUri: function(){ return Promise.resolve({uri:'file:///cache/inv.pdf'}); }
  };
  window.Capacitor.Plugins.Share = {
    share: function(o){ window.__shared.push(o); return Promise.resolve(); }
  };
  window.Capacitor.Plugins.EmailComposer = {
    open: function(o){ window.__sent.push(JSON.parse(JSON.stringify(o))); return Promise.resolve(); }
  };
  // The pre-send "Send invoice #X?" confirm is not what is under test here.
  window.confirm = function(m){ window.__lastConfirm = m; return true; };
  window.__toasts = [];
  var _t = window.toast;
  window.toast = function(m){ window.__toasts.push(m); try{ _t(m); }catch(e){} };
  return true;
})()`;

const snapshot = `(function(){
  var s=JSON.parse(localStorage.getItem('mcn_settings')||'{}');
  var d=JSON.parse(localStorage.getItem('mcn_days')||'[]');
  var i=JSON.parse(localStorage.getItem('mcn_invoices')||'[]');
  return { rate:s.rate, invnum:s.invnum, invoiced:d.filter(function(x){return x.invoiced;}).length,
           days:d.length, invoices:i.length };
})()`;

(async () => {
  const srv = await serve();
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=/tmp/cr-send-' + process.pid, '--window-size=375,812', '--hide-scrollbars',
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
  let mid = 0; const pend = new Map();
  ws.on('message', m => {
    const j = JSON.parse(m);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
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

  /* index.html is ~700 KB and pulls Leaflet off the network, so a fixed sleep
     races the parse — the first run of this file failed with "initApp is not
     defined" purely on timing. Poll for the function instead. */
  const waitReady = async () => {
    for (let i = 0; i < 100; i++) {
      try { if (await ev(`typeof initApp === 'function'`)) return true; } catch (_) {}
      await sleep(200);
    }
    return false;
  };
  const reboot = async () => {
    await cmd('Page.navigate', { url: URL });
    if (!await waitReady()) { console.error('✗ app never finished loading'); process.exit(2); }
    const boot = await ev(BOOT); await sleep(500);
    if (boot !== 'ok') { console.error('✗ boot failed: ' + boot); process.exit(2); }
    await ev(stubBridge);
    await ev(`showScreen('invoice')`); await sleep(300);
  };

  await cmd('Page.navigate', { url: URL });
  await waitReady();
  await ev(`localStorage.clear()`);
  await ev(SEED);
  await reboot();

  // ── the fixture is capable of committing ──────────────────────────────────
  console.log('\n── CONTROL: the fixture can actually bill ────────────────────────');
  {
    const s = await ev(snapshot);
    ok('2 days seeded, none invoiced', s.days === 2 && s.invoiced === 0, s);
    ok('rate starts at $60', s.rate === 60, s.rate);
    ok('next invoice # is 45', s.invnum === 45, s.invnum);
    ok('no invoice records yet', s.invoices === 0, s.invoices);
    const sel = await ev(`_getSelectedInvoiceDays().length`);
    // Without this, every "nothing was archived" below could pass because there
    // was never a day selected to archive.
    ok('CONTROL: both days are selected for invoicing', sel === 2, sel);
  }

  // ── JOB 1: the BCC actually reaches the plugin ────────────────────────────
  console.log('\n── job 1: the BCC reaches EmailComposer ──────────────────────────');
  {
    await ev(`(function(){ generateInvoice(); return 'started'; })()`); await sleep(900);
    const sent = await ev(`window.__sent`);
    ok('the composer was opened exactly once', sent.length === 1, sent.length);
    const m = sent[0] || {};
    ok('PIN: bcc carries Steven’s address',
      JSON.stringify(m.bcc) === '["smcnichol@outlook.com"]', m.bcc);
    ok('to: is the client, not the BCC', JSON.stringify(m.to) === '["accounts@muirlawn.com.au"]', m.to);
    ok('the subject names the invoice', m.subject === 'Invoice #0045 from Steven McNichol', m.subject);
    ok('the body greets the client', /^Hi Muirlawn/.test(m.body || ''), (m.body || '').slice(0, 30));
    ok('the PDF is attached', !!(m.attachments && m.attachments[0] && /\.pdf$/.test(m.attachments[0].name)), m.attachments);
    ok('the attachment path is de-file://d for the native side',
      !!(m.attachments && m.attachments[0] && m.attachments[0].path.indexOf('file://') === -1), m.attachments);
  }

  // ── JOB 2: the send-confirm modal ─────────────────────────────────────────
  console.log('\n── job 2: handed off is not sent ─────────────────────────────────');
  {
    ok('the confirm modal is open, waiting on an answer',
      await ev(`document.getElementById('send-confirm-modal').classList.contains('open')`));
    ok('it names the invoice number',
      (await ev(`document.getElementById('send-confirm-q').textContent`)) === 'Did you send Invoice #0045?');
    ok('…and explains why it has to ask',
      (await ev(`document.getElementById('send-confirm-hint').textContent`)).includes('can’t tell the app'));
    const mid = await ev(snapshot);
    ok('PIN: NOTHING is committed while the question is open', mid.invoiced === 0 && mid.rate === 60 && mid.invnum === 45, mid);

    // Answer NO — the cancelled-compose case that used to bill anyway.
    await ev(`document.querySelector('#send-confirm-modal .btn-secondary').click()`); await sleep(600);
    const after = await ev(snapshot);
    ok('PIN: cancelling archives NO day', after.invoiced === 0, after.invoiced);
    ok('PIN: …leaves the rate at $60', after.rate === 60, after.rate);
    ok('PIN: …leaves the invoice number at 45', after.invnum === 45, after.invnum);
    ok('PIN: …writes NO invoice record', after.invoices === 0, after.invoices);
    ok('…and says so plainly',
      (await ev(`window.__toasts.join('|')`)).includes('Nothing archived'));
    ok('the modal closed', !(await ev(`document.getElementById('send-confirm-modal').classList.contains('open')`)));
    ok('the days are still billable', (await ev(`_getSelectedInvoiceDays().length`)) === 2);
    ok('…and no saved-invoice PDF was written either',
      (await ev(`InvoiceDB.list().then(function(r){return r.length;})`)) === 0);
  }

  // ── the same run, answered Yes ────────────────────────────────────────────
  console.log('\n── CONTROL: answering Yes DOES commit ────────────────────────────');
  {
    await ev(`window.__sent=[]`);
    await ev(`(function(){ generateInvoice(); return 'started'; })()`); await sleep(900);
    ok('the composer opened again', (await ev(`window.__sent.length`)) === 1);
    ok('…and the BCC is still attached on the second send',
      JSON.stringify((await ev(`window.__sent[0].bcc`))) === '["smcnichol@outlook.com"]');
    await ev(`document.querySelector('#send-confirm-modal .btn-primary').click()`); await sleep(1200);
    const s = await ev(snapshot);
    ok('CONTROL: both days archived', s.invoiced === 2, s.invoiced);
    ok('CONTROL: the rate rose', s.rate > 60, s.rate);
    ok('CONTROL: the invoice number advanced to 46', s.invnum === 46, s.invnum);
    ok('CONTROL: the invoice was recorded', s.invoices === 1, s.invoices);
    ok('CONTROL: the PDF was saved for re-download',
      (await ev(`InvoiceDB.list().then(function(r){return r.length;})`)) === 1);
  }

  // ── undo still works ──────────────────────────────────────────────────────
  console.log('\n── undoLastInvoice survives ──────────────────────────────────────');
  {
    const before = await ev(snapshot);
    await ev(`undoLastInvoice()`); await sleep(900);
    const s = await ev(snapshot);
    ok('the days come back', s.invoiced === 0, s.invoiced);
    ok('the rate is restored to $60', s.rate === 60, s.rate);
    ok('the invoice number goes back to 45', s.invnum === 45, s.invnum);
    ok('the record is removed', s.invoices === 0, s.invoices);
    ok('CONTROL: …and it really had something to undo', before.invoiced === 2 && before.invoices === 1, before);
  }

  // ── JOB 3: resend ─────────────────────────────────────────────────────────
  console.log('\n── job 3: resend commits nothing ─────────────────────────────────');
  {
    // Re-send needs a saved invoice to re-send, so bill one properly first.
    await ev(`window.__sent=[]`);
    await ev(`(function(){ generateInvoice(); return 'started'; })()`); await sleep(900);
    await ev(`document.querySelector('#send-confirm-modal .btn-primary').click()`); await sleep(1200);
    const before = await ev(snapshot);
    ok('CONTROL: an invoice exists to re-send', before.invoices === 1 && before.invoiced === 2, before);
    const savedHtml = await ev(`InvoiceDB.list().then(function(r){return r[0].html.length;})`);
    ok('CONTROL: …and its full HTML was saved', savedHtml > 200, savedHtml);

    await ev(`window.__sent=[]`);
    const id = await ev(`InvoiceDB.list().then(function(r){return r[0].id;})`);
    await ev(`resendInvoice(${id})`); await sleep(1200);

    const sent = await ev(`window.__sent`);
    ok('the composer opened for the re-send', sent.length === 1, sent.length);
    ok('…to the same client', JSON.stringify(sent[0] && sent[0].to) === '["accounts@muirlawn.com.au"]', sent[0] && sent[0].to);
    ok('PIN: …with the BCC still attached',
      JSON.stringify(sent[0] && sent[0].bcc) === '["smcnichol@outlook.com"]', sent[0] && sent[0].bcc);
    ok('…and the same invoice number', (sent[0] || {}).subject === 'Invoice #0045 from Steven McNichol', (sent[0] || {}).subject);
    ok('…and a PDF attached', !!(sent[0] && sent[0].attachments && sent[0].attachments.length));

    const after = await ev(snapshot);
    ok('PIN: the rate did NOT move', after.rate === before.rate, [before.rate, after.rate]);
    ok('PIN: the invoice number did NOT move', after.invnum === before.invnum, [before.invnum, after.invnum]);
    ok('PIN: no new invoice record', after.invoices === 1, after.invoices);
    ok('PIN: no additional day archived', after.invoiced === before.invoiced, [before.invoiced, after.invoiced]);
    ok('PIN: no second saved PDF',
      (await ev(`InvoiceDB.list().then(function(r){return r.length;})`)) === 1);
    ok('PIN: it never asked "did you send it" — nothing to gate',
      !(await ev(`document.getElementById('send-confirm-modal').classList.contains('open')`)));
    ok('…and says it does not count as a new invoice',
      (await ev(`window.__toasts.join('|')`)).includes('not counted as a new invoice'));
    ok('the confirm text warned before sending',
      (await ev(`window.__lastConfirm`)).includes('does not count as a new invoice'));
    ok('…and named the copy going to Steven',
      (await ev(`window.__lastConfirm`)).includes('smcnichol@outlook.com'));
  }

  // ── the Resend button is really on the list ───────────────────────────────
  console.log('\n── the button exists where he will look for it ───────────────────');
  {
    await ev(`showScreen('settings')`); await sleep(700);
    const btns = await ev(`(function(){
      var el=document.getElementById('settings-saved-invoices-list');
      return Array.prototype.slice.call(el.querySelectorAll('button')).map(function(b){return b.textContent.trim();});
    })()`);
    ok('the saved-invoice row offers Resend', (btns || []).some(b => /Resend/.test(b)), btns);
    ok('…alongside Open and delete', (btns || []).some(b => /Open/.test(b)), btns);
    ok('the list explains what Resend does',
      (await ev(`document.getElementById('settings-saved-invoices-list').textContent`)).includes('doesn’t count as a new invoice'));
  }

  // ── BCC off / self-addressed edge cases, driven through the real send ─────
  console.log('\n── the BCC can be turned off, and never doubles up ───────────────');
  {
    await ev(`(function(){var s=S(); s.bccEmail=''; DB.set('settings',s);})()`);
    await ev(`window.__sent=[]`);
    await ev(`(function(){var d=days(); d.forEach(function(x){x.invoiced=false;}); DB.set('days',d);})()`);
    await ev(`resetInvoiceDaySelection(); renderInvoice();`); await sleep(300);
    await ev(`(function(){ generateInvoice(); return 'started'; })()`); await sleep(900);
    let m = (await ev(`window.__sent[0]`)) || {};
    ok('blank BCC → the composer gets no bcc field at all', m.bcc === undefined, m.bcc);
    ok('…and the invoice still goes to the client', JSON.stringify(m.to) === '["accounts@muirlawn.com.au"]', m.to);
    await ev(`answerSendConfirm(false)`); await sleep(400);

    // BCC set to the client's own address — copying them to themselves is noise.
    await ev(`(function(){var s=S(); s.bccEmail='accounts@muirlawn.com.au'; DB.set('settings',s);})()`);
    await ev(`window.__sent=[]`);
    await ev(`(function(){ generateInvoice(); return 'started'; })()`); await sleep(900);
    m = (await ev(`window.__sent[0]`)) || {};
    ok('PIN: BCC equal to the recipient is dropped', m.bcc === undefined, m.bcc);
    await ev(`answerSendConfirm(false)`); await sleep(400);

    // A typo'd address must fail LOUDLY in the UI, not silently on send.
    await ev(`(function(){var s=S(); s.bccEmail='steve@localhost'; DB.set('settings',s);})()`);
    await ev(`window.__sent=[]`);
    await ev(`(function(){ generateInvoice(); return 'started'; })()`); await sleep(900);
    m = (await ev(`window.__sent[0]`)) || {};
    ok('a typo’d BCC is never sent to', m.bcc === undefined, m.bcc);
    await ev(`answerSendConfirm(false)`); await sleep(400);
    await ev(`showScreen('settings')`); await sleep(500);
    await ev(`loadSettings()`); await sleep(300);
    ok('…and the settings field says so',
      (await ev(`document.getElementById('s-bcc-warn').style.display`)) !== 'none');
    ok('CONTROL: a valid address shows no warning', await ev(`(function(){
      document.getElementById('s-bcc-email').value='smcnichol@outlook.com';
      refreshBccWarning();
      return document.getElementById('s-bcc-warn').style.display === 'none';
    })()`));
    ok('PIN: clearing the field really turns the BCC off', await ev(`(function(){
      document.getElementById('s-bcc-email').value='';
      saveSettings({silent:true});
      return (S().bccEmail || '') === '';
    })()`));
  }

  console.log('\n──────────────────────────────────────────────────────────────────');
  if (!process.env.KEEP) { try { chrome.kill(); } catch (_) {} }
  srv.close();
  if (fail) { console.log('✗ ' + fail + ' FAILED, ' + pass + ' passed'); process.exit(1); }
  console.log('✓ ALL ' + pass + ' PASSED');
  process.exit(0);
})();
