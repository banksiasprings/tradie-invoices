# AUDIT: Log vs Diagnostic Log Discrepancy

**Status:** FIXED in v64  
**Severity:** Medium — causes data integrity confusion, not data loss

---

## Root Cause

`autoStopTimer()` called `nowTime()` twice in sequence:

```js
// Line 2775 (original)
const stopT = overrideTime || nowTime();         // ← used in GeoLog entry
GeoLog.add('stop', 'Auto-timer stopped at ' + stopT + ' · ...');

// ... lunch handling ...

// Line 2781 (original)
const stopTime = overrideTime || nowTime();      // ← SEPARATE call, used for ad.finish
ad.finish = stopTime;
```

If `overrideTime` is `null` (i.e., a live stop, not a replay), both calls independently
call `Date` at slightly different moments. If a clock-minute boundary falls between them —
e.g., the first fires at 15:29:59 and the second fires at 15:30:00 — the GeoLog shows
`15:29` but the saved day record has `15:30`. This is a real mismatch, not a display bug.

## When This Happens

Only when `autoStopTimer()` is called without an `overrideTime`, meaning:
- Web GPS geofence exit (foreground)
- Native EXIT event that is "old" (≥ 5 min) and passes the fresh GPS check
- Manual "Finish Day" uses `finishDay()` which has its own `ad.finish = nowTime()` — not affected

## Fix Applied

Replaced the two calls with a single `const stopTime = overrideTime || nowTime()` at the
top of the function, used for both the GeoLog entry and `ad.finish`. The variable was
also renamed from `stopT`/`stopTime` to just `stopTime` for clarity.

---

## Impact Assessment

- **GeoLog time** will now always match **saved day finish time** exactly.
- No data migration needed — previously saved days are unaffected.
- Existing GeoLog entries (in localStorage) retain their historic times; only new stops use the fix.
