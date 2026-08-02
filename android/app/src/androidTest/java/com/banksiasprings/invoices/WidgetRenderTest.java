package com.banksiasprings.invoices;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import android.widget.TextView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;

/**
 * v107.0 — renders the home-screen widget at every supported size, in light and
 * dark, and writes a PNG of each.
 *
 * This is not only a screenshot generator. RemoteViews validates lazily: a
 * setTextViewText or setViewVisibility aimed at an id that does not exist in the
 * chosen layout throws only when the host APPLIES it — so on a real phone the
 * widget would simply fail to draw, with the reason buried in the launcher's
 * logcat, not ours. apply() here is the same call the launcher makes, so every
 * action in every state is exercised on the way to the image.
 *
 * The states covered are the ones that actually differ in what they may touch:
 * a full snapshot, a fresh install (nothing written), and confirmed-days-but-no-
 * goal — the last two being the paths where most of the views are hidden.
 *
 * v108.0 closed two false greens in this harness:
 *
 *  1. It rendered light AND dark and asserted NOTHING about the difference. With
 *     v107.0's near-identical navy pair that was nearly true by accident; now
 *     that the card follows the system theme it would have been the whole
 *     feature going untested. themesActuallyDiffer() compares the pixels.
 *
 *  2. Layout overflow was documented as "re-run this and LOOK at the PNG".
 *     A test whose failure mode is a human noticing is not a test.
 *     assertNothingSqueezed() measures every visible child after layout and
 *     fails on a zero-height view or a TextView too short for its own glyphs —
 *     which are exactly the two ways this layout has silently broken before.
 *
 * Run: ./gradlew :app:connectedDebugAndroidTest
 *
 * Output: the app's INTERNAL files dir, /data/data/com.banksiasprings.invoices/
 * files/widget-shots/. It used to be getExternalFilesDir(), which on an API 30+
 * production image the shell user cannot list at all — so the PNGs were written,
 * the assertions passed, and `adb pull` reported the directory did not exist.
 * Internal storage is reachable on a debuggable build:
 *
 *   adb exec-out run-as com.banksiasprings.invoices \
 *       cat files/widget-shots/4x2-dark.png > 4x2-dark.png
 */
@RunWith(AndroidJUnit4.class)
public class WidgetRenderTest {

    /** Steven's real FY2026-27 shape, as buildWidgetSnapshot() emits it. */
    private static final String REAL_JSON =
        "{\"v\":1,\"generatedAt\":" + System.currentTimeMillis() + ",\"fyLabel\":\"FY2026–27\","
      + "\"state\":\"behind\",\"hasData\":true,\"retained\":3932,\"target\":140400,"
      + "\"pct\":2.8005698,\"remaining\":136468,\"gap\":8796.57,"
      + "\"gapText\":\"Behind by $8,797 on a straight-line target.\","
      + "\"paceNote\":\"3 of 5 weeks had hours — 21.8h/wk, $1,311 each.\","
      + "\"weekGoalHours\":45,\"effectiveRate\":60,\"workedWeeks\":3,\"elapsedWeeks\":5,"
      + "\"hoursPerWorkedWeek\":21.843,"
      + "\"milestones\":[{\"usd\":46800,\"label\":\"first third\",\"reached\":false,\"at\":33.3},"
      + "{\"usd\":93600,\"label\":\"two thirds\",\"reached\":false,\"at\":66.7},"
      + "{\"usd\":140400,\"label\":\"goal\",\"reached\":false,\"at\":100}],"
      + "\"weeks\":[{\"k\":\"2026-06-29\",\"h\":15.75,\"r\":945},"
      + "{\"k\":\"2026-07-06\",\"h\":17.5,\"r\":1050},"
      + "{\"k\":\"" + WidgetStore.mondayKey(System.currentTimeMillis(), 0) + "\",\"h\":32.28,\"r\":1937}]}";

    private static final String NO_GOAL_JSON =
        "{\"v\":1,\"generatedAt\":" + System.currentTimeMillis() + ",\"fyLabel\":\"FY2026–27\","
      + "\"state\":\"no-target\",\"hasData\":true,\"retained\":3932,\"target\":null,"
      + "\"pct\":null,\"remaining\":null,\"gap\":null,"
      + "\"gapText\":\"No earnings goal set.\",\"paceNote\":null,"
      + "\"weekGoalHours\":45,\"effectiveRate\":60,\"workedWeeks\":3,\"elapsedWeeks\":5,"
      + "\"milestones\":[],\"weeks\":[{\"k\":\"" + WidgetStore.mondayKey(System.currentTimeMillis(), 0)
      + "\",\"h\":32.28,\"r\":1937}]}";

