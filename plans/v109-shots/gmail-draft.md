**To:** smcnichol@outlook.com
**Subject:** Invoice app v109.0 — keep a copy, no more phantom invoices, and a Resend button

---

Steven,

Three fixes shipped in v109.0. All three are live on the web app now, and the APK
is attached to the release below.

**Install:** https://github.com/banksiasprings/tradie-invoices/releases/tag/v109.0-bcc-resend

---

**1 · You now keep a copy of every invoice you send**

Settings → Invoice details → **BCC a copy to me**. Put your email in and every
invoice you send gets blind-copied to you, so you always hold the actual PDF that
went to Muirlawn. Leave it blank to turn it off.

To stop them piling up in your inbox, make a Gmail filter for:

    from:me AND has:attachment AND subject:"Invoice"

→ apply label **Sent Invoices** + **Skip the Inbox**. There's a *Copy filter*
button right next to the field so you don't have to type it.

If you fat-finger the address the app tells you, rather than quietly sending
nothing anywhere.

**2 · Backing out of the email no longer bills the job**

This was a real bug and worth knowing about. When the app opened Gmail with your
invoice attached, it treated "Gmail opened" as "invoice sent" — so if you backed
out without hitting send, it still marked those days as invoiced and bumped your
hourly rate. An invoice that was never sent, days gone from your list, rate up.

Now it asks: **"Did you send Invoice #0045?"**

- **Yes** → marks the days invoiced and raises your rate, same as always.
- **No** (or just closing the box) → nothing changes at all. Your days stay right
  where they were.

*Undo last invoice* still works if you say Yes by mistake.

**3 · Resend**

Saved Invoices rows have a **↻ Resend** button now. It sends the exact same PDF to
the same client, with your BCC on it.

It does **not** count as a new invoice — no rate bump, no days archived, no invoice
number used up. So if Muirlawn says they never got it, just hit Resend.

---

Two things worth flagging:

- **The travel-time toggle from v108.1 is still yours to decide on.** You bill
  Muirlawn for that driving, so switching it off makes the goal number
  "productive earnings" rather than "money kept" — different question from the
  one v106.0 answered. And $165 of that $236 rests on the 28 July trip that
  averages 17 km/h over 3h22m, which is more likely a trip that never sealed on
  arrival than three hours of actual driving.
- **The BCC won't backfill.** It only applies to invoices sent from here on. Old
  ones you can pull with the Resend button, which will BCC you a copy.

Everything's tested: 1815 pure + 958 live + 11 widget render tests, all green.

Cheers,
Claude
