package com.banksiasprings.invoices;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Build;
import android.text.format.DateFormat;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * v107.0 — turns a {@link WidgetStore.Snapshot} into RemoteViews.
 * v108.2 — rebuilt in the visual language of Steven's BSF Solar widget.
 *
 * Runs on a background thread (see {@link WidgetRefreshWorker}); nothing here
 * touches the UI thread.
 *
 * THE REDESIGN. Steven put the two widgets side by side: "solar is way cooler, I
 * like the circle progress graph." The old card was a flat block with a big
 * left-aligned number and an empty right half — no anchor. Solar's answer is four
 * bands: a header with a status pill, a body with a ring beside the metrics, a row
 * of small aux figures, and a quiet action bar. This class binds those bands; the
 * layouts own the arithmetic of fitting them into 110dp.
 *
 * Colour rule (unchanged, and the reason the ring is split in two): every colour a
 * TextView or background uses is referenced from the LAYOUT XML, never set
 * programmatically. RemoteViews are inflated in the launcher's process with the
 * LAUNCHER's configuration, so a colour baked in from our process would ignore the
 * system theme and strand the widget in the wrong mode.
 *
 * Bitmaps are the exception, because they need a Canvas. There are now two — the
 * week bars and the progress ring — and both resolve their colours from resources
 * (see {@link #barColors} and {@link #ringColors}) so values-night and the
 * Material You overlay apply to them exactly as they do to the layout. That
 * resolution happens in OUR process, so it assumes our configuration's night mode
 * matches the launcher's; for system-wide dark mode — the only way Android exposes
 * this to a user — that holds.
 *
 * The ring's PERCENTAGE is deliberately NOT in the bitmap. It is a real TextView
 * centred over the ImageView, so its colour stays on the correct side of that
 * boundary. Baking it in would have put one more colour in our process for no gain.
 *
 * Language rule: this surface never says "on track", "on pace" or "caught up".
 * A glanceable widget is exactly where a soft word gets read as a fact, so the
 * verdict is always a signed distance, computed by the app and passed through
 * verbatim in `gapText` — and the status pill added in v108.2 obeys the same ban,
 * asserted in every state.
 */
public class WidgetRenderer {

    /** Base request code for the whole-card tap. Per-bar taps start at BAR_RC. */
    private static final int ROOT_RC = 1071;
    /**
     * Per-bar PendingIntent request codes start here, one per bar.
     *
     * THEY MUST BE DISTINCT. PendingIntent identity uses Intent.filterEquals,
     * which compares action/data/type/component/categories and IGNORES EXTRAS —
     * so six bars sharing a request code collapse into ONE PendingIntent and every
     * bar opens whichever week was written last. Nothing errors; the widget simply
     * lies about which week you tapped.
     */
    private static final int BAR_RC = 1080;

    /** Hit cells laid over the bar bitmap, in order. Six is `maxWeeks` in the JS. */
    private static final int[] HIT_IDS = {
        R.id.w_hit0, R.id.w_hit1, R.id.w_hit2, R.id.w_hit3, R.id.w_hit4, R.id.w_hit5
    };

    public enum Size { SMALL, MEDIUM, LARGE }

    /**
     * Ring diameter per size, in dp, and it MUST match the FrameLayout in the
     * corresponding layout file — the bitmap is drawn at this size and scaled by
     * the ImageView otherwise, which is how a ring goes soft. The render test
     * pins the pair, because a layout edit that moves one and not the other is
     * invisible until someone looks closely at a PNG.
     */
    static int ringDp(Size size) {
        // 2x2 is 36, not 40: at 40 the right-hand column came to 126px and the
        // headline needed 148 for "$3,932" — the render test called it clipped.
        // Four dp back to the number was the cheaper trade than shrinking the
        // number, because the ring still reads at 36 and "$3,9…" does not read.
        return size == Size.SMALL ? 18 : size == Size.MEDIUM ? 36 : 46;
    }

    /** Stroke scales with the ring, but not linearly — a thin ring at 18dp vanishes. */
    static float ringStrokeDp(Size size) {
        return size == Size.SMALL ? 3.0f : size == Size.MEDIUM ? 5.0f : 5.5f;
    }

    public static RemoteViews build(Context ctx, WidgetStore.Snapshot s, Size size, long now) {
        int layout = size == Size.SMALL ? R.layout.widget_goal_small
                : size == Size.MEDIUM ? R.layout.widget_goal_medium
                : R.layout.widget_goal_large;
        RemoteViews v = new RemoteViews(ctx.getPackageName(), layout);

        // Whole card opens the app on Stats. One target for every size — a widget
        // with regions that do different things is a menu, not a glance. (The week
        // bars are the one exception, and they are a chart, not a region.)
        v.setOnClickPendingIntent(R.id.widget_root, openStatsIntent(ctx));

        // Bands present at every size and in every state, so they are bound before
        // the empty-state branch rather than duplicated inside it.
        bindPill(v, s);
        if (size != Size.SMALL) bindActionBar(ctx, v, s, size, now);

        if (!s.present || !s.hasData) {
            bindEmpty(ctx, v, s, size);
            return v;
        }

        switch (size) {
            case SMALL:  bindSmall(ctx, v, s, now);  break;
            case MEDIUM: bindMedium(ctx, v, s, now); break;
            default:     bindLarge(ctx, v, s, now);  break;
        }
        return v;
    }

    /**
     * The no-data state. Never "$0.00": a fresh install has not earned nothing,
     * it has told us nothing, and those must not look identical on a home screen.
     */
    private static void bindEmpty(Context ctx, RemoteViews v, WidgetStore.Snapshot s, Size size) {
        // Short by necessity, and deliberately DIFFERENT wording for the two
        // states: "nothing has ever been written" and "nothing confirmed this
        // year" are different problems with different fixes.
        String head = !s.present ? "Open the app" : "No days yet";
        // Short form below 4x2: the 2x2 column is ~137px and "to start tracking"
        // ellipsised to "to start tracki…", which is worse than the shorter
        // sentence it would have been.
        boolean wide = size == Size.LARGE;
        String sub  = !s.present
                ? (wide ? "to start tracking" : "to begin")
                : (s.fyLabel.isEmpty() ? (wide ? "this financial year" : "this year")
                                       : (wide ? ("in " + s.fyLabel) : s.fyLabel));

        setHeadline(v, size, head);

        // An empty ring, not a hidden one: the card keeps its shape, and a 0%
        // track reads as "nothing yet" without claiming a figure. bindRing draws
        // the track alone when pct is null.
        bindRing(ctx, v, s, size);

        // 2x1 has NO sub-label — it is absent from widget_goal_small, not hidden,
        // so addressing it here would throw when the launcher applies the actions.
        // (RemoteViews validates lazily; that failure surfaces in the launcher's
        // logcat, not ours, which is why the render test applies every state.)
        if (size == Size.SMALL) return;

        v.setTextViewText(R.id.w_of, sub);
        v.setViewVisibility(R.id.w_of, View.VISIBLE);

        // GONE, never blank: a weighted TextView with no text still claims a slot
        // and can measure zero width, which the render test correctly calls a
        // squeeze. Absence has to be expressed as absence.
        hide(v, R.id.w_label);
        hide(v, R.id.w_week);
        // The CONTAINER, not just the bitmap: the bars live inside a FrameLayout
        // with six invisible tap cells over them. Hiding only the image would
        // leave those cells live over blank space, so an empty widget would still
        // fire "open week ___" for a week that does not exist.
        hide(v, R.id.w_chart);
        if (size == Size.LARGE) hide(v, R.id.w_aux);
    }

    /**
     * The headline slot holds either a six-character number or a twelve-character
     * sentence, and no single text size serves both. XML autosize was tried first
     * and lost a silent fight with setTextViewTextSize — one of the two wins and
     * neither says which — so the size is computed here instead, where the render
     * test can show what it produced.
     *
     * The scale is a proportional-advance approximation: `cap` is how many
     * characters of the heavy face fit the slot at `base`, measured off the
     * rendered PNGs rather than assumed. Longer strings scale down by the ratio,
     * with a floor so a very long one shrinks to small rather than to nothing.
     *
     * v108.2 re-measured all three: the ring now takes 18-46dp off the left of the
     * headline's row, so the caps came down with the width that was left.
     */
    private static void setHeadline(RemoteViews v, Size size, String text) {
        // 2x2's base came down 18 -> 15 for the same reason the ring came down
        // 40 -> 36: the measured box is ~136px and "$3,932" at 18sp wanted 148.
        float base = size == Size.SMALL ? 14f : size == Size.MEDIUM ? 15f : 22f;
        int   cap  = size == Size.SMALL ? 8 : size == Size.MEDIUM ? 6 : 8;
        // The FLOOR was the bug at 2x2, not the scale: "Open the app" is twelve
        // characters, the ratio asked for 7.5sp, and a 10sp floor overrode it
        // straight back into a clipped headline. A floor exists so a long string
        // shrinks rather than vanishes — 8sp still does that.
        float min  = size == Size.LARGE ? 10f : 8f;
        int   n    = Math.max(1, text.length());
        float sp   = n <= cap ? base : Math.max(min, base * cap / (float) n);
        v.setTextViewTextSize(R.id.w_big, TypedValue.COMPLEX_UNIT_SP, sp);
        v.setTextViewText(R.id.w_big, text);
        v.setViewVisibility(R.id.w_big, View.VISIBLE);
    }

    /**
     * 2x1 — header, ring, number. 40dp of cell height buys nothing more: the
     * first build of this size also carried the of-line and the render test
     * caught it squeezed to 1px. The ring says what that line was spelling out.
     */
    private static void bindSmall(Context ctx, RemoteViews v, WidgetStore.Snapshot s, long now) {
        setHeadline(v, Size.SMALL, WidgetStore.moneyCompact(s.retained));
        bindRing(ctx, v, s, Size.SMALL);
    }

    /**
     * 2x2 — the four bands minus the aux row.
     *
     * THE FY LABEL IS HIDDEN HERE, not left blank. 110dp of header, minus padding,
     * is 96dp; "🎯 Invoice" and a "BEHIND $9k" pill already exceed it, so the
     * weighted label between them measured ZERO WIDTH and the render test failed
     * it as a squeeze. A blank TextView on a weight would have failed the same
     * way — the fix is to remove it from the layout pass, not to empty it.
     *
     * Nothing is lost that matters: the pill is the more useful of the two, and
     * staleness moved to the action bar's as-of slot, which is where a reader
     * would look for it anyway.
     */
    private static void bindMedium(Context ctx, RemoteViews v, WidgetStore.Snapshot s, long now) {
        hide(v, R.id.w_label);
        setHeadline(v, Size.MEDIUM, WidgetStore.moneyCompact(s.retained));
        v.setTextViewText(R.id.w_of, ofLine(s, Size.MEDIUM));
        v.setViewVisibility(R.id.w_of, View.VISIBLE);
        bindRing(ctx, v, s, Size.MEDIUM);
        bindWeek(v, s, Size.MEDIUM, now);
        bindBars(ctx, v, s, now, 96, 15);
    }

    // ── 4x2 — all four bands, and the room to say what the number is made of. ───
    private static void bindLarge(Context ctx, RemoteViews v, WidgetStore.Snapshot s, long now) {
        v.setTextViewText(R.id.w_label, label(s, now));
        setHeadline(v, Size.LARGE, WidgetStore.money(s.retained));
        v.setTextViewText(R.id.w_of, ofLine(s, Size.LARGE));
        v.setViewVisibility(R.id.w_of, View.VISIBLE);
        bindRing(ctx, v, s, Size.LARGE);
        bindWeek(v, s, Size.LARGE, now);
        bindAux(v, s);
        bindBars(ctx, v, s, now, 110, 15);
    }

    /**
     * The status pill — solar's "OFFLINE" chip, carrying the verdict.
     *
     * THE BAN APPLIES HERE TOO, and this is the surface most at risk of breaking
     * it: a pill is three words at 8sp, which is exactly the pressure that
     * produces "ON TRACK". Every branch below is a signed distance or a plain
     * statement of fact. `s.gap` is positive when behind (expected minus actual),
     * which is the sign convention widgetGapText() uses in the JS.
     */
    static String pillText(WidgetStore.Snapshot s) {
        if (!s.present)  return "NO DATA";
        if (!s.hasData)  return "NO DAYS";
        if (s.target == null) return "NO GOAL";
        if ("reached".equals(s.state)) return "GOAL MET";
        if (s.gap == null) return "";
        double g = s.gap;
        if (Math.abs(g) < 1) return "LEVEL";
        return (g > 0 ? "BEHIND " : "AHEAD ") + WidgetStore.moneyTiny(Math.abs(g));
    }

    private static void bindPill(RemoteViews v, WidgetStore.Snapshot s) {
        String t = pillText(s);
        if (t == null || t.isEmpty()) { hide(v, R.id.w_pill); return; }
        v.setTextViewText(R.id.w_pill, t);
        v.setViewVisibility(R.id.w_pill, View.VISIBLE);
    }

    /**
     * The bottom action bar: what a tap does, and how old the figure is.
     *
     * The as-of time is the honest half. A widget that refreshes every 30 minutes
     * looks live whether or not it is, and "as of 10:46 AM" is the cheapest way to
     * say which. It uses the device's 12/24h preference rather than forcing one.
     */
    private static void bindActionBar(Context ctx, RemoteViews v, WidgetStore.Snapshot s,
                                      Size size, long now) {
        v.setTextViewText(R.id.w_action, "Tap to open");
        if (s.generatedAt <= 0) { v.setTextViewText(R.id.w_asof, "—"); return; }
        // Staleness belongs HERE, not in the header — "as of" is literally the
        // staleness slot, and at 2x2 the header has no room for the FY label at
        // all (see bindMedium), so this is the only place it can be said.
        //
        // The "as of " prefix is dropped at 2x2: 96dp of row, minus "Tap to open",
        // leaves about 50dp, and the prefix pushed the pair into "Tap to o…as of
        // 12:22 PM" with no gap between them. A bare clock in a row labelled
        // "Tap to open" is unambiguous enough.
        String stamp = s.isStale(now)
                ? (staleDays(s, now) + "d old")
                : clock(ctx, s.generatedAt);
        v.setTextViewText(R.id.w_asof,
                (size == Size.LARGE && !s.isStale(now)) ? ("as of " + stamp) : stamp);
    }

    private static long staleDays(WidgetStore.Snapshot s, long now) {
        return Math.max(1, (now - s.generatedAt) / (24L * 60 * 60 * 1000));
    }

    /**
     * Device-preference clock, so a 24h phone is not shown a 12h stamp.
     *
     * is24HourFormat() needs a REAL Context — it reads a per-user setting, and
     * passing null NPEs inside the platform rather than falling back to a default.
     * That is not hypothetical: the first build of this method passed null and
     * every render test that reached the action bar died on it.
     */
    private static String clock(Context ctx, long ms) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat(
                DateFormat.is24HourFormat(ctx) ? "HH:mm" : "h:mm a", Locale.getDefault());
        return f.format(new Date(ms));
    }

    /**
     * The ring — the anchor of the whole redesign, and the thing Steven actually
     * asked for.
     *
     * Drawn to a bitmap because RemoteViews has no arc primitive and cannot size a
     * child view below API 31. Drawn on the worker thread, so it costs the UI
     * nothing. Colours come from resources (see {@link #ringColors}).
     *
     * A null percentage draws the TRACK ALONE rather than nothing: an empty ring
     * says "no goal set" while keeping the card's shape, whereas a hidden ring
     * leaves a hole where the eye has learned to land. It is never drawn as 0% of
     * a goal that does not exist — there is no fill arc at all in that case.
     */
    private static void bindRing(Context ctx, RemoteViews v, WidgetStore.Snapshot s, Size size) {
        int dp = ringDp(size);
        float d = ctx.getResources().getDisplayMetrics().density;
        int px = Math.max(1, (int) (dp * d));
        float stroke = ringStrokeDp(size) * d;

        int[] col = ringColors(ctx);
        Bitmap bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(stroke);
        p.setStrokeCap(Paint.Cap.ROUND);

        float inset = stroke / 2f + 0.5f;
        RectF box = new RectF(inset, inset, px - inset, px - inset);

        p.setColor(col[1]);
        c.drawArc(box, 0, 360, false, p);

        if (s.pct != null) {
            // Clamped, and a floor so a non-zero fraction of a percent still shows
            // a mark. 3% of a circle is 11 degrees — visible, but only just, and a
            // true 0.4% would otherwise round to an invisible nothing while the
            // number beside it says "0%", which reads as a rendering bug.
            double pct = Math.max(0, Math.min(100, s.pct));
            float sweep = (float) (pct / 100.0 * 360.0);
            if (pct > 0) sweep = Math.max(sweep, 6f);
            p.setColor(col[0]);
            // -90 so the ring starts at twelve o'clock, like every progress ring
            // anyone has ever seen. Starting at 0 (three o'clock) reads as broken.
            c.drawArc(box, -90, sweep, false, p);
        }

        v.setImageViewBitmap(R.id.w_ring, bmp);
        v.setViewVisibility(R.id.w_ring, View.VISIBLE);
        v.setViewVisibility(R.id.w_ringwrap, View.VISIBLE);

        // 2x1's ring is 18dp — about three characters of the heavy face before the
        // glyphs touch the stroke, and "100%" is four. Its layout ships the label
        // GONE and this must not resurrect it.
        if (size == Size.SMALL) return;
        if (s.pct == null) { hide(v, R.id.w_ringpct); return; }
        v.setTextViewText(R.id.w_ringpct, String.format(Locale.US, "%.0f%%", s.pct));
        v.setViewVisibility(R.id.w_ringpct, View.VISIBLE);
    }

    /**
     * This week's hours against the weekly goal — solar's "Surplus" slot: the one
     * figure that moves within a day.
     */
    private static void bindWeek(RemoteViews v, WidgetStore.Snapshot s, Size size, long now) {
        // "This week" is dropped at 2x2 — the right-hand column is ~137px there
        // and the full phrase ellipsised to "This week 3…", which loses the
        // number entirely. The bare pair still reads as hours against a goal.
        String week = (size == Size.LARGE ? "This week " : "")
                    + WidgetStore.hours(s.hoursForWeekOf(now, 0));
        if (s.weekGoalHours != null)
            week += " / " + String.format(Locale.US, "%.0fh", s.weekGoalHours);
        v.setTextViewText(R.id.w_week, week);
        v.setViewVisibility(R.id.w_week, View.VISIBLE);
    }

    /**
     * 4x2 only — the glyph row, solar's aux indicators.
     *
     * Each slot hides rather than printing a placeholder when its figure is
     * unknown: the neighbours widen to fill the gap, which is a tidier failure
     * than "💵 $0/hr" claiming he works for nothing. That is the same
     * absence-is-not-zero rule the whole snapshot follows.
     */
    private static void bindAux(RemoteViews v, WidgetStore.Snapshot s) {
        v.setViewVisibility(R.id.w_aux, View.VISIBLE);

        if (s.hoursPerWorkedWeek != null) {
            v.setTextViewText(R.id.w_aux_hours,
                    String.format(Locale.US, "🕐 %.1fh/wk", s.hoursPerWorkedWeek));
            v.setViewVisibility(R.id.w_aux_hours, View.VISIBLE);
        } else hide(v, R.id.w_aux_hours);

        if (s.elapsedWeeks > 0) {
            v.setTextViewText(R.id.w_aux_weeks,
                    "📅 " + s.workedWeeks + " of " + s.elapsedWeeks);
            v.setViewVisibility(R.id.w_aux_weeks, View.VISIBLE);
        } else hide(v, R.id.w_aux_weeks);

        // null, not "$0/hr" — no hours logged means unknown, not free.
        if (s.effectiveRate != null) {
            v.setTextViewText(R.id.w_aux_rate,
                    String.format(Locale.US, "💵 $%.0f/hr", s.effectiveRate));
            v.setViewVisibility(R.id.w_aux_rate, View.VISIBLE);
        } else hide(v, R.id.w_aux_rate);
    }

    /** The label carries staleness, because a stale number that looks live is a lie. */
    private static String label(WidgetStore.Snapshot s, long now) {
        String base = s.fyLabel.isEmpty() ? "" : s.fyLabel;
        if (s.isStale(now)) {
            long days = Math.max(1, (now - s.generatedAt) / (24L * 60 * 60 * 1000));
            return (base.isEmpty() ? "" : base + " · ") + days + "d old";
        }
        return base;
    }

    /**
     * Compact at every size. The ring now carries the percentage, so this line no
     * longer repeats it at 2x2 and 4x2 — it says what the target IS, which is the
     * thing the ring cannot show.
     */
    private static String ofLine(WidgetStore.Snapshot s, Size size) {
        if (s.target == null) return "No goal set";
        // "target" is dropped below 4x2 for the same reason "This week" is: at
        // 2x2 the full phrase came out "of $140k tar…", which is worse than
        // saying less. "of $140k" beside a ring reading 3% is not ambiguous.
        return "of " + WidgetStore.moneyCompact(s.target) + (size == Size.LARGE ? " target" : "");
    }

    /**
     * The last six weeks as bars, drawn to a bitmap because RemoteViews cannot
     * size a child view below API 31 and the widget must work back to API 24.
     * Drawn on the worker thread, so this costs the UI nothing.
     *
     * The current week is highlighted. A week with no bucket draws as an empty
     * track rather than a zero-height bar, so "no days logged" and "a very short
     * week" do not look the same.
     */
    private static void bindBars(Context ctx, RemoteViews v, WidgetStore.Snapshot s,
                                 long now, int wDp, int hDp) {
        List<WidgetStore.Week> weeks = s.weeks;
        // Fewer than two buckets is not a trend. Drawn at all, a lone bucket is
        // normalised against itself and fills the whole strip — which reads
        // exactly like a progress bar sitting at 100%. Showing nothing is the
        // honest rendering of "not enough weeks to compare yet".
        if (weeks == null || weeks.size() < 2) { hide(v, R.id.w_chart); return; }

        int[] col = barColors(ctx);
        float d = ctx.getResources().getDisplayMetrics().density;
        int w = Math.max(1, (int) (wDp * d)), h = Math.max(1, (int) (hDp * d));
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        String thisKey = WidgetStore.mondayKey(now, 0);
        double max = 0;
        for (WidgetStore.Week wk : weeks) max = Math.max(max, wk.hours);
        if (max <= 0) max = 1;

        int n = Math.min(weeks.size(), HIT_IDS.length);
        /*
         * Each week owns an equal SLOT; the bar is centred inside it at a capped
         * width. Dividing the full width between the bars themselves (what v107.0
         * did) is fine at six weeks and awful at three — a wide bar in a short
         * strip stops reading as a bar and starts reading as a button, which is
         * exactly how the first v108.0 render came out.
         *
         * Slots, not bars, are also what keeps this honest with the tap targets:
         * cell i covers slot i and bar i is centred in slot i, so they stay
         * aligned at any week count — and the cell is WIDER than the bar it
         * selects, which makes it the more forgiving target rather than a
         * pixel-hunt.
         */
        float slot = w / (float) n;
        float gap = 3f * d;
        float bw = Math.min(slot - gap, 9f * d);
        float r = Math.min(bw / 2f, 2.5f * d);
        for (int i = 0; i < n; i++) {
            WidgetStore.Week wk = weeks.get(i);
            float left = i * slot + (slot - bw) / 2f;
            float bh = (float) Math.max(0.06, wk.hours / max) * h;
            p.setColor(col[2]);
            c.drawRoundRect(new RectF(left, 0, left + bw, h), r, r, p);
            p.setColor(wk.key.equals(thisKey) ? col[1] : col[0]);
            c.drawRoundRect(new RectF(left, h - bh, left + bw, h), r, r, p);
        }
        v.setImageViewBitmap(R.id.w_bars, bmp);
        v.setViewVisibility(R.id.w_bars, View.VISIBLE);
        v.setViewVisibility(R.id.w_chart, View.VISIBLE);
        bindBarTaps(ctx, v, weeks, n);
    }

    /**
     * One tap target per drawn bar, opening the Log on that week.
     *
     * The cells are laid over the bitmap and divide the same width evenly, which
     * is the only reason cell i lines up with bar i — the bitmap loop above uses
     * the identical `n`, so the two cannot drift apart without both changing.
     *
     * Cells past `n` are hidden rather than left inert: a GONE view cannot be
     * tapped, whereas a visible one with a stale intent from a previous update
     * would happily open a week that has since fallen off the end of the chart.
     */
    private static void bindBarTaps(Context ctx, RemoteViews v, List<WidgetStore.Week> weeks, int n) {
        v.setViewVisibility(R.id.w_hits, View.VISIBLE);
        for (int i = 0; i < HIT_IDS.length; i++) {
            if (i < n) {
                v.setViewVisibility(HIT_IDS[i], View.VISIBLE);
                v.setOnClickPendingIntent(HIT_IDS[i], openWeekIntent(ctx, weeks.get(i).key, i));
            } else {
                hide(v, HIT_IDS[i]);
            }
        }
    }

    /**
     * The three bar colours for the current configuration: {fill, current, track}.
     *
     * Read from resources rather than held as constants so values-night (and the
     * Material You overlay on API 31+) applies. See the class comment for why
     * resolving these in our process is sound.
     */
    static int[] barColors(Context ctx) {
        return new int[] {
            ctx.getColor(R.color.widget_bar_fill),
            ctx.getColor(R.color.widget_bar_current),
            ctx.getColor(R.color.widget_bar_track)
        };
    }

    /** The two ring colours: {fill, track}. Same rule as {@link #barColors}. */
    static int[] ringColors(Context ctx) {
        return new int[] {
            ctx.getColor(R.color.widget_ring_fill),
            ctx.getColor(R.color.widget_ring_track)
        };
    }

    private static void hide(RemoteViews v, int id) { v.setViewVisibility(id, View.GONE); }

    /**
     * Tap opens the app on Stats. FLAG_IMMUTABLE is mandatory from API 31 and
     * harmless before it — an omitted mutability flag is a hard crash on 31+.
     */
    static PendingIntent openStatsIntent(Context ctx) {
        return activity(ctx, ROOT_RC, "analytics", null);
    }

    /**
     * Tap a bar, open the Log on that week. `index` only exists to keep the
     * request codes distinct — see BAR_RC for what happens when they are not.
     */
    static PendingIntent openWeekIntent(Context ctx, String weekKey, int index) {
        return activity(ctx, BAR_RC + index, "log", weekKey);
    }

    private static PendingIntent activity(Context ctx, int requestCode, String screen, String weekKey) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setAction(Intent.ACTION_MAIN);
        i.addCategory(Intent.CATEGORY_LAUNCHER);
        i.putExtra(MainActivity.EXTRA_OPEN_SCREEN, screen);
        if (weekKey != null) i.putExtra(MainActivity.EXTRA_OPEN_WEEK, weekKey);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        // FLAG_UPDATE_CURRENT matters as much as the distinct request code: the
        // week a given bar points at changes every time the chart scrolls forward,
        // and without it the extras of the FIRST intent ever created would stick.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(ctx, requestCode, i, flags);
    }
}