    private static final int[][] SIZES = {
        // label index, width dp, height dp — Android's cell arithmetic is 70n-30.
        { 0, 110, 40 }, { 1, 110, 110 }, { 2, 250, 110 }
    };
    private static final String[] SIZE_NAMES = { "2x1", "2x2", "4x2" };
    private static final WidgetRenderer.Size[] SIZE_ENUM = {
        WidgetRenderer.Size.SMALL, WidgetRenderer.Size.MEDIUM, WidgetRenderer.Size.LARGE
    };

    @Test
    public void rendersEverySizeInBothThemes() throws Exception {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File dir = new File(app.getFilesDir(), "widget-shots");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();

        long now = System.currentTimeMillis();
        int written = 0;

        for (boolean night : new boolean[] { false, true }) {
            Context ctx = themed(app, night);
            String mode = night ? "dark" : "light";

            for (int[] sz : SIZES) {
                int i = sz[0];

                // 1 — the real snapshot.
                WidgetStore.save(app, REAL_JSON);
                WidgetStore.Snapshot real = WidgetStore.load(app);
                assertTrue("fixture must parse", real.present && real.hasData);
                assertEquals(140400.0, real.target, 0.001);
                shoot(ctx, WidgetRenderer.build(ctx, real, SIZE_ENUM[i], now),
                      sz[1], sz[2], new File(dir, SIZE_NAMES[i] + "-" + mode + ".png"));
                written++;

                // 2 — fresh install: nothing has ever been written. Must not read
                //     as "$0.00 earned", and must not throw for want of a view.
                WidgetStore.save(app, "");
                WidgetStore.Snapshot empty = WidgetStore.load(app);
                assertTrue("a fresh install has no snapshot", !empty.present);
                shoot(ctx, WidgetRenderer.build(ctx, empty, SIZE_ENUM[i], now),
                      sz[1], sz[2], new File(dir, SIZE_NAMES[i] + "-" + mode + "-empty.png"));
                written++;

                // 3 — days confirmed but no goal set: a different state again, and
                //     the one where the progress bar and milestones must vanish.
                WidgetStore.save(app, NO_GOAL_JSON);
                WidgetStore.Snapshot noGoal = WidgetStore.load(app);
                assertNotNull(noGoal);
                assertTrue("no target must stay null, never 0", noGoal.target == null);
                shoot(ctx, WidgetRenderer.build(ctx, noGoal, SIZE_ENUM[i], now),
                      sz[1], sz[2], new File(dir, SIZE_NAMES[i] + "-" + mode + "-nogoal.png"));
                written++;
            }
        }
        assertEquals("3 sizes x 3 states x 2 themes", 18, written);
    }

    /**
     * v108.0 — the theme must actually change something.
     *
     * The loop above has rendered light and dark since v107.0 and asserted no
     * difference between them, which is a test that would pass with values-night
     * deleted. Steven's whole ask was "follow the system theme", so the thing to
     * assert is that the pixels move.
     *
     * Mean luminance, not an exact hash: on API 31+ these colours come from the
     * wallpaper, so the specific values are not knowable here. What IS knowable is
     * the direction — a day card is lighter than a night card, at every size.
     */
    @Test
    public void themesActuallyDiffer() throws Exception {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File dir = new File(app.getFilesDir(), "widget-shots");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        WidgetStore.save(app, REAL_JSON);
        WidgetStore.Snapshot s = WidgetStore.load(app);
        long now = System.currentTimeMillis();

        for (int[] sz : SIZES) {
            int i = sz[0];
            double light = meanLuma(shoot(themed(app, false), WidgetRenderer.build(themed(app, false), s, SIZE_ENUM[i], now),
                    sz[1], sz[2], new File(dir, "cmp-" + SIZE_NAMES[i] + "-light.png")));
            double dark = meanLuma(shoot(themed(app, true), WidgetRenderer.build(themed(app, true), s, SIZE_ENUM[i], now),
                    sz[1], sz[2], new File(dir, "cmp-" + SIZE_NAMES[i] + "-dark.png")));
            assertTrue(SIZE_NAMES[i] + ": day card must be lighter than the night card"
                       + " (light=" + light + " dark=" + dark + ")", light > dark + 0.15);
        }
    }

