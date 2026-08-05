#!/usr/bin/env node
/*
 * test-invoice-send.js — v109.0: BCC self · send-confirm · resend.
 *
 * Three field problems, all in the last ten seconds of an invoice:
 *
 *  1. Steven has no copy of what he sent. The plugin has always taken a bcc[];
 *     nothing ever asked him for the address.
 *  2. `EmailComposer.open()` resolves when the COMPOSER OPENS. Backing out of
 *     Gmail still archived the days and bumped the rate — a phantom invoice.
 *  3. Re-sending one meant generating it again, which bumped the rate a second
 *     time for the same work.
 *
 * The load-bearing assertions here are the NEGATIVE ones: that a cancelled send
 * commits nothing, and that a resend commits nothing. Each has a CONTROL beside
 * it proving the fixture could have committed — otherwise "nothing changed"
 * passes for a fixture that was never capable of changing anything, which is
 * the false-green family this project keeps finding.
 *
 * Run:  node test-invoice-send.js
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

const SEND = slice('//__V109_SEND_PURE_START__', '//__V109_SEND_PURE_END__');

/* Source scans must read CODE, not documentation — this block's comments state
   every rule it is checked against, so scanning raw text would make the comment
   explaining a rule the evidence that it was broken. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// ── purity ──────────────────────────────────────────────────────────────────
console.log('── purity ──────────────────────────────────────────────────────');
const P = code(SEND);
ok('no DOM access', !/document\.|window\./.test(P));
ok('no store access', !/\bDB\.|localStorage/.test(P));
ok('no argless Date/now', !/new Date\(\s*\)|Date\.now\(\)/.test(P));
ok('no S() settings read', !/[^a-zA-Z]S\(\)/.test(P));
ok('no Capacitor bridge in the pure block', !/Capacitor/.test(P));
ok('no toast/alert/confirm in the pure block', !/toast\(|alert\(|confirm\(/.test(P));
// Without this, the six checks above can pass on an empty stripper.
ok('…and the comment stripper is real', P.length < SEND.length && /function bccList/.test(P));

const ctx = {};
new Function('ctx', SEND + '\nObject.assign(ctx,{normaliseEmail,isEmailish,bccList,invoiceSubject,invoiceBody,mailtoUrl,sendNeedsConfirm,resendTarget,gmailFilterQuery});')(ctx);
const { normaliseEmail, isEmailish, bccList, invoiceSubject, invoiceBody, mailtoUrl, sendNeedsConfirm, resendTarget, gmailFilterQuery } = ctx;

// ── JOB 1: the BCC address ──────────────────────────────────────────────────
console.log('\n── job 1: BCC self ─────────────────────────────────────────────');

ok('trims whitespace', normaliseEmail('  a@b.com  ') === 'a@b.com');
ok('null/undefined → empty string', normaliseEmail(null) === '' && normaliseEmail(undefined) === '');

ok('accepts a normal address', isEmailish('smcnichol@outlook.com'));
ok('accepts a subdomain', isEmailish('steve@mail.banksiasprings.com.au'));
ok('accepts plus-addressing', isEmailish('steve+invoices@gmail.com'));
ok('rejects blank', !isEmailish('') && !isEmailish('   '));
ok('rejects no @', !isEmailish('smcnichol.outlook.com'));
ok('rejects two @', !isEmailish('a@b@c.com'));
ok('rejects a bare domain', !isEmailish('@outlook.com'));
ok('rejects no dot in the domain', !isEmailish('steve@localhost'));
ok('rejects a trailing dot', !isEmailish('steve@outlook.'));
ok('rejects embedded whitespace', !isEmailish('steve @outlook.com'));

ok('set → one BCC', JSON.stringify(bccList({ bccEmail: 'me@x.com' }, 'client@y.com')) === '["me@x.com"]');
ok('blank → no BCC', bccList({ bccEmail: '' }, 'client@y.com').length === 0);
ok('absent key → no BCC', bccList({}, 'client@y.com').length === 0);
ok('null settings → no BCC (never throws)', bccList(null, 'client@y.com').length === 0);
ok('PIN: a typo NEVER silently becomes a BCC', bccList({ bccEmail: 'me@localhost' }, 'c@y.com').length === 0);
ok('always an array, never null', Array.isArray(bccList({}, '')) && Array.isArray(bccList({ bccEmail: 'a@b.com' }, '')));
ok('BCC is trimmed on the way out', bccList({ bccEmail: '  me@x.com ' }, '')[0] === 'me@x.com');
ok('does not BCC the recipient themselves', bccList({ bccEmail: 'me@x.com' }, 'me@x.com').length === 0);
ok('…case-insensitively', bccList({ bccEmail: 'Me@X.com' }, 'me@x.COM').length === 0);
ok('…but a different client still gets the copy', bccList({ bccEmail: 'me@x.com' }, 'muirlawn@y.com').length === 1);

ok('mailto carries the bcc', mailtoUrl({ to: 'c@y.com', subject: 'S', body: 'B', bcc: ['me@x.com'] }).includes('bcc=me%40x.com'));
ok('mailto omits bcc entirely when none', !mailtoUrl({ to: 'c@y.com', subject: 'S', bcc: [] }).includes('bcc'));
ok('mailto keeps the recipient readable', mailtoUrl({ to: 'c@y.com', subject: 'S' }).startsWith('mailto:c@y.com?'));
ok('mailto encodes the subject', mailtoUrl({ to: 'a@b.com', subject: 'Invoice #0045 from Steve' }).includes('subject=Invoice%20%230045%20from%20Steve'));
ok('mailto with nothing to say has no query', mailtoUrl({ to: 'a@b.com' }) === 'mailto:a@b.com');
ok('mailto drops empty bcc entries', !mailtoUrl({ to: 'a@b.com', bcc: ['', null] }).includes('bcc'));

/* Computing the right list proves nothing if it never reaches the plugin.
   Found by mutation: deleting the line that attaches openOpts.bcc left every
   other assertion in this file green. The live suite drives the real call; these
   are the cheap guards that fail without a browser. */
