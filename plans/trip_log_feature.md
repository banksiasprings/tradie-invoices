# Trip Log — a business/personal km tracker built into the invoicing app

**Idea captured 2026-07-01 from Steven.** Queued for post-pipeline-wrap consideration.

## The pitch (Steven's own words, paraphrased)

Available trip tracking apps are either paid, or free with insulting limits (e.g. 10 trip cap). The tech is simple. The invoice app already has all the hard work done — GPS tracking, geofencing, offline persistence, cloud sync, session data model. Adding a trip log is a natural extension. It'd be a "bolt-on" feature — users don't have to use it, but it's there. Would also feed real driving data into the future car recommendation app.

## Why the invoice app is uniquely positioned

The hardest parts of a trip tracker are:

1. **Background GPS tracking that survives Doze / App Standby / OEM battery killers** — solved in v89 + v90 + v92
2. **Reliable geofencing that fires when the app is dead** — solved in v90 native drainage
3. **Offline-first data persistence with cloud sync** — solved (Firestore + SharedPrefs + Room)
4. **Multi-session queue that captures across days without opening the app** — solved in v90
5. **Auth + multi-tenant Firestore rules** — solved
6. **Battery whitelist / permissions self-check** — solved in v92

That's about 80% of what any trip tracker needs. The invoicing app is genuinely already there.

## What's actually new to build

### Core