    /**
     * v108.0 — the bar colours are the one thing the widget resolves in OUR
     * process, so they are the one thing that could silently stay in day colours
     * on a night home screen. Assert they move with the configuration.
     */
    @Test
    public void barColoursFollowTheConfiguration() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        int[] day = WidgetRenderer.barColors(themed(app, false));
        int[] night = WidgetRenderer.barColors(themed(app, true));
        assertTrue("bar fill must differ between themes", day[0] != night[0]);
        assertTrue("bar track must differ between themes", day[2] != night[2]);
        for (int[] set : new int[][] { day, night }) {
            assertTrue("the current-week bar must be distinguishable from the rest",
                       set[0] != set[1]);
            assertTrue("a bar must not be the same colour as its own track",
                       set[0] != set[2]);
        }
    }

    /**
     * v108.0 — one tap target per drawn bar, and they must be DISTINCT.
     *
     * PendingIntent identity ignores extras, so six bars sharing a request code
     * collapse into one and every bar opens the same week. Nothing throws; the
     * widget just lies. This asserts the request codes do their job — and asserts
     * the CONTROL (same index, different week => equal) so it cannot pass for the
     * wrong reason.
     */
    @Test
    public void everyWeekBarGetsItsOwnTapTarget() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertTrue("different bars must be different PendingIntents",
                   !WidgetRenderer.openWeekIntent(app, "2026-07-06", 0)
                        .equals(WidgetRenderer.openWeekIntent(app, "2026-07-13", 1)));
        // CONTROL: extras are NOT part of PendingIntent identity. If this were
        // false, the assertion above would prove nothing about the request codes.
        assertEquals("PendingIntent identity ignores extras — the request code is"
                     + " the only thing keeping the bars apart",
                     WidgetRenderer.openWeekIntent(app, "2026-07-06", 0),
                     WidgetRenderer.openWeekIntent(app, "2026-08-03", 0));
        assertTrue("a bar must not collide with the whole-card tap",
                   !WidgetRenderer.openWeekIntent(app, "2026-07-06", 0)
                        .equals(WidgetRenderer.openStatsIntent(app)));

        // 3 weeks in the fixture => 3 live cells, the other 3 gone (a visible cell
        // with a stale intent would open a week no longer on the chart).
        WidgetStore.save(app, REAL_JSON);
        WidgetStore.Snapshot s = WidgetStore.load(app);
        assertEquals("fixture shape", 3, s.weeks.size());
        for (int i : new int[] { 1, 2 }) {                       // MEDIUM, LARGE
            View v = WidgetRenderer.build(app, s, SIZE_ENUM[i], System.currentTimeMillis())
                                   .apply(app, new FrameLayout(app));
            assertEquals(SIZE_NAMES[i] + ": one live cell per drawn bar",
                         3, visibleHits(v));
        }
    }

    private static int visibleHits(View root) {
        int[] ids = { R.id.w_hit0, R.id.w_hit1, R.id.w_hit2, R.id.w_hit3, R.id.w_hit4, R.id.w_hit5 };
        int n = 0;
        for (int id : ids) {
            View c = root.findViewById(id);
            if (c != null && c.getVisibility() == View.VISIBLE) n++;
        }
        return n;
    }

    private static double meanLuma(Bitmap b) {
        long acc = 0; int n = 0;
        for (int y = 0; y < b.getHeight(); y += 3) {
            for (int x = 0; x < b.getWidth(); x += 3) {
                int p = b.getPixel(x, y);
                acc += (int) (0.2126 * ((p >> 16) & 0xFF) + 0.7152 * ((p >> 8) & 0xFF) + 0.0722 * (p & 0xFF));
                n++;
            }
        }
        return n == 0 ? 0 : (acc / (double) n) / 255.0;
    }

    /** A malformed blob must render the empty state, not crash the launcher. */
    @Test
    public void corruptSnapshotRendersEmptyStateRatherThanThrowing() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        WidgetStore.save(app, "{not json at all");
        WidgetStore.Snapshot s = WidgetStore.load(app);
        assertTrue("a corrupt blob is indistinguishable from none", !s.present);
        for (int i = 0; i < SIZES.length; i++) {
            RemoteViews rv = WidgetRenderer.build(app, s, SIZE_ENUM[i], System.currentTimeMillis());
            View v = rv.apply(app, new FrameLayout(app));   // throws if any action is invalid
            assertNotNull(v);
        }
    }

    /** The one thing native derives for itself must agree with the JS bucketing. */
    @Test
    public void mondayKeyMatchesTheBucketsJsWrites() {
        // 2026-08-03 is a Monday; 2026-08-02 the Sunday before it.
        long mon = java.util.concurrent.TimeUnit.DAYS.toMillis(0) + parse(2026, 8, 3);
        long sun = parse(2026, 8, 2);
        assertEquals("2026-08-03", WidgetStore.mondayKey(mon, 0));
        assertEquals("Sunday belongs to the week that started six days earlier",
                     "2026-07-27", WidgetStore.mondayKey(sun, 0));
        assertEquals("one week back", "2026-07-27", WidgetStore.mondayKey(mon, 1));
    }

    private static long parse(int y, int m, int d) {
        java.util.Calendar c = java.util.Calendar.getInstance();
        c.set(y, m - 1, d, 12, 0, 0);
        c.set(java.util.Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    /** A context carrying the night (or day) configuration, so values-night applies. */
    private static Context themed(Context base, boolean night) {
        Configuration c = new Configuration(base.getResources().getConfiguration());
        c.uiMode = (c.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                 | (night ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
        return base.createConfigurationContext(c);
    }

    /**
     * apply() is exactly what the launcher does, so an action naming a view the
     * chosen layout does not contain fails HERE rather than silently on a phone.
     */
    private static Bitmap shoot(Context ctx, RemoteViews rv, int wDp, int hDp, File out) throws Exception {
        DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int w = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, wDp, dm);
        int h = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, hDp, dm);

        ViewGroup parent = new FrameLayout(ctx);
        View v = rv.apply(ctx, parent);
        v.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                  View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
        v.layout(0, 0, w, h);

        assertNothingSqueezed(v, out.getName());

        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        v.draw(new Canvas(bmp));
        try (FileOutputStream fos = new FileOutputStream(out)) {
            bmp.compress(Bitmap.CompressFormat.PNG, 100, fos);
        }
        assertTrue("wrote " + out.getName(), out.length() > 0);
        return bmp;
    }

    /**
     * The layout-overflow detector this file used to leave to the reader.
     *
     * LinearLayout resolves an over-budget column by shrinking the last children
     * toward zero. It does not warn, and the widget still "renders" — it just
     * renders without the rows at the bottom, or with a headline whose glyphs are
     * cut off top and bottom. Both have shipped here before (see the sizing notes
     * in widget_goal_medium.xml and widget_goal_large.xml).
     *
     * So: any VISIBLE view must have real area, and any visible TextView carrying
     * text must be at least as tall as the text it was asked to draw.
     */
    private static void assertNothingSqueezed(View v, String tag) {
        if (v.getVisibility() != View.VISIBLE) return;   // GONE is a decision, not a squeeze

        if (v.getId() != View.NO_ID) {
            assertTrue(tag + ": visible view " + idName(v) + " was squeezed to zero height",
                       v.getHeight() > 0);
            assertTrue(tag + ": visible view " + idName(v) + " was squeezed to zero width",
                       v.getWidth() > 0);
        }
        if (v instanceof TextView) {
            TextView t = (TextView) v;
            CharSequence s = t.getText();
            if (s != null && s.length() > 0) {
                // 0.95 rather than 1.0: a tight-but-legible box is normal, a box
                // shorter than the glyphs is the failure being caught.
                assertTrue(tag + ": " + idName(v) + " is " + t.getHeight()
                           + "px tall for " + t.getTextSize() + "px text — clipped",
                           t.getHeight() >= t.getTextSize() * 0.95f);
            }
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) assertNothingSqueezed(g.getChildAt(i), tag);
        }
    }

    private static String idName(View v) {
        try { return v.getResources().getResourceEntryName(v.getId()); }
        catch (Exception e) { return "id#" + v.getId(); }
    }
}
