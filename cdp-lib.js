/*
 * cdp-lib.js — shared Chrome DevTools Protocol plumbing for the emulator tests.
 *
 * Finds the app's WebView devtools page (adb forward + /json/list) and evaluates
 * expressions inside the LIVE app, so tests exercise the real shipped code
 * rather than a re-implementation. Same technique the money-math tests use;
 * factored out here so test-triplog-live.js and cdp-eval.js share it.
 *
 * NOTE (from CLAUDE.md): CapacitorUpdater plugin calls invoked from a
 * CDP-injected eval never resolve. NativeGeo calls are fine.
 */
const { execSync } = require('child_process');
const http = require('http');

const PKG = 'com.banksiasprings.invoices';
const ADB = process.env.ADB || 'adb';
const PORT = process.env.CDP_PORT || 9338;

function sh(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_) { return ''; }
}

function requireWs() {
  const paths = [
    process.env.WS_NODE_PATH,
    '/usr/local/lib/node_modules/openclaw/node_modules',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules',
  ].filter(Boolean);
  try { return require('ws'); } catch (_) {}
  for (const p of paths) {
    try { return require(require('path').join(p, 'ws')); } catch (_) {}
  }
  throw new Error('the `ws` node module is required (set WS_NODE_PATH)');
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function connect() {
  const serial = sh(`${ADB} devices`).split('\n').slice(1)
    .map(l => l.trim().split(/\s+/))
    .filter(p => p[1] === 'device')
    .map(p => p[0])[0];
  if (!serial) throw new Error('no adb device');

  let pid = sh(`${ADB} -s ${serial} shell pidof ${PKG}`);
  if (!pid) throw new Error('app not running — launch it first');

  sh(`${ADB} -s ${serial} forward --remove tcp:${PORT}`);
  sh(`${ADB} -s ${serial} forward tcp:${PORT} localabstract:webview_devtools_remote_${pid}`);
  await new Promise(r => setTimeout(r, 1200));

  const list = await getJson(`http://localhost:${PORT}/json/list`);
  const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no devtools page for the app WebView');
  return { ws: page.webSocketDebuggerUrl, serial };
}

/** Evaluate an expression inside the app. Returns the value (awaits promises). */
function evalInApp(wsUrl, expression, timeoutMs = 15000) {
  const WebSocket = requireWs();
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { sock.close(); } catch (_) {} reject(new Error('CDP timeout')); }, timeoutMs);
    sock.on('open', () => sock.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    })));
    sock.on('message', d => {
      const m = JSON.parse(d);
      if (m.id !== 1) return;
      clearTimeout(t); sock.close();
      const r = m.result || {};
      if (r.exceptionDetails) return reject(new Error('app threw: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails)));
      if (r.result && r.result.value !== undefined) return resolve(r.result.value);
      resolve(null);
    });
    sock.on('error', e => { clearTimeout(t); reject(e); });
  });
}

module.exports = { connect, evalInApp, PKG, ADB, sh };
