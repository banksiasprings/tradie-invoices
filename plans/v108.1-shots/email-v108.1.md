**To:** smcnichol@outlook.com
**Subject:** v108.1 — you were right, travel time WAS in your goal number ($236 of it)

---

Steven,

You were right and I was wrong twice. The label was in the data exactly where you
said it was.

**Download (APK):**
https://github.com/banksiasprings/tradie-invoices/releases/tag/v108.1-travel-exclusion

---

## What I got wrong the last two times

There are **two different things** in the app called "travel", and both previous
looks checked the wrong one.

- **"Travel" the billing line** — the km/hour rate you can add to a day. You have
  **never switched it on.** All 57 of your confirmed days say `travelMode: none`.
  So that one really is $0, and that's why I kept reporting "already excluded,
  nothing to do."
- **Travel TIME** — the hours the work timer was running while you were driving.
  Lucas Ranch is a 2900 m fence, so the clock starts when you reach the district
  and keeps running whether you're on the machine or in the ute. **That** was in
  your goal number.

## You were right about the label too

When you approve a trip in the Trip Log, the app writes `business` on it. When you
confirm a lap in Loads, it stamps the circuit. That's the distinction you were
describing — and it's the same pair the invoice's "Work carried out" block already
prints next to each other ("16 loads hauled from…" / "34.6 km travel").

The new exclusion reads **exactly the same rule** that writes that travel line, so
the review screen can't disagree with the invoice about what counted as travel.

## Your actual numbers

- **FY2026-27 YTD: $3,932.00 → $3,695.64** — down **$236.36 (6.0%)**
- **4 days affected:** 28, 29, 30, 31 July
- **Nothing older changes.** Trip recording only starts 27 July, so last FY is
  untouched.
- Effective rate still shows **$60/hr**, your configured rate.
- **Your invoices do not change by one cent.** Muirlawn is billed the full amount,
  and the accountant CSV is untouched.

## Please look at one thing

Stats → goal card → **Review excluded**. You'll see:

```
28 Jul 2026  Lucas Ranch                              $165.52
  Travel time · 2.76h                                 $165.52
  2.76h of 10.00h billed — 06:42–10:04 (55.9 km, 17 km/h)
                         · 17:49–18:14 (22.5 km, 54 km/h)
```

**That 17 km/h is suspicious.** 56 km in 3 hours 22 minutes isn't driving — it
looks like a trip the detector never closed when you arrived on site. If that's
what happened, then $165 of the $236 is wrong. Open that trip in the Trip Log,
fix its finish time, and the goal number corrects itself automatically (nothing is
baked in — it re-derives every time).

## Two calls I left to you

1. **You bill Muirlawn for that driving time, so you do keep that money.** Taking
   it out makes the goal "what I earned being productive" rather than "what I
   kept" — which is a different question from the one you answered for me on
   v106.0. If you'd rather it counted, there's a toggle on that same review screen
   and it's one tap.
2. Should the `34.6 km travel` line stay in the invoice's "Work carried out" text?
   It moves no money, and you said before that passthrough should stay on the
   invoice, so I left it alone. Still open from v108.0.

## Installing

Tap the APK link, allow "install from this source", install over the top — your
data is kept. The web app updates itself, but the APK is what gets the corrected
number onto the **home-screen widget**.

---

1611 automated checks + 896 in-browser checks, all green. I also caught one of my
own tests cheating: the "the invoice doesn't change" check compared two strings
and would have passed if both invoices were empty. It now proves the invoice is
real and bills the full $600 before comparing.

— Claude
