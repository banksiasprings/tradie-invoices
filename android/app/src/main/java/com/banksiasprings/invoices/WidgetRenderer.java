package com.banksiasprings.invoices;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Build;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import java.util.List;
import java.util.Locale;

/**
 * v107.0 — turns a {@link WidgetStore.Snapshot} into RemoteViews.
 *
 * Runs on a background thread (see {@link WidgetRefreshWorker}); nothing here
 * touches the UI thread.
 *
 * Colour rule: every colour a TextView or background uses is referenced from the
 * LAYOUT XML, never set programmatically. RemoteViews are inflated in the
 * launcher's process with the LAUNCHER's configuration, so a colour baked in
 * from our process would ignore the system theme and strand the widget in the
 * wrong mode.
 *
 * The bar bitmap is the ONE exception, because it needs a Canvas. v107.0 handled
 * that by drawing it in a single amber that read acceptably on the navy card it
 * used in both themes. v108.0 made the card follow the system theme — cream by
 * day, charcoal by night — and that trick died with it: the old translucent-white
 * bar track is invisible on cream, and raw brand amber fails contrast on it. So
 * the bar colours are now RESOLVED FROM RESOURCES (see {@link #barColors}), which
 * means values-night applies to them exactly as it does to the layout.
 *
 * That resolution happens in OUR process, so it assumes our configuration's night
 * mode matches the launcher's. For system-wide dark mode — the only way Android
 * exposes this to a user — that holds. It is the single place in this class where
 * the launcher's theme is inferred rather than deferred to, and it is confined to
 * three colours inside one bitmap.
 *
 * Language rule: this surface never says "on track", "on pace" or "caught up".
 * A glanceable widget is exactly where a soft word gets read as a fact, so the
 * verdict is always a signed distance, computed by the app and passed through
 * verbatim in `gapText`.
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

    public static RemoteViews build(Context ctx, WidgetStore.Snapshot s, Size size, long now) {
        int layout = size == Size.SMALL ? R.layout.widget_goal_small
                : size == Size.MEDIUM ? R.layout.widget_goal_medium
                : R.layout.widget_goal_large;
        RemoteViews v = new RemoteViews(ctx.getPackageName(), layout);

        // Whole card opens the app on Stats. One target for every size — a widget
        // with regions that do different things is a menu, not a glance.
        v.setOnClickPendingIntent(R.id.widget_root, openStatsIntent(ctx));

        if (!s.present || !s.hasData) {
            bindEmpty(v, s, size);
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
    private static void bindEmpty(RemoteViews v, WidgetStore.Snapshot s, Size size) {
        // Short by necessity, and deliberately DIFFERENT wording for the two
        // states: "nothing has ever been written" and "nothing confirmed this
        // year" are different problems with different fixes.
        String head = !s.present ? "Open the app" : "No days yet";
        String sub  = !s.present
                ? "to start tracking"
                : (s.fyLabel.isEmpty() ? "this financial year" : "in " + s.fyLabel);

        setHeadline(v, size, head);
        v.setTextViewText(R.id.w_of, sub);
        v.setViewVisibility(R.id.w_of, View.VISIBLE);

        // 2x1 carries neither a label nor a progress bar — see widget_goal_small.
        if (size == Size.SMALL) return;

        v.setTextViewText(R.id.w_label, "🎯 Retained");
        hide(v, R.id.w_bar);
        // The CONTAINER, not just the bitmap: v108.0 put the bar image inside a
        // FrameLayout with six invisible tap cells over it. Hiding only the image
        // would leave those cells live over blank space, so an empty widget would
        // still fire "open week ___" for a week that does not exist.
        hide(v, R.id.w_chart);
        hide(v, R.id.w_week);
        if (size == Size.LARGE) {
            hide(v, R.id.w_gap); hide(v, R.id.w_note);
            hide(v, R.id.w_milestones); hide(v, R.id.w_rate);
        }
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
     */
    private static void setHeadline(RemoteViews v, Size size, String text) {
        // Must match the textSize in each layout — the slot heights were sized
        // around these, and 24sp in a 23dp box clipped the glyphs top and bottom.
        float base = size == Size.SMALL ? 15f : size == Size.MEDIUM ? 20f : 26f;
        int   cap  = size == Size.SMALL ? 9 : size == Size.MEDIUM ? 7 : 6;
        float min  = size == Size.SMALL ? 9f : 11f;
        int   n    = Math.max(1, text.length());
        float sp   = n <= cap ? base : Math.max(min, base * cap / (float) n);
        v.setTextViewTextSize(R.id.w_big, TypedValue.COMPLEX_UNIT_SP, sp);
        v.setTextViewText(R.id.w_big, text);
        v.setViewVisibility(R.id.w_big, View.VISIBLE);
    }

    /**
     * 2x1 — the headline and its qualifier, and nothing else: 40dp of cell height
     * leaves room for exactly two short lines. The FY label and the progress bar
     * are not hidden here, they are ABSENT FROM THE LAYOUT, so this must not try
     * to address them.
     */
    private static void bindSmall(Context ctx, RemoteViews v, WidgetStore.Snapshot s, long now) {
        setHeadline(v, Size.SMALL, WidgetStore.moneyCompact(s.retained));
        v.setTextViewText(R.id.w_of, ofLine(s));
        v.setViewVisibility(R.id.w_of, View.VISIBLE);
    }

    // ── 2x2 — headline, progress, this week, and the six-week shape. ────────────
    private static void bindMedium(Context ctx, RemoteViews v, WidgetStore.Snapshot s, long now) {
        v.setTextViewText(R.id.w_label, label(s, now));
        setHeadline(v, Size.MEDIUM, WidgetStore.moneyCompact(s.retained));
        v.setTextViewText(R.id.w_of, ofLine(s));
        v.setViewVisibility(R.id.w_of, View.VISIBLE);
        bindProgress(v, s);
        bindWeek(v, s, now);
        bindBars(ctx, v, s, now, 120, 22);
    }

    // ── 4x2 — room to say what the number is made of, so it does. ───────────────
    private static void bindLarge(Context ctx, RemoteViews v, WidgetStore.Snapshot s, long now) {
        v.setTextViewText(R.id.w_label, label(s, now));
        setHeadline(v, Size.LARGE, WidgetStore.money(s.retained));
        v.setTextViewText(R.id.w_of, ofLine(s));
        v.setViewVisibility(R.id.w_of, View.VISIBLE);
        bindProgress(v, s);
        bindWeek(v, s, now);
        bindRate(v, s);
        bindBars(ctx, v, s, now, 66, 16);

        // The verdict, unsoftened and unedited — the app computed the wording.
        if (s.gapText != null && !s.gapText.isEmpty()) {
            v.setTextViewText(R.id.w_gap, s.gapText);
            v.setViewVisibility(R.id.w_gap, View.VISIBLE);
        } else hide(v, R.id.w_gap);

        // Earned, never unconditional: a steady operator well into the year gets none.
        if (s.paceNote != null && !s.paceNote.isEmpty()) {
            v.setTextViewText(R.id.w_note, s.paceNote);
            v.setViewVisibility(R.id.w_note, View.VISIBLE);
        } else hide(v, R.id.w_note);

        if (!s.milestones.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            for (WidgetStore.Milestone m : s.milestones) {
                if (sb.length() > 0) sb.append("  ");
                sb.append(m.reached ? "✓ " : "○ ").append(WidgetStore.moneyTiny(m.usd));
            }
            v.setTextViewText(R.id.w_milestones, sb.toString());
            v.setViewVisibility(R.id.w_milestones, View.VISIBLE);
        } else hide(v, R.id.w_milestones);
    }

    private static void bindProgress(RemoteViews v, WidgetStore.Snapshot s) {
        if (s.pct == null) { hide(v, R.id.w_bar); return; }
        v.setViewVisibility(R.id.w_bar, View.VISIBLE);
        v.setProgressBar(R.id.w_bar, 100, (int) Math.round(s.pct), false);
    }

    /**
     * This week's hours against the weekly goal. Split from the rate rather than
     * flagged: 2x2 has room for one of the two, 4x2 for both, and a boolean
     * argument threading that through one function was harder to read than two
     * functions each doing one thing.
     */
    private static void bindWeek(RemoteViews v, WidgetStore.Snapshot s, long now) {
        String week = "This week " + WidgetStore.hours(s.hoursForWeekOf(now, 0));
        if (s.weekGoalHours != null)
            week += " / " + String.format(Locale.US, "%.0fh", s.weekGoalHours);
        v.setTextViewText(R.id.w_week, week);
        v.setViewVisibility(R.id.w_week, View.VISIBLE);
    }

    /**
     * 4x2 only. The effective rate is an all-time figure that moves very slowly,
     * so at 2x2 — where it would have pushed the week line into an ellipsis — it
     * is simply left out rather than shortened into something unreadable.
     */
    private static void bindRate(RemoteViews v, WidgetStore.Snapshot s) {
        // null, not "$0/hr" — no hours logged means unknown, not free.
        if (s.effectiveRate == null) { hide(v, R.id.w_rate); return; }
        v.setTextViewText(R.id.w_rate, String.format(Locale.US, "$%.0f/hr", s.effectiveRate));
        v.setViewVisibility(R.id.w_rate, View.VISIBLE);
    }

    /** The label carries staleness, because a stale number that looks live is a lie. */
    private static String label(WidgetStore.Snapshot s, long now) {
        String base = "🎯 " + (s.fyLabel.isEmpty() ? "Retained" : s.fyLabel + " retained");
        if (s.isStale(now)) {
            long days = Math.max(1, (now - s.generatedAt) / (24L * 60 * 60 * 1000));
            return base + " · " + days + "d old";
        }
        return base;
    }

    /**
     * Compact at every size. The longer "· $136k to go" form was tried and
     * ellipsised even in the 4x2 column, and the card already carries "Behind by
     * $8,797" — which says the same thing against the calendar rather than against
     * the whole year, and is the more useful of the two.
     */
    private static String ofLine(WidgetStore.Snapshot s) {
        if (s.target == null || s.pct == null) return "No goal set";
        return "of " + WidgetStore.moneyCompact(s.target)
             + " · " + String.format(Locale.US, "%.0f%%", s.pct);
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
        // normalised against itself and fills the whole strip — which on a dark
        // card reads exactly like a progress bar sitting at 100%. Showing nothing
        // is the honest rendering of "not enough weeks to compare yet".
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
         * did) is fine at six weeks and awful at three — a 28dp-wide bar in an
         * 18dp-tall strip stops reading as a bar and starts reading as a button,
         * which is exactly how the first v108.0 render came out.
         *
         * Slots, not bars, are also what keeps this honest with the tap targets:
         * cell i covers slot i and bar i is centred in slot i, so they stay
         * aligned at any week count — and the cell is WIDER than the bar it
         * selects, which makes it the more forgiving target rather than a
         * pixel-hunt.
         */
        float slot = w / (float) n;
        float gap = 3f * d;
        // 9dp: the strip is only 18-20dp tall, so anything wider than about half
        // that reads as a tile rather than a bar. At six weeks the slot is
        // narrower than the cap anyway and this has no effect; it is there for
        // the early-financial-year case, which is the one Steven is in.
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
     * Material You overlay on API 31+) applies. This is the one place the widget
     * resolves a colour in our process — see the class comment for why that is
     * sound, and why v107.0's single hard-coded amber stopped being.
     */
    static int[] barColors(Context ctx) {
        return new int[] {
            ctx.getColor(R.color.widget_bar_fill),
            ctx.getColor(R.color.widget_bar_current),
            ctx.getColor(R.color.widget_bar_track)
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