- **Trip session type** — distinct from a work session (which is geofenced at a saved site). A trip is `A → B` where neither end has to be a saved site.
- **Auto-detection heuristics** — when the phone is moving faster than walking speed (~10 km/h) for > 2 minutes, start a trip session. When it stops moving for > 5 minutes, end it.
- **Route polyline recording** — save GPS points every 30-60s during a trip so total km = Haversine sum, not straight-line distance.
- **Category tagging** — business / personal / commute / mixed, plus optional custom tags (kids' activities, groceries, etc.)
- **Vehicle setup** — user adds "My car" with rego, model, optional cents-per-km rate.

### ATO tax integration

- **Logbook method** support — 12-week continuous logbook that computes business-use percentage
- **Cents-per-km method** support — cap at 5,000 km/year, current rate 78c/km FY2024-25 (verify at build time — ATO updates yearly)
- **Export to CSV + PDF** — accountant-ready. This is what will actually make people use it.

### UI

- New **"Trips"** tab (5th tab: Today / Log / Invoice / Stats / Trips / Settings)
- Home widget: today's trips + km, categorised
- Weekly + monthly summary with pie chart (business / personal split)
- Individual trip detail: map polyline, start/end times, category, notes
- **Quick-toggle** on the trip: swipe right = business, swipe left = personal

### Smart auto-categorisation over time

- **Origin/destination match a saved site** → auto-tag business
- **Home → known work location, weekday morning** → auto-tag commute
- **Recurring routes to same location** → learn pattern, offer to auto-tag
- **User-editable** — always let them override

### Integration with existing work sessions

- If a trip's endpoint is a saved job site → offer to link the trip to that site's work session
- Business-linked trips can be attached to a specific invoice as a mileage claim

## Effort estimate

- MVP (trip auto-detection + km + basic category + weekly summary): **2 weeks agent work**
- ATO logbook + cents-per-km modes: **+1 week**
- CSV / PDF export: **+3 days**
- Multi-vehicle + registration switching: **+3 days**
- Smart auto-categorisation learning: **+1 week**
- Polish + testing: **+3 days**

**Total: 4-5 weeks for a properly good version.** Or **2 weeks for a genuinely useful MVP** that beats every free option on the market.

## Business model / positioning thoughts

The invoicing app becomes a **"field worker + tax logbook"** app. That's a bigger addressable market than pure invoicing:

- Tradies (existing target)
- Real estate agents (miles to inspections)
- Anyone claiming business use of a personal car
- Anyone who wants to know how they actually use their car (for car buying decisions)

Free = sticky. Users install for one reason, stay for another.

## Sequencing recommendation

**Wait until:**
1. v90-v92 fully validated in Steven's own field use (couple of weeks)
2. The invoice pipeline is proven stable enough that you're not fixing regressions
3. Steven has actual desire to drive-test it himself (natural cadence)

**Then:**
1. **v100** — Trip Log MVP (auto-detect + km + swipe category + weekly summary)
2. **v101** — ATO logbook mode + CSV export
3. **v102** — Smart auto-categorisation + saved routes
4. **v103** — Integration hooks: attach trip to invoice, feed data to car app

Naming the version series v100+ so it's clearly a "phase 2 major" not a bug fix.

## Related idea — Car recommendation app revival

Steven's original car app stalled because CarSales data was locked down. But CarSales has an affiliate/partner program.

### What I know

- **CarSales Referral / Affiliate Program** exists — earn commission on referrals that convert. Details vary by product line.
- **Partner API** exists for dealer feed and premium partners. Requires business account approval, not open to consumers.
- **CarSales Ads API** — for advertisers, not general use.

### What needs verification

- Whether affiliate access includes any listing feed API, or is just tracking URLs.
- Signup requirements — often needs ABN + business plan + expected traffic estimates.
- Terms around scraping / re-hosting listings (usually forbidden even for affiliates).

### Realistic approach

1. **Apply to CarSales Partner Program** — 2-4 week approval cycle typical for referral partners. Might yield: (a) a feed API for basic listing data, (b) tracking parameters for links, or (c) just standard affiliate widgets.
2. **In parallel** — check what Autotrader AU and Drive.com.au offer. Might be easier partner terms.
3. **Fallback** — deep-link to CarSales searches with affiliate params. User does the search on CarSales, comes back to app with the URL for parsing.

### Where the trip data fits

The car recommendation gets MUCH smarter with real usage:
- "400 km/week, 80% urban short trips" → hybrid or small EV
- "20% off-road paddock use" → 4WD ute
- "Long highway commute Mon-Fri" → efficient long-range ICE or PHEV
- "Kids' school runs + weekend touring" → 7-seat with towing

This is a genuine competitive edge over any car-recommendation service that asks "how many km do you drive?" and gets guesses.

### Sequencing recommendation

**Trip log MVP FIRST.** Get real driving data flowing for Steven (and any beta users). THEN revive the car app once there's real data to plug in. Applying to CarSales affiliate program can start in parallel to the trip log build — approvals are slow.

## Honest verdicts

**Trip log idea: strong ✅**
- Real user need + free options are actually bad + tech reuse is 80% done
- Sticky feature, expands the app's positioning
- Genuine market gap for a good free / cheap tradie-oriented logbook

**Car app revival: yellow ⚠️**
- Depends entirely on what CarSales Partner Program actually offers — unknown until you apply
- If partner API is available: green light, big opportunity
- If just affiliate tracking URLs: much smaller app, still doable but less differentiated
- Worth starting the CarSales conversation in parallel to trip log build so we know before committing to build

**Combined idea (trip data → car recommendations): very strong ✅**
- Real accurate km data is the killer differentiator vs guess-based competitors
- Users who track trips for 3 months have the data car dealers dream of
- Natural bridge between the two apps

---

## Micro-advertising / shared ecosystem (2026-07-01 addition)

Steven's follow-up: use tiny contextual nudges to cross-promote the car app from inside the logbook. "Based on your driving, you could save $X/year with a [car]." Not banner ads, not spammy — small, dismissible, data-driven.

### Legal / policy read

- **Google Play policies**: cross-promoting your own developer portfolio is explicitly allowed. It's not "advertising" in the intrusive-ad sense.
- **AU Consumer Law (ACCC)**: any claimed savings must be substantiated. Say "estimated savings up to $X" with a link to the assumptions, not "you WILL save $X".
- **User trust**: the difference between "loved" and "hated" is *timing* and *usefulness*. Show the card AFTER 3 months of data, not on day one. Only if the numbers actually support a recommendation.

### Design principles

- Non-intrusive: small card at the bottom of the weekly/monthly summary, dismissible
- Contextual: only surfaces when data actually supports a claim
- Honest: "Estimated savings" with source explanation
- Unified brand: feels like "your apps working together", not third-party ads
- Never in-face during actual work (no card while user is logging a trip or invoicing)

### Effort: minimal (~1 week) once the car app has recommendations to link to.

---

## Xero / MyOB / QuickBooks integration (2026-07-01 addition)

Steven's other ask: full accounting-software integration so invoices + kilometers push straight to Xero (and MyOB and possibly QuickBooks). This is the biggest single business-value unlock in this whole plan.

There's already an `XERO-INTEGRATION-PLAN.md` in this folder — this section supplements it with the trip-log-era context.

### Xero specifically

- **Xero API**: mature, well-documented, OAuth 2.0. Full coverage of invoices, contacts, journals, bank feeds, tracking categories, and **mileage expense claims**.
- **Xero App Store**: official marketplace. Listed apps get direct exposure to every Xero customer.
- **Certified integration badge**: requires their code review (4-6 weeks), grants trust + prominence.
- **Marketing lever**: for tradie users, "syncs to Xero" is a huge purchase driver. Xero App Store = organic discovery.

### The mileage claim killer feature

Xero has **Mileage** as a first-class expense type. If our trip log auto-tracks trips, categorises them as business, and pushes them straight into Xero as mileage claims:

- Zero data entry for tax time
- Direct claim reimbursement in Xero
- Nobody else in the tradie market does this end-to-end

That's a **genuine competitive edge**, not incremental polish. Feature parity with mid-tier competitors, wow-factor beyond them.

### MyOB + QuickBooks

- **MyOB**: bigger footprint among older Australian tradies. API exists but is less friendly than Xero's. Worth doing after Xero validates the pattern.
- **QuickBooks**: Intuit API is solid, less relevant in Australia specifically but valuable if we ever push internationally.

### Effort estimates

- Xero OAuth + invoice push (one-way): **1-2 weeks**
- Xero bidirectional (invoices + contacts + mileage): **3-4 weeks**
- Xero App Store certified listing: **+4-6 weeks** (their review timeline, not our build)
- MyOB parity: **2-3 weeks** after Xero pattern is proven
- QuickBooks: **1-2 weeks** basic

### Business impact

- Xero App Store listing = organic marketing channel worth $X thousand/month equivalent in ads
- "Syncs to Xero + auto-mileage" = premium positioning that justifies a paid tier
- Consultant + accountant word-of-mouth ("this app makes my client's tax easy") = strongest sales channel possible

## Revised sequencing (with all ideas layered)

Post v90-v92 field validation:

- **v100** — Trip Log MVP (auto-detect + km + swipe category + weekly summary)
- **v101** — ATO logbook + cents-per-km modes + CSV/PDF export
- **v102** — Xero OAuth + invoice push + mileage push (bidirectional core)
- **v103** — Smart auto-categorisation + micro-promotion cards (car app suggestions)
- **v104** — MyOB integration
- **v105** — Xero App Store certified listing submission
- **v106** — QuickBooks + international expansion prep

**~4-5 months of solid work for a genuinely premium, market-leading product.**

Or a much shorter path if we just want to prove the pattern:
- **v100** MVP + **v102** Xero MVP = **6-8 weeks** to have the killer combo shippable.

The Xero mileage push is what turns a "yet another tradie app" into a proper platform.

