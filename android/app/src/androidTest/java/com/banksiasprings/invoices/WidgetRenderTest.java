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
 * Run: ./gradlew :app:connectedDebugAndroidTest
 * Output: /sdcard/Android/data/com.banksiasprings.invoices/files/widget-shots/
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
        File dir = new File(app.getExternalFilesDir(null), "widget-shots");
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
    private static void shoot(Context ctx, RemoteViews rv, int wDp, int hDp, File out) throws Exception {
        DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int w = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, wDp, dm);
        int h = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, hDp, dm);

        ViewGroup parent = new FrameLayout(ctx);
        View v = rv.apply(ctx, parent);
        v.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                  View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
        v.layout(0, 0, w, h);

        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        v.draw(new Canvas(bmp));
        try (FileOutputStream fos = new FileOutputStream(out)) {
            bmp.compress(Bitmap.CompressFormat.PNG, 100, fos);
        }
        assertTrue("wrote " + out.getName(), out.length() > 0);
    }
}
