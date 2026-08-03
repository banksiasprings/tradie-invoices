**To:** smcnichol@outlook.com
**Subject:** v108.2 — the widget got your circle, and travel time is out of the goal ($236)

---

Steven,

Two things in one build. Download:
https://github.com/banksiasprings/tradie-invoices/releases/tag/v108.2-solar-widget

*(Shipped as v108.2, not v108.1 — v108.1 was already out with its own APK, and
reusing a version number with different content is the exact trap that left this
app stuck on old code for a month back in v82. Both changes are in this one.)*

---

# 1 · The widget looks like your solar one now

You were right, the old one had no anchor — a big number on the left and dead
space on the right. It's now the same four bands as BSF Solar:

- **Header**: 🎯 Invoice · FY2026–27 · a pill on the right — **BEHIND $9k**
- **Body**: a **green ring** with the % inside it, next to `$3,932`,
  `of $140k target`, `This week 32.3h / 45h`
- **Icon row**: `🕐 21.8h/wk · 📅 3 of 5 · 💵 $60/hr`
- **Bottom bar**: `Tap to open` · `as of 12:25 PM`

2x1 gets header + ring + number. 2x2 gets everything but the icon row. 4x2 gets
the lot. The ring gets bigger with the widget.

Tapping a week bar still opens the Log for that week. The old flat progress bar
and the milestone chips are gone — the ring does that job now.

**One thing worth knowing:** the card tints itself from your wallpaper (that's
what makes it look like it belongs on your home screen), but that turned the ring
a dark plum, so I've pinned the ring to the app's green on every phone.

Screenshots of all three sizes, light and dark, are attached to the release.

---

# 2 · Travel time is out of your goal number

**You were right and I was wrong twice.** There are two different things called
"travel" in this app:

- The **travel billing line** (km rate / hourly travel charge). You've **never
  switched it on** — $0 on all 57 of your days. That's what I kept checking, and
  why I kept telling you it was already excluded.
- **Travel TIME** — the hours the work timer runs while you're driving. Lucas
  Ranch is a 2900 m fence, so the clock starts when you reach the district and
  runs whether you're on the machine or in the ute. **That** was in your goal.

And you were right that the label already existed: approving a trip writes
`business` on it, confirming a lap stamps the circuit. Same pair the invoice's
"Work carried out" block already prints next to each other.

**Your numbers:**

- **FY2026-27 YTD: $3,932.00 → $3,695.64** — down **$236.36 (6.0%)**
- 4 days: 28–31 July. Nothing older changes (trips only start 27 July).
- Effective rate still **$60/hr**.
- **Your invoices don't change by a cent.** Muirlawn is billed the full amount,
  accountant CSV untouched.

**Have a look at this row** — Stats → goal card → **Review excluded**:

```
28 Jul 2026  Lucas Ranch                              $165.52
  Travel time · 2.76h                                 $165.52
  2.76h of 10.00h billed — 06:42–10:04 (55.9 km, 17 km/h)
                         · 17:49–18:14 (22.5 km, 54 km/h)
```

**That 17 km/h is the thing to check.** 56 km in 3 hours 22 minutes isn't
driving — it looks like a trip the detector never closed when you arrived. If
that's what happened, $165 of the $236 is wrong. Fix that trip's finish time in
the Trip Log and the goal figure corrects itself; nothing's baked in.

There's a toggle on that same screen to turn the whole thing back off.

---

## Two calls I've left to you

1. **You bill Muirlawn for that driving, so you do keep the money.** Taking it out
   makes the goal "what I earned being productive" rather than "what I kept" —
   which is a different question from the one you answered on v106.0.
2. Should the `34.6 km travel` line stay in the invoice's "Work carried out" text?
   It moves no money and you said passthrough stays on the invoice, so I left it.
   (Still open from v108.0.)

---

## Installing

Tap the APK on the release page, allow "install from this source", install over
the top — your data is kept. **The APK matters this time**: the widget is new
layouts and images, and the over-the-air update only carries the web half.

Then long-press the widget and resize it, or remove and re-add it to try a
different size.

---

1682 automated checks, 896 in-browser, 11 on-device render tests — all green.

I also caught three of my own tests cheating: one compared two invoices that
could both have been empty; one checked the ring's "3%" was present and correct
and passed while it drew **no pixels at all**; and one only checked the headline
for truncation while three other labels were quietly cut off. All three now fail
on the real thing.

— Claude
