# Play Store Readiness — Checklist (2026-06-14)

Status after this session's work. **Makeover verdict: NOT required** — the UI is already a coherent,
professional design system (navy/amber/cream, Montserrat/Inter). The work needed is *compliance*, not redesign.

> iOS App Store is a separate effort entirely (needs an Xcode project, a Mac build, and an Apple
> Developer account at US$99/yr) — none of which exists today. This checklist is **Google Play** only.

## ✅ Done — in the app/repo (this session, v88 / versionCode 3 / v1.2)
- **Background-location prominent disclosure** — the #1 rejection cause is fixed. The app now shows
  an in-app dialog ("📍 Auto start/stop your work timer?") that names the feature, says location is used
  *"in the background — even when the app is closed,"* states it's never used for ads/shared, and offers
  **Turn on auto-timer / Not now** — BEFORE the OS permission prompt. Verified it auto-triggers via the
  real init path. Decline ⇒ app runs in manual mode (no location requested). `www/index.html` `#bg-loc-disclosure` + `showLocationDisclosure()` + the gate in `initNativeGeo()`.
- **versionCode bumped 2 → 3 (versionName 1.2)** — avoids the "version already used" rejection on re-upload.
- **≥2 phone screenshots** — 5 captured at 1080×2400 in `play-store-assets/screenshots/` (Today, Log,
  Invoice, Stats, and the auto-timer consent dialog). Were zero before.
- Target API 36 (≥ the API 35 floor) ✅ · app icon 512 ✅ · feature graphic 1024×500 ✅ · listing text ✅ ·
  privacy policy content ✅ · keystore NOT in git ✅ · AAB build path (`run_gradle_release.sh`) ✅.

## 🔴 Steven must do these in the Play Console (I can't — they're account/submission actions)
1. **Background-location declaration form** — declare ONE feature: *"Automatic worksite clock-in/out — a
   geofence starts/stops the work timer when the tradesman arrives at/leaves a saved job site, even when
   the app is closed, so billable hours are captured automatically."* Frame as **self time-tracking, NOT
   employee monitoring** (the team-timesheet feature is a flag — see below).
2. **Demo video (≤30s)** — screen-record: the in-app disclosure dialog → the OS "Allow all the time"
   prompt → the timer auto-starting on geofence entry while backgrounded. (Now possible — the dialog exists.)
3. **Data safety form** — declare: precise location (background), email+name (Firebase Auth), work/invoice
   records; encrypted in transit; deletion-on-request (30 days, per privacy policy); the employer-link as
   user-initiated "sharing."
4. **Content rating (IARC) questionnaire** — complete it (non-game → "Everyone").
5. **Play App Signing** — opt in on first AAB upload (Google holds the signing key; upload key = the repo keystore).
6. **Confirm the privacy policy URL is live** — https://banksiasprings.github.io/tradie-invoices/privacy.html (verify 200, public).
7. **Play developer account** — $25 one-time + identity verification, if not already done.

## 🟡 Risks / decisions
- **Background location is reviewer-dependent but approvable** — the person tracked IS the app user
  (the tradie himself), and background access is genuinely core (a foreground-only timer defeats the
  purpose). Maximise odds by framing as self time-tracking + noting it's opt-in (now true).
- **"Team timesheets / employee hours"** crosses a user-data boundary (one user's hours visible to a
  linked owner). Either de-emphasise it in the submission or be explicit each user tracks their OWN
  location with their OWN consent. Resolve the CLAUDE.md contradiction (listed both as shipped AND under
  "Future Plans — Don't Build") before declaring it. *(Note: the feature IS shipped and works — verified
  end-to-end this session.)*
- **`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`** — Play scrutinises this; justify alongside the geofence, or
  drop it and guide the user to the battery setting manually.
- **Keystore password is plaintext on disk** (`keystore.properties`) — not a git leak, but back the
  keystore up offline; losing it = can never update the app.

## Build the upload artifact
`bash run_gradle_release.sh` → signed `.aab` for upload. Bump `versionCode` again for each subsequent release.
