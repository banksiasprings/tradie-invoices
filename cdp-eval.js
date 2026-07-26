#!/usr/bin/env node
/* cdp-eval.js — evaluate one expression inside the live app. Debug/test helper.
 * Usage: node cdp-eval.js "<javascript expression>"                          */
const { connect, evalInApp } = require('./cdp-lib');
(async () => {
  const expr = process.argv[2];
  if (!expr) { console.error('usage: node cdp-eval.js "<expression>"'); process.exit(2); }
  const { ws } = await connect();
  const v = await evalInApp(ws, expr);
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
