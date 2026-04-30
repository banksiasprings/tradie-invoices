# CLAUDE.md — Tradie Invoices PWA

Behavioural guidelines for all coding work on this project.
Adapted from Andrej Karpathy's LLM coding observations and the Superpowers methodology.

## Project context
Single-file PWA at `www/index.html`. Firebase Firestore sync. Capacitor/Android build.
SW cache: `invoice-pdf-vN` — bump on every deploy.
Deployed via GitHub Pages from `main` branch.

## Coding behaviour

### Think before coding
- State assumptions explicitly. If uncertain, ask first.
- If multiple approaches exist, present them — don't pick silently.
- Push back when a simpler solution exists.

### Simplicity first
- Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.

### Surgical changes
- Touch only what the request requires. Don't "improve" adjacent code.
- Match existing style even if you'd do it differently.
- Every changed line must trace directly to the user's request.

### Verify before handoff
- Always test logic by reading through it before calling it done.
- Never hand off broken or unverified work.
- Include app + SW version in every completion message.

## Key architecture notes
- Entry storage: each log entry has a unique `id` (Date.now().toString(36) + random) — NEVER key by date alone or multiple same-day entries will collide.
- GPS geofencing: `navigator.geolocation.watchPosition` + haversine distance check against saved sites.
- Firestore: REST API writes using Firebase auth ID token.

## Git workflow
- All git via osascript
- Commit and push after every change — never leave work uncommitted
- Clear lock files first: `rm -f .git/index.lock .git/HEAD.lock`
- Working dir: `~/Documents/tradie-invoices`
