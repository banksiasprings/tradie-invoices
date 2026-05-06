# Invoice App — Overnight Audit Report
*Ready when you wake up ☕*

**App:** Invoice & PDF Generator  
**Audit completed:** 2026-05-07  
**Version before:** v63 / SW v63  
**Version after:** v64 / SW v64 (fixes applied, committed, pushed)

---

## The Short Version

I found 2 real bugs, fixed both, and pushed v64. I also found 4 more lower-priority issues
and documented them with recommended fixes. The "timer won't start/stop" complaint is
**mostly architectural** (not a simple bug) — explained below.

---

## What Was Broken — Fixed in v64

### Fix 1: Log time ≠ saved time (the "nightmare" discrepancy)

`autoStopTimer()` was calling `nowTime()` twice — once for the GeoLog entry, and once
again for the saved day record. If those two calls straddled a clock-minute boundary
(which happens roughly 1-in-60), the log would show "15:29" but the saved day would say
"15:30". That's the entire source of the mismatch you were seeing.

**Fixed:** Single `stopTime` variable now used for both. GeoLog and saved record will
always match exactly.

### Fix 2: Timer restarted after auto-stop (review screen bug)

If the app auto-stopped your timer in the background (via native geofencing) and you then
navigated away from the review screen without saving, coming back to the Check-in tab would
restart the timer display — even though your day had a finish time recorded. The timer would
show the wrong elapsed time.

**Fixed:** Check-in screen now checks whether `activeDay` already has a finish time. If so,
it goes straight to the review screen. If not, it shows the live timer. Clean.

---

## The Background Timer Question

"App won't start or stop unless app is open" — here's the full truth:

### If you're using the PWA (browser / Chrome icon on home screen):
This is completely true and unfixable. The browser's GPS watcher stops the moment the
screen goes off. There is no way around this in a browser. To get background geofencing
you need the APK.

### If you're using the APK:
The background geofencing **does actually work** — it just looks like it doesn't because
the timer display can't update while the app is closed (that's just how JavaScript works).

Here's what actually happens when you use the APK:
1. You arrive at a job site. Your phone is in your pocket, app closed.
2. Android fires a geofence event immediately. You get a push notification: "Arrived at Hillside — timer started at 07:30".
3. The event is saved in the background with your actual arrival time.
4. When you open the app (even hours later, even next morning), the pending event replays and the timer is set to 07:30 — your actual arrival time, not whenever you opened the app.
5. Same when you leave — the exit event fires, you get "Left Hillside — timer stopped at 15:30", and it records 15:30 as your finish time.

So the system works correctly. What's missing is the UX feedback. There's nothing visible
until you open the app, and when you do, things snap into place but it can feel confusing.

I've added fix recommendations to make this clearer (see AUDIT-plan.md FIX-6).

---

## Other Issues Found (Not Fixed Yet)

These are in `AUDIT-full-code-review.md` and `AUDIT-plan.md` with full details:

| # | Issue | Risk | Priority |
|---|---|---|---|
| 3 | Lunch duration wrong in replayed stop events | Very low (rare edge case) | Future |
| 4 | Geo trigger flags reset on app kill → possible duplicate auto-start | Low | Next sprint |
| 5 | Arrival/departure notification guards reset on kill → possible duplicate notification | Low | Next sprint |
| 6 | No UI feedback that background geofencing is active or processed an event | UX | Next sprint |

---

## Files Changed

```
www/index.html   — Fix 1 + Fix 2 + APP_VERSION v63 → v64
www/sw.js        — Cache invoice-pdf-v63 → invoice-pdf-v64
www/AUDIT-MORNING-REPORT.md       ← this file
www/AUDIT-log-discrepancy.md      ← deep dive on Fix 1
www/AUDIT-background-timer.md     ← deep dive on background timer + Fix 2
www/AUDIT-full-code-review.md     ← all issues found, severity ratings
www/AUDIT-plan.md                 ← prioritised fix plan
```

All committed and pushed to GitHub. ✅

---

## To Verify the Fix

Open the app on your phone and check the version shows **v64** in Settings. Clear the
GeoLog if you want a clean run, then test at your next site.

For background timer: make sure you're running the APK (not the browser PWA). The push
notification on arrival/departure is the confirmation that the background system fired.
