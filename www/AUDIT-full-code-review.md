# AUDIT: Full Code Review — Invoice & PDF Generator

**App version:** v63 (audited) → v64 (fixes applied)  
**SW version:** invoice-pdf-v63 → invoice-pdf-v64  
**Date:** 2026-05-07

---

## Architecture Summary

Single-file PWA (`index.html` ~5,990 lines) + `sw.js`. Firebase (Auth + Firestore) for
cloud sync. Capacitor Android wrapper for APK. No build step — raw HTML/CSS/JS.

Key subsystems:
- **DB**: localStorage wrapper (`DB.get/set`)
- **CloudSync**: Firestore blob-per-user sync + archive flags
- **GeoLog**: localStorage diagnostic log (200-entry ring buffer)
- **GPS**: Web `watchPosition` + 90s backup poll (foreground only)
- **NativeGeoPlugin**: Capacitor Java plugin for background Android geofencing
- **Timer**: `setInterval` ticking display, `activeDay` record in localStorage
- **Auth**: Firebase email/password with admin gating

---

## Confirmed Bugs

### BUG-1: `autoStopTimer` double `nowTime()` call ✅ FIXED in v64
See `AUDIT-log-discrepancy.md` for full writeup.

### BUG-2: `initCheckinScreen` doesn't check `ad.finish` ✅ FIXED in v64
See `AUDIT-background-timer.md` for full writeup.

---

## Other Issues Found

### ISSUE-3: `autoStopTimer` lunch calculation uses `new Date()` instead of `stopTime`
**Location:** Line 2777-2779

```js
if(ad.lunchStart){
    const[sh,sm]=ad.lunchStart.split(':').map(Number),now=new Date(),mins=now.getHours()*60+now.getMinutes()-sh*60-sm;
```

When `autoStopTimer` is called via a queued event replay (e.g., `overrideTime = '15:30'`),
the lunch duration is calculated from `new Date()` (the time the user opened the app the
next morning — e.g., 07:10) rather than from the replayed stop time. This would produce a
wildly wrong (negative or huge) lunch duration.

In practice this is extremely unlikely to trigger — `lunchStart` would only be set if the
user actively started a lunch break and then the app was closed without ending it. But it
is a latent bug.

**Recommended fix (not applied in this cycle — low risk):**
```js
if(ad.lunchStart){
  // Parse the stop time string (or use current time for live stops)
  const stopDt = overrideTime
    ? (() => { const[h,m]=overrideTime.split(':').map(Number); const d=new Date(); d.setHours(h,m,0,0); return d; })()
    : new Date();
  const[sh,sm]=ad.lunchStart.split(':').map(Number);
  const mins = stopDt.getHours()*60+stopDt.getMinutes()-sh*60-sm;
  ad.lunchMins=(ad.lunchMins||0)+Math.max(0,mins);ad.lunchStart=null;
}
```

### ISSUE-4: `geoAutoStartTriggered` / `geoAutoStopTriggered` are in-memory only
**Location:** Lines 2579-2582

These flags prevent duplicate auto-start/stop on the same day. But they are reset when the
app is killed and restarted. If the app restarts on the same day, the flags are `false` and
`processPendingGeoEvents()` could potentially replay an ENTER event that already ran.

**Protection in place:** The `activeDay()` check prevents re-starting if a timer is already
running, and the `geoAutoStartDate` comparison prevents reset on same-day resume. Risk is
low. A more robust fix would persist these flags to localStorage with a date key.

**Recommended fix (future work):**
```js
function loadGeoFlags() {
  const today = todayStr();
  const saved = JSON.parse(localStorage.getItem('mcn_geoFlags') || '{}');
  if (saved.date === today) {
    geoAutoStartTriggered = !!saved.started;
    geoAutoStopTriggered = !!saved.stopped;
  }
}
function saveGeoFlags() {
  localStorage.setItem('mcn_geoFlags', JSON.stringify({
    date: todayStr(), started: geoAutoStartTriggered, stopped: geoAutoStopTriggered
  }));
}
```

### ISSUE-5: `showActiveTimer` restarts `timerInterval` — no guard for stale state
**Location:** Line 2885

`showActiveTimer` always calls:
```js
clearInterval(timerInterval);timerInterval=setInterval(tickTimer,1000);tickTimer();
```

`tickTimer` computes elapsed time from `ad.start` to `now`. If `ad.start` is from yesterday
(e.g., '07:30') and now is 07:35 the next day, `tm` calculates to ~1435 minutes — the
display would briefly show "23:55:00" before `autoStopTimer` updates it. Cosmetic only.

BUG-2 fix in v64 mitigates this for the "already finished" case, but it could still flash
briefly during event replay.

### ISSUE-6: `CloudSync.restore()` vs. `ArchivedSync.restoreArchivedFlags()` race
**Location:** Lines 659-663

`CloudSync.restore()` is awaited, then `ArchivedSync.restoreArchivedFlags()` runs in the
background without awaiting. The comment says this is intentional ("don't block startup").
However if the user navigates to invoices within ~500ms of opening the app, they may see
invoiced flags as `false` for entries that should be flagged. Low risk, would be
imperceptible to most users.

### ISSUE-7: Departure notification per-day guard is in-memory only
**Location:** Lines 2747-2748

```js
let _lastArrivalNotifyDate=null;
let _lastDepartureNotifyDate=null;
```

These are in-memory only. If the app is killed and restarted on the same day, both are
reset to `null`, and the arrival/departure notification guards no longer work. The user
could receive duplicate notifications (one from the BroadcastReceiver when app was dead,
and another from `showGeofenceNotification` when the pending event is replayed).

**Recommended fix:** Persist these to localStorage with a date key (same pattern as ISSUE-4).

### ISSUE-8: No timeout guard in `processPendingGeoEvents` GPS fresh-position check
**Location:** Lines 5738-5749

The `await new Promise(resolve => navigator.geolocation.getCurrentPosition(...))` call
has a 10-second timeout, but there's no try/catch around it in that specific await path.
A GPS error that doesn't call either success or error callbacks (e.g., permission revoked
mid-session) could leave the promise hanging. Low risk given the 10s timeout is set.

---

## Code Quality Notes

- **Single-file approach** is a practical choice for a PWA with no build step, but at
  ~6,000 lines it's becoming hard to navigate. Consider splitting into logical modules
  (geo.js, timer.js, invoice.js) in the Capacitor build process.
- **GeoLog** is well-designed — the ring buffer, grouped-by-date rendering, and Copy button
  are genuinely useful for debugging.
- **Native geofencing architecture** (BroadcastReceiver → SharedPreferences → JS replay) is
  solid and the correct approach for reliable Android background operation.
- **5-minute debounce** before auto-stop is appropriate — prevents false stops from GPS drift.
- **Hour guard** (5am–9pm) is correctly applied in both web GPS and native paths.

---

## Files Changed in This Audit (v64)

| File | Change |
|---|---|
| `www/index.html` | Fix `autoStopTimer` double `nowTime()` (Bug 1) |
| `www/index.html` | Fix `initCheckinScreen` to show review when `ad.finish` set (Bug 2) |
| `www/index.html` | Bump `APP_VERSION` → v64 |
| `www/sw.js` | Bump cache → `invoice-pdf-v64` |