const _gp = html.slice(html.indexOf('async function generatePDF'), html.indexOf('async function generateInvoice'));
ok('PIN: generatePDF resolves the BCC itself — the one wiring point', /bccList\(S\(\)/.test(_gp));
ok('PIN: …and attaches it to the composer options', /openOpts\.bcc = _bcc/.test(_gp));
ok('PIN: …and hands it to the mailto builder', /mailtoUrl\(\{[^}]*bcc: _bcc/.test(_gp));
ok('an explicit emailOpts.bcc can still override it', /emailOpts\.bcc\) \|\| bccList/.test(_gp));
ok('…and the composer is really the thing receiving it', /EmailComposer\.open\(openOpts\)/.test(_gp));

ok('PIN: the Gmail filter is the one in the help text', gmailFilterQuery() === 'from:me AND has:attachment AND subject:"Invoice"');
ok('…and the settings card shows exactly that string',
  html.includes('from:me AND has:attachment AND subject:&quot;Invoice&quot;') ||
  html.includes('from:me AND has:attachment AND subject:"Invoice"'));
ok('…and names the label + skip-inbox actions',
  /Sent Invoices/.test(html) && /Skip the Inbox/i.test(html));

// ── the email text, now written once ────────────────────────────────────────
console.log('\n── one copy of the email text ──────────────────────────────────');
ok('subject names the invoice', invoiceSubject('0045', 'Steven') === 'Invoice #0045 from Steven');
ok('subject survives a missing number', invoiceSubject('', 'Steven') === 'Invoice from Steven');
ok('subject survives a missing sender', invoiceSubject('0045', '') === 'Invoice #0045');
ok('body greets the client', invoiceBody('0045', 'Muirlawn Pty Ltd', 'Steven').startsWith('Hi Muirlawn Pty Ltd,'));
ok('body falls back to "there"', invoiceBody('0045', '', 'Steven').startsWith('Hi there,'));
ok('body signs off with the sender', invoiceBody('0045', 'X', 'Steven').trim().endsWith('Steven'));
ok('body falls back to "me"', invoiceBody('0045', 'X', '').trim().endsWith('me'));
/* Three call sites (composer, mailto, resend) built this string separately
   before v109; a reworded email would have gone out looking like two invoices. */
const genPdf = html.slice(html.indexOf('async function generatePDF'), html.indexOf('async function generateInvoice'));
ok('PIN: generatePDF builds the subject once, from the shared helper',
  (genPdf.match(/invoiceSubject\(/g) || []).length === 1);
ok('…and the body once', (genPdf.match(/invoiceBody\(/g) || []).length === 1);
ok('…and no longer hand-concatenates "Please find Invoice"',
  !/Please find Invoice/.test(code(genPdf)));

// ── JOB 2: handed off is not sent ───────────────────────────────────────────
console.log('\n── job 2: the compose-cancel bug ───────────────────────────────');

ok('the email composer needs confirming', sendNeedsConfirm('email') === true);
ok('the share sheet needs confirming', sendNeedsConfirm('share') === true);
ok('mailto needs confirming', sendNeedsConfirm('mailto') === true);
ok('a plain download needs confirming', sendNeedsConfirm('download') === true);
ok('the HTML fallback needs confirming', sendNeedsConfirm('html') === true);
ok('only a channel that reports back is exempt', sendNeedsConfirm('api') === false);

/* Replay of the actual bug: the composer opened, Steven backed out, and the
   pre-v109 code committed anyway because open() had resolved. */
function commitSim({ delivered, channel, answer }) {
  const state = { days: [{ id: 'd1', invoiced: false }], rate: 60, invnum: 45, invoices: [] };
  if (!delivered) return state;
  if (sendNeedsConfirm(channel) && !answer) return state;          // the v109 gate
  state.days[0].invoiced = true;
  state.rate = 64.65;
  state.invnum = 46;
  state.invoices.push({ num: 45 });
  return state;
}
const cancelled = commitSim({ delivered: true, channel: 'email', answer: false });
ok('PIN: cancelling the compose archives NO day', cancelled.days[0].invoiced === false);
ok('PIN: …bumps NO rate', cancelled.rate === 60);
ok('PIN: …bumps NO invoice number', cancelled.invnum === 45);
ok('PIN: …records NO invoice', cancelled.invoices.length === 0);
/* CONTROL — without this, all four above pass on a fixture that never commits. */
const sent = commitSim({ delivered: true, channel: 'email', answer: true });
ok('CONTROL: answering Yes DOES archive the day', sent.days[0].invoiced === true);
ok('CONTROL: …does raise the rate', sent.rate === 64.65);
ok('CONTROL: …does bump the number', sent.invnum === 46);
ok('CONTROL: …does record the invoice', sent.invoices.length === 1);
const failed = commitSim({ delivered: false, channel: null, answer: true });
ok('a failed PDF still commits nothing, Yes or not', failed.days[0].invoiced === false && failed.rate === 60);

// wiring: the gate must sit between delivery and the side effects
const genInv = html.slice(html.indexOf('async function generateInvoice'), html.indexOf('async function undoLastInvoice'));
ok('generateInvoice awaits the confirm', /await confirmInvoiceSent\(/.test(genInv));
ok('…gated on sendNeedsConfirm', /sendNeedsConfirm\(res\.channel\)/.test(genInv));
ok('…and returns early when the answer is No', /if\(!sent\)\{[\s\S]{0,120}return;/.test(genInv));
const gateAt = genInv.indexOf('confirmInvoiceSent');
ok('PIN: the confirm runs BEFORE the day archive', gateAt > 0 && gateAt < genInv.indexOf("DB.set('days',ad)"));
ok('PIN: …BEFORE the rate is written', gateAt < genInv.indexOf("DB.set('settings',s)"));
ok('PIN: …BEFORE the invoice record is pushed', gateAt < genInv.indexOf("DB.set('invoices',il)"));
ok('PIN: …and BEFORE the saved-PDF write', gateAt < genInv.indexOf('InvoiceDB.save'));
ok('delivery is read as res.delivered, not a bare truthy object', /!res\|\|!res\.delivered/.test(code(genInv)));

/* generatePDF's honesty: it must never again return a bare `true` that reads as
   "the client got it". Every exit is a channel-tagged object. */
ok('generatePDF returns a channel on the composer path', /channel: 'email'/.test(genPdf));
ok('…on the share path', /channel: 'share'/.test(genPdf));
ok('…on the mailto path', /channel: 'mailto'/.test(genPdf));
ok('…on the download path', /channel: 'download'/.test(genPdf));
ok('…on the HTML fallback', /channel: 'html'/.test(genPdf));
ok('…and delivered:false when nothing went out', /delivered: false/.test(genPdf));
ok('PIN: no bare `return true` survives in generatePDF', !/return true;/.test(code(genPdf)));

// the modal itself
ok('the confirm modal exists in the DOM', /id="send-confirm-modal"/.test(html));
ok('…with a Yes and a No', /answerSendConfirm\(true\)/.test(html) && /answerSendConfirm\(false\)/.test(html));
ok('PIN: dismissing (✕) answers NO, never Yes',
  /class="modal-close" onclick="answerSendConfirm\(false\)"/.test(html));
ok('the question names the invoice number', /Did you send Invoice #/.test(html));
ok('the modal says what Yes costs', /marks the days invoiced and raises your rate/i.test(html));
ok('a missing modal falls back to confirm() rather than committing',
  /if\(!bg\)\{[\s\S]{0,400}confirm\(/.test(html));
ok('PIN: undoLastInvoice survives untouched', /async function undoLastInvoice\(\)/.test(html) && /window\.undoLastInvoice=undoLastInvoice/.test(html));
ok('…and is still reachable from the Invoice screen', /onclick="undoLastInvoice\(\)"/.test(html));

// ── JOB 3: resend ───────────────────────────────────────────────────────────
console.log('\n── job 3: resend ───────────────────────────────────────────────');

const rec = {
  id: 7,
  filename: 'Invoice #0045 — Muirlawn Pty Ltd — 2026-08-05.html',
  clientName: 'Muirlawn Pty Ltd',
  html: '<html>…</html>',
  rawData: { invoiceNum: 45, client: { company: 'Muirlawn Pty Ltd', email: 'accounts@muirlawn.com.au' }, rate: 60 }
};
let t = resendTarget(rec, []);
ok('recipient comes from the invoice’s own saved client', t.to === 'accounts@muirlawn.com.au');
ok('client name comes with it', t.clientName === 'Muirlawn Pty Ltd');
ok('invoice number is padded to match the filename', t.invoiceNum === '0045');

/* The v101.8 ghost-site bug, in the invoice path: sites and invoices both point
   at a client by NAME, so renaming one used to lose the address of an invoice
   already sent. rawData is the record's own copy — immune. */
t = resendTarget(rec, [{ company: 'Muirlawn Holdings', email: 'new@elsewhere.com' }]);
ok('PIN: renaming the client does not lose a sent invoice’s address', t.to === 'accounts@muirlawn.com.au');
t = resendTarget(rec, null);
ok('…and deleting the client entirely does not either', t.to === 'accounts@muirlawn.com.au');

const legacy = { id: 3, filename: 'Invoice #0031 — Muirlawn Pty Ltd — 2026-01-02.html', clientName: 'Muirlawn Pty Ltd' };
t = resendTarget(legacy, [{ company: 'Muirlawn Pty Ltd', email: 'accounts@muirlawn.com.au' }]);
ok('a pre-rawData record still resolves by name', t.to === 'accounts@muirlawn.com.au');
ok('…and recovers its number from the filename', t.invoiceNum === '0031');
t = resendTarget(legacy, []);
ok('no address anywhere → empty, never a bad address', t.to === '');
ok('…and the name is still carried for the UI', t.clientName === 'Muirlawn Pty Ltd');
ok('a junk record never throws', resendTarget(null, null).to === '' && resendTarget({}, []).invoiceNum === '');
ok('a saved-but-invalid address is rejected, not passed on',
  resendTarget({ rawData: { client: { email: 'nope@localhost' } } }, []).to === '');
ok('resend gets the same BCC as a first send', bccList({ bccEmail: 'me@x.com' }, resendTarget(rec, []).to).length === 1);

const resend = html.slice(html.indexOf('function resendInvoice'), html.indexOf('window.resendInvoice'));
ok('PIN: resend archives no day', !/invoiced\s*=\s*true/.test(resend) && !/DB\.set\('days'/.test(resend));
ok('PIN: resend bumps no rate', !/s\.rate\s*=/.test(resend));
ok('PIN: resend bumps no invoice number', !/s\.invnum\s*=/.test(resend));
ok('PIN: resend writes no new invoice record', !/InvoiceDB\.save|DB\.set\('invoices'/.test(resend));
ok('PIN: resend never asks "did you send it" — it gates nothing', !/confirmInvoiceSent/.test(resend));
/* CONTROL — the five above must be measuring a real function, not an empty slice. */
ok('CONTROL: …and resendInvoice really does rebuild + send the PDF',
  resend.length > 400 && /generatePDF\(r\.html/.test(resend) && /resendTarget\(/.test(resend));
ok('resend reuses the saved HTML, never rebuilds from live days', !/buildInvoiceHTML/.test(resend));
ok('resend passes the BCC through', /bccList\(/.test(resend));
ok('resend tells the user it is not a new invoice', /does not count as a new invoice/.test(resend));
ok('the list row offers Resend', /onclick="resendInvoice\(\$\{r\.id\}\)"/.test(html));
ok('…with the wording Steven asked for', /Re-sends the same PDF/.test(html));
ok('…and the list explains it once, in plain sight', /doesn’t count as a new invoice/.test(html));
ok('no address → offers the share sheet instead of failing', /Open the share sheet with the PDF instead/.test(resend));

/* Repo hygiene: the superseded exporter is DELETED, not left beside the new
   one. Two near-identical send paths is how they drift. */
ok('PIN: exportSavedInvoice is gone, not left alongside', !/function exportSavedInvoice/.test(html));
ok('…and nothing still calls it', !/exportSavedInvoice\(/.test(code(html)));
ok('…the viewer button now resends', /onclick="exportFromViewer\(\)"[^>]*>↻ Resend/.test(html));

// ── settings plumbing ───────────────────────────────────────────────────────
console.log('\n── settings plumbing ───────────────────────────────────────────');
ok('bccEmail has a default', /bccEmail:''/.test(html.replace(/\s/g, '')));
ok('the field exists', /id="s-bcc-email"/.test(html));
ok('…is an s- field, so v105.0 auto-save covers it with no new wiring', /id="s-bcc-email"/.test(html) && /t\.id\.indexOf\('s-'\)!==0/.test(html));
const saveFn = html.slice(html.indexOf('function saveSettings(opts)'), html.indexOf('function saveSettings(opts)') + 4000);
ok('PIN: clearing the box actually turns the BCC off', /s\.bccEmail=normaliseEmail\(_bccEl\.value\)/.test(saveFn));
ok('…i.e. it is NOT written with the `||keep-old` pattern the other fields use',
  !/s\.bccEmail=[^;]*\|\|s\.bccEmail/.test(saveFn));
/* CONTROL: prove that pattern is really the house style, so the check above is
   asserting a deliberate difference and not a coincidence. */
ok('CONTROL: …which the neighbouring email field does use', /s\.email=document\.getElementById\('s-email'\)\.value\|\|s\.email/.test(saveFn));
ok('a typo warns in place instead of failing silently', /id="s-bcc-warn"/.test(html) && /function refreshBccWarning/.test(html));
ok('the address is loaded back into the field', /_bcc\.value=s\.bccEmail\|\|''/.test(html));
ok('bccEmail rides the settings blob → synced + in the backup, no new key', !/mcn_bcc/.test(html));

// ── version ─────────────────────────────────────────────────────────────────
console.log('\n── version ─────────────────────────────────────────────────────');
const ver = (html.match(/const APP_VERSION = '(v[\d.]+)'/) || [])[1];
ok('APP_VERSION is v109.0', ver === 'v109.0', ver);
const cap = JSON.parse(fs.readFileSync(path.join(__dirname, 'capacitor.config.json'), 'utf8'));
ok('Capgo builtin matches (the v82 cache trap)', cap.plugins.CapacitorUpdater.version === '1.109.0', cap.plugins.CapacitorUpdater.version);
const gradle = fs.readFileSync(path.join(__dirname, 'android', 'app', 'build.gradle'), 'utf8');
ok('versionCode is 21', /versionCode 21/.test(gradle));
ok('versionName is 1.109.0', /versionName "1\.109\.0"/.test(gradle));

console.log('\n──────────────────────────────────────────────────────────────────');
if (fail) { console.log('✗ ' + fail + ' FAILED, ' + pass + ' passed'); process.exit(1); }
console.log('✓ ALL ' + pass + ' PASSED');
