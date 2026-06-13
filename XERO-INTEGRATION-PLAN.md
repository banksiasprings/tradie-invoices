# Xero Integration — Feasibility & Plan (2026-06-14)

**Verdict: feasible, and a well-trodden path — but NOT pure client-side. It needs a thin
backend, and a Firebase Cloud Function is exactly the right one.** For a single-trader,
single-org tool this is ~2–4 focused days, not a project. **No code built yet — this is the
decision record + plan. Proceed only when Steven says go** (it requires a Firebase Blaze upgrade
+ a Xero developer app, both his calls).

## Why a backend is unavoidable (three hard constraints)
1. **Xero forbids custom URL schemes as redirect URIs** — only `https://` (or `localhost`). A
   Capacitor deep-link (`com.app://callback`) is rejected at app registration. The OAuth redirect
   must land on an HTTPS endpoint you control → a server function.
2. **Refresh tokens are single-use and rotate on every refresh** (and expire 30 min after use). Two
   concurrent refreshes = one wins, the other is permanently dead (`invalid_grant`). A phone WebView
   is the worst place to own a rotating secret (clear app data → gone; run twice → self-destructs).
   Tokens must live in ONE authoritative store with serialized refresh.
3. **PKCE removes the client secret but not the storage risk** — the refresh token it yields is a
   60-day bearer credential to the owner's live accounting system. It must never touch the device.

## Recommended architecture (device = thin trigger)
- **Capacitor PWA (client):** existing UI + "Connect Xero" and per-invoice "Push to Xero". Holds
  only the Firebase Auth identity. Talks ONLY to your own Cloud Functions (authed by the Firebase ID token).
- **Firebase Cloud Functions (the only "server", still in the Firebase stack):** the confidential
  OAuth2 client (holds the Xero client secret), the redirect handler, the token-refresh engine, the Xero API proxy.
- **Firestore:** (a) locked secret vault `secrets/xero` = `{refreshToken, tenantId}` — rules
  `allow read,write: if false` (Functions use Admin SDK, bypass rules); (b) `xeroContacts/{id}` cache;
  (c) `xeroInvoiceID/xeroStatus/pushedAt` written onto each invoice doc.

### Flows
- **Connect:** phone taps Connect → callable `xeroAuthStart` builds the authorize URL (scopes
  `openid profile email accounting.transactions accounting.contacts offline_access`) → opens it in
  the **system browser** (Capacitor Browser plugin, NOT the WebView) → owner consents → Xero 302s to
  the HTTPS `xeroAuthCallback` Function → exchanges code+secret, gets `tenantId` from `/connections`,
  writes the vault.
- **Push invoice:** phone taps Push → callable `xeroPushInvoice(invoiceId)` → Function refreshes the
  access token (storing the rotated refresh token back atomically), resolves/creates the Xero Contact,
  `POST /Invoices` (Type=ACCREC) with `Xero-Tenant-Id` + `Idempotency-Key` → writes status back.

## Implementation steps (when greenlit)
1. **Xero app reg** (free): developer.xero.com → New app → **Web app** (confidential client). Redirect
   URL = the `xeroAuthCallback` Function URL (HTTPS). Note Client ID + generate Client Secret (server-only).
2. **Firebase:** upgrade to **Blaze** (≈$0 for one user, card required). `firebase init functions`.
   Store `XERO_CLIENT_ID`/`XERO_CLIENT_SECRET` via v2 secrets. Lock `secrets/*` in firestore.rules.
3. **Three functions:** `xeroAuthStart` (callable), `xeroAuthCallback` (onRequest), `xeroPushInvoice`
   (callable). One shared `getAccessToken()` helper that serializes refresh via a Firestore transaction.
4. **Client:** Capacitor Browser plugin; "Connect Xero" + "Push to Xero" buttons; connection-status read.
5. **Verify against Xero's Demo Company:** push a draft, refresh twice (2nd must work), confirm
   Idempotency-Key blocks a double-push.

## Decisions for Steven (HITL)
- **Push as DRAFT or AUTHORISED?** Recommend **DRAFT** to start (owner reviews/approves in Xero;
  AUTHORISED hits the ledger immediately).
- Blaze upgrade + Xero dev app are prerequisites only he can action.

## Effort & risk
- **~2–4 days.** Bulk is the three functions + token vault/refresh helper.
- **Biggest risk: refresh-token rotation under concurrency** — all refreshes through ONE function,
  serialized with a Firestore transaction. Never refresh from two places, never from the device.

## Limits / notes
- Uncertified app limit is 25 connected orgs (need 1) — no certification/partner program required.
- Rate limits: 60/min/tenant, 5000/day/tenant. Access token 30 min; refresh 60 days.

*Sources: Xero developer docs (OAuth2 auth-code & PKCE flows, token types, Invoices API, limits FAQ,
token-management best-practices blog). Full citations in the research transcript.*
