# App Review — 2026-06-13

Full review of `www/index.html` (~6800 lines) across correctness, data integrity, and UX,
prompted by Steven's request to "test everything thoroughly… and review anything that could
be improved." Two independent review passes (correctness + UX) plus live on-device geo testing.

**Already fixed this session (v83):**
- ✅ **Log entries can now have their DATE edited** (was time-only). [U1]
- ✅ **Edit now rejects finish-before-start** instead of silently saving a $0 day. [C3, partial]

**Live-verified on Steven's phone (v82):** auto-start on accurate GPS inside fence, auto-stop on
accurate GPS outside fence (5.25h recorded correctly, log shows `acc · distance`), accuracy gate
rejects a 400m fix, and the 5am–9pm working-hours guard. All pass.

---

## Open findings — prioritized

Severity: 🔴 high · 🟠 medium · ⚪ low. "Effort" is rough.

### 🔴 C1 — Auto-stop can be silently lost if the phone kills the app mid-debounce
The normal auto-stop path schedules a 5-minute debounce timer (anti-flutter) and **immediately
marks the exit event "processed."** That timer lives only in memory. If Android kills the
backgrounded app during those 5 minutes (common), the timer dies, the event won't replay (it's
already marked processed), and **the day stays running indefinitely → over-billing.** No new exit
fires to rescue it because you've already left.
*This is in the v81 code I wrote — it's the one real hole in today's reliability work.*
**Fix:** persist a "pending stop" record (site + exit time + fire-at) to localStorage; on app
open, if the deadline passed and you're still outside, apply the stop with the recorded time.
Effort: medium. **Recommend fixing next — it undercuts the whole auto-stop guarantee.**

### 🔴 C2 / U3 — "Generate Invoice PDF" archives days + raises your rate even if the send fails or you cancel
One tap does four things synchronously, *without waiting for the PDF/share to succeed*: builds the
PDF, marks every selected day `invoiced` (hiding them), increments the invoice number, and **raises
your saved hourly rate**. If the share sheet is cancelled or the PDF libs fail to load in the field,
the days are already archived and the rate already bumped — a "phantom invoice." Retrying bumps the
rate again. It's also the only irreversible action with **no confirmation** (deletes all have one).
**Fix:** `await` the PDF/share, and only archive + bump rate + burn the number on success; add a
confirm that states the consequence ("send #N, archive M days, raise rate to $X?"). Effort: small–medium.

### 🔴 U2 — A logged day's SITE/client can't be changed in any edit screen
If the auto-timer (or a manual entry) attributes a day to the wrong site, there's no way to fix it
except delete + recreate — and **site → client → which invoice the day lands on**, so a wrong site
silently bills the wrong client. **Fix:** add a site dropdown to the edit modal (reuse the
manual-entry picker). Effort: small.

### 🔴 U5 — Manual Entry can't record machines/plant
Every other day-entry path supports machine hire, but the "log a day you forgot" screen can't —
so the single most valuable billable line for earthmoving can't be entered without saving a bare
day then editing it. **Fix:** add the machine card to Manual Entry (all helpers already exist).
Effort: small.

### 🟠 C3 (remainder) — Active-timer edit still lacks the finish-after-start guard
`saveLogEdit` is fixed (v83); the active-day edit modal's `saveEdit` still accepts bad times.
**Fix:** same one-line guard. Effort: tiny.

### 🟠 C4 — Discarding a day doesn't re-arm the geofence for the rest of that day
After a discarded false-start, `geoAutoStartTriggered` stays true, so auto-start won't fire again
that day at the same site. `saveDay` resets these flags; `confirmDiscardDay` doesn't. **Fix:** mirror
the reset + `_saveGeoFlags()`. Effort: tiny.

### 🟠 C5 — Deleting an invoice record deletes by number, not id
Invoice numbers are user-editable and can repeat; deleting "#N" filters by `num`, so it can wipe
multiple records. Records already carry a unique `id`. **Fix:** filter by `id`. Effort: tiny.

### 🟠 U6 — No "+ New Job" on Manual Entry
Site is required but there's no way to add one from this screen (the check-in screen has the button).
A user with no sites hits a dead end. **Fix:** add the same `＋ New Job` button. Effort: tiny.

### 🟠 U7 — Manual-entry "Notes" are write-only
Notes are saved but never shown in the Log, never editable, never on the invoice. **Fix:** render
notes in the Log card + add to the edit modal. Effort: small.

### ⚪ Lower priority
- **C6** — Stats "total invoiced" excludes GST when GST is on (confirm intent: ex- or inc-GST?).
- **C7** — Re-entrant double-stop race on the old-exit path (mostly mitigated by existing guards).
- **C8** — A startup settings-migration write can be overwritten by older cloud data on first
  restore (self-heals next launch).
- **U8** — Invoice Preview doesn't refresh after you change the day selection.
- **U10** — Active-timer GPS bar has no "location denied" copy (idle screen does).

---

## Verified OK (don't re-investigate)
- `saveDay` writes localStorage first, guards cloud calls, filters by id (v65 class fixed).
- `S()/days()/sites()/activeDay()` return fresh copies (no aliasing bug).
- `saveManualEntry` validation is solid (rejects empty + finish-before-start).
- Replay flutter-collapse correctly excludes rejected events; enter-path guards are race-safe.
- Empty/GPS states across idle check-in, Log, invoice client lists are handled well.

---

## Suggested order
1. **C1** (auto-stop persistence) — finishes today's reliability theme.
2. **C2/U3** (invoice await + confirm) — protects billing.
3. **U2 + U5** (edit site, manual-entry machines) — both small, both high daily value for earthmoving.
4. The tiny ones: **C3-remainder, C4, C5, U6** — a quick batch.
5. **U7** + the ⚪ items as time allows.
