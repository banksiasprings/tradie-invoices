package com.banksiasprings.invoices;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
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
import java.util.Locale;

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

    // ═══ v108.2 — the solar-style redesign ═════════════════════════════════════

    /**
     * The ring is drawn at a pixel size chosen in Java ({@link WidgetRenderer#ringDp})
     * and displayed in a FrameLayout sized in XML. NOTHING connects those two
     * numbers but a developer remembering both, and when they drift the ImageView
     * silently rescales the bitmap — a soft, slightly wrong ring that no assertion
     * about visibility would ever catch.
     *
     * So: the bitmap's intrinsic size must equal the view it lands in, at every
     * size, with a 1px tolerance for dp rounding.
     */
    @Test
    public void ringBitmapMatchesItsSlotAtEverySize() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        WidgetStore.save(app, REAL_JSON);
        WidgetStore.Snapshot s = WidgetStore.load(app);
        float d = app.getResources().getDisplayMetrics().density;
        long now = System.currentTimeMillis();

        for (int[] sz : SIZES) {
            int i = sz[0];
            View v = renderLaidOut(app, s, SIZE_ENUM[i], sz[1], sz[2], now);
            android.widget.ImageView iv = v.findViewById(R.id.w_ring);
            assertNotNull(SIZE_NAMES[i] + ": the ring must be in the layout", iv);
            assertEquals(SIZE_NAMES[i] + ": the ring must be visible", View.VISIBLE, iv.getVisibility());
            assertNotNull(SIZE_NAMES[i] + ": the ring must carry a bitmap", iv.getDrawable());

            int want = Math.max(1, (int) (WidgetRenderer.ringDp(SIZE_ENUM[i]) * d));
            int bmp  = iv.getDrawable().getIntrinsicWidth();
            assertTrue(SIZE_NAMES[i] + ": ring bitmap is " + bmp + "px for a "
                       + WidgetRenderer.ringDp(SIZE_ENUM[i]) + "dp ring (expected " + want + ")",
                       Math.abs(bmp - want) <= 1);
            assertTrue(SIZE_NAMES[i] + ": ring bitmap (" + bmp + "px) does not match its slot ("
                       + iv.getWidth() + "px) — the layout and ringDp() have drifted",
                       Math.abs(bmp - iv.getWidth()) <= 1);
            assertTrue(SIZE_NAMES[i] + ": the ring must be square", iv.getWidth() == iv.getHeight());
        }
    }

    /**
     * A ring the same colour as the card it sits on is not a ring.
     *
     * WCAG 2.1 asks 3:1 of a non-text graphic that carries meaning, and this one
     * carries the whole progress figure. Both colours are real resources, so the
     * ratio is computable here — unlike the Material You overlay on API 31+, where
     * they come from the wallpaper and only the rendered PNG can settle it. That
     * is why this also asserts the drawn pixels differ from the background, which
     * holds on every API.
     */
    @Test
    public void ringIsDistinguishableFromTheCardInBothThemes() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        for (boolean night : new boolean[] { false, true }) {
            Context ctx = themed(app, night);
            String mode = night ? "dark" : "light";
            int[] ring = WidgetRenderer.ringColors(ctx);
            int card = ctx.getColor(R.color.widget_bg);

            double fillVsCard = contrast(ring[0], card);
            assertTrue(mode + ": ring fill vs card is " + fillVsCard + ":1, under the 3:1"
                       + " WCAG asks of a meaningful graphic", fillVsCard >= 3.0);
            assertTrue(mode + ": the ring fill must differ from its own track", ring[0] != ring[1]);
            double trackVsCard = contrast(ring[1], card);
            assertTrue(mode + ": the ring TRACK must be visible against the card too"
                       + " (an invisible track makes a part-filled ring unreadable) — "
                       + trackVsCard + ":1", trackVsCard >= 1.2);
        }
        // The colours must actually move with the theme — the ring is drawn in OUR
        // process, so this is the same failure mode the bars had before v108.0.
        assertTrue("ring fill must differ between themes",
                   WidgetRenderer.ringColors(themed(app, false))[0]
                   != WidgetRenderer.ringColors(themed(app, true))[0]);
    }

    /**
     * The primary number must never be truncated.
     *
     * `w_big` is singleLine with no ellipsize, so an over-long string does not get
     * a "…" — it is simply CLIPPED mid-glyph, which looks like a rendering bug
     * rather than a layout one. v107.0 shipped "$3,9…" this way and it took a PNG
     * to notice. WidgetRenderer.setHeadline() scales the text down to fit; this
     * asserts the scaling actually worked, in every state, at every size.
     */
    @Test
    public void noTextIsTruncatedAtAnySize() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        long now = System.currentTimeMillis();
        String[] states = { REAL_JSON, "", NO_GOAL_JSON };
        String[] names  = { "real", "fresh-install", "no-goal" };

        for (boolean night : new boolean[] { false, true }) {
            Context ctx = themed(app, night);
            for (int st = 0; st < states.length; st++) {
                WidgetStore.save(app, states[st]);
                WidgetStore.Snapshot s = WidgetStore.load(app);
                for (int[] sz : SIZES) {
                    int i = sz[0];
                    View v = renderLaidOut(ctx, s, SIZE_ENUM[i], sz[1], sz[2], now);
                    String where = SIZE_NAMES[i] + "/" + names[st] + (night ? "/dark" : "/light");
                    // EVERY slot, not just the headline. The 2x2 build that
                    // preceded this shipped three ellipses at once — "of $140k
                    // tar…", "This week 3…", "Tap to o…" — and only the headline
                    // was being checked, so the suite was green. An ellipsis is a
                    // layout failure wherever it lands; the fix is shorter copy at
                    // that size, which is what ofLine()/bindWeek() now do.
                    for (int id : new int[] { R.id.w_big, R.id.w_pill, R.id.w_of, R.id.w_week,
                                              R.id.w_appname, R.id.w_label, R.id.w_action,
                                              R.id.w_asof, R.id.w_aux_hours, R.id.w_aux_weeks,
                                              R.id.w_aux_rate }) {
                        assertNoClippedText(v, id, where);
                    }
                }
            }
        }
    }

    /**
     * The ban, on the surface most likely to break it.
     *
     * A status pill is three words at 8sp, which is exactly the pressure that
     * produces "ON TRACK". Every state must state a signed distance or a fact.
     */
    @Test
    public void thePillNeverSoftensTheVerdict() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String ahead = REAL_JSON.replace("\"gap\":8796.57", "\"gap\":-1200.0")
                                .replace("\"state\":\"behind\"", "\"state\":\"ahead\"");
        String level = REAL_JSON.replace("\"gap\":8796.57", "\"gap\":0.2")
                                .replace("\"state\":\"behind\"", "\"state\":\"level\"");
        String met   = REAL_JSON.replace("\"state\":\"behind\"", "\"state\":\"reached\"");

        String[] blobs = { REAL_JSON, ahead, level, met, NO_GOAL_JSON, "", "{not json" };
        String[] banned = { "on track", "on pace", "caught up" };

        for (String blob : blobs) {
            WidgetStore.save(app, blob);
            String pill = WidgetRenderer.pillText(WidgetStore.load(app)).toLowerCase(Locale.US);
            for (String b : banned)
                assertTrue("the pill said \"" + pill + "\" — \"" + b + "\" is banned outright",
                           !pill.contains(b));
        }

        // …and it must actually SAY something in the states that have a verdict,
        // or the assertions above pass on an empty string.
        WidgetStore.save(app, REAL_JSON);
        assertEquals("BEHIND $9k", WidgetRenderer.pillText(WidgetStore.load(app)));
        WidgetStore.save(app, ahead);
        assertTrue("ahead must read as ahead",
                   WidgetRenderer.pillText(WidgetStore.load(app)).startsWith("AHEAD"));
        WidgetStore.save(app, level);
        assertEquals("LEVEL", WidgetRenderer.pillText(WidgetStore.load(app)));
        WidgetStore.save(app, met);
        assertEquals("GOAL MET", WidgetRenderer.pillText(WidgetStore.load(app)));
        WidgetStore.save(app, NO_GOAL_JSON);
        assertEquals("NO GOAL", WidgetRenderer.pillText(WidgetStore.load(app)));
        WidgetStore.save(app, "");
        assertEquals("NO DATA", WidgetRenderer.pillText(WidgetStore.load(app)));
    }

    /**
     * The four bands, actually present. A redesign that silently loses a band to
     * an over-budget column is the exact failure this file exists to catch, and
     * "it rendered" is not evidence the band is there.
     */
    @Test
    public void everyBandIsPresentAtTheSizeThatShouldHaveIt() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        WidgetStore.save(app, REAL_JSON);
        WidgetStore.Snapshot s = WidgetStore.load(app);
        long now = System.currentTimeMillis();

        for (int[] sz : SIZES) {
            int i = sz[0];
            View v = renderLaidOut(app, s, SIZE_ENUM[i], sz[1], sz[2], now);
            String at = SIZE_NAMES[i] + ": ";
            assertVisible(at + "header app name", v, R.id.w_appname);
            assertVisible(at + "status pill", v, R.id.w_pill);
            assertVisible(at + "the ring", v, R.id.w_ring);
            assertVisible(at + "the primary number", v, R.id.w_big);

            if (i == 0) {   // 2x1 — no aux row, no action bar, no sub-label, and
                            // no % inside an 18dp ring. All four are ABSENT from
                            // the layout rather than hidden, so this asserts
                            // absence: a view that reappears would be squeezed.
                assertNull(at + "2x1 must not carry an action bar", v.findViewById(R.id.w_action));
                assertNull(at + "2x1 must not carry an aux row", v.findViewById(R.id.w_aux));
                assertNull(at + "2x1 has no room for a sub-label — the ring carries it",
                           v.findViewById(R.id.w_of));
                View pct = v.findViewById(R.id.w_ringpct);
                assertTrue(at + "18dp is too small for a percentage inside the ring",
                           pct == null || pct.getVisibility() != View.VISIBLE);
                continue;
            }

            assertVisible(at + "the sub-label", v, R.id.w_of);
            assertVisible(at + "the week chart (kept through the redesign)", v, R.id.w_chart);
            // NOT assertVisible: a TextView nobody ever bound is still VISIBLE by
            // XML default, so "the band is present" passes on an empty box. That
            // is exactly how the first run of this test declared the ring
            // percentage and the as-of stamp fine while both rendered blank.
            assertSays(at + "the ring must state its percentage", v, R.id.w_ringpct, "3%");
            assertNonEmpty(at + "the week line", v, R.id.w_week);
            assertSays(at + "the action bar names the gesture", v, R.id.w_action, "Tap to open");
            // 4x2 has room for the "as of " prefix; 2x2 shows a bare clock,
            // because the prefix collided with "Tap to open" at 110dp.
            if (i == 2) assertStartsWith(at + "the as-of stamp", v, R.id.w_asof, "as of ");
            else        assertMatches(at + "the as-of stamp is a clock", v, R.id.w_asof,
                                      "\\d{1,2}:\\d{2}( [AP]M)?");

            if (i == 2) {   // 4x2 — the aux glyph row
                assertVisible(at + "aux hours", v, R.id.w_aux_hours);
                assertVisible(at + "aux weeks", v, R.id.w_aux_weeks);
                assertVisible(at + "aux rate", v, R.id.w_aux_rate);
                assertEquals(at + "aux hours reads the worked-week average",
                             "🕐 21.8h/wk", text(v, R.id.w_aux_hours));
                assertEquals(at + "aux weeks reads worked of elapsed",
                             "📅 3 of 5", text(v, R.id.w_aux_weeks));
                assertEquals(at + "aux rate is his rate", "💵 $60/hr", text(v, R.id.w_aux_rate));
            }
        }
    }

    /**
     * Visible AND carrying the expected text.
     *
     * assertVisible alone is a weak assertion for a TextView: XML visibility
     * defaults to VISIBLE, so a view the renderer never touched passes it while
     * drawing nothing. Every text slot the redesign added is checked for content.
     */
    private static void assertSays(String msg, View root, int id, String want) {
        assertVisible(msg, root, id);
        assertEquals(msg + " — wrong text", want, text(root, id));
    }

    private static void assertNonEmpty(String msg, View root, int id) {
        assertVisible(msg, root, id);
        assertTrue(msg + " — the view is visible but empty", text(root, id).length() > 0);
    }

    private static void assertStartsWith(String msg, View root, int id, String prefix) {
        assertVisible(msg, root, id);
        String t = text(root, id);
        assertTrue(msg + " — expected something starting \"" + prefix + "\", got \"" + t + "\"",
                   t.startsWith(prefix));
    }


    private static void assertMatches(String msg, View root, int id, String regex) {
        assertVisible(msg, root, id);
        String t = text(root, id);
        assertTrue(msg + " — \"" + t + "\" does not match /" + regex + "/", t.matches(regex));
    }

    private static void assertVisible(String msg, View root, int id) {
        View c = root.findViewById(id);
        assertNotNull(msg + " — view is absent from the layout", c);
        assertEquals(msg + " — view is not visible", View.VISIBLE, c.getVisibility());
    }

    private static String text(View root, int id) {
        return ((TextView) root.findViewById(id)).getText().toString();
    }

    /**
     * Clipped means "the glyphs are wider than the box", which for a singleLine
     * TextView with no ellipsize is a silent mid-character cut rather than a "…".
     */
    private static void assertNoClippedText(View root, int id, String tag) {
        View c = root.findViewById(id);
        if (!(c instanceof TextView) || c.getVisibility() != View.VISIBLE) return;
        TextView t = (TextView) c;
        CharSequence s = t.getText();
        if (s == null || s.length() == 0) return;

        // Two different failures, because these slots fail two different ways.
        // A view with ellipsize=end reports an ellipsis count; w_big has none, so
        // an over-long string there is CLIPPED mid-glyph with nothing to report.
        if (t.getLayout() != null) {
            assertEquals(tag + ": " + idName(t) + " was ellipsised — \"" + s + "\"",
                         0, t.getLayout().getEllipsisCount(0));
        }
        float need = t.getPaint().measureText(s.toString());
        int have = t.getWidth() - t.getPaddingStart() - t.getPaddingEnd();
        assertTrue(tag + ": " + idName(t) + " needs " + need + "px for \"" + s
                   + "\" but has " + have + "px — clipped", need <= have + 0.5f);
    }

    /** Build, apply and lay out at a given cell size, without writing a PNG. */
    private static View renderLaidOut(Context ctx, WidgetStore.Snapshot s,
                                      WidgetRenderer.Size size, int wDp, int hDp, long now) {
        DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int w = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, wDp, dm);
        int h = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, hDp, dm);
        View v = WidgetRenderer.build(ctx, s, size, now).apply(ctx, new FrameLayout(ctx));
        v.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                  View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
        v.layout(0, 0, w, h);
        return v;
    }

    /** WCAG relative-luminance contrast ratio between two opaque colours. */
    private static double contrast(int a, int b) {
        double la = relLuma(a), lb = relLuma(b);
        double hi = Math.max(la, lb), lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    private static double relLuma(int c) {
        double[] v = new double[3];
        int[] ch = { (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF };
        for (int i = 0; i < 3; i++) {
            double s = ch[i] / 255.0;
            v[i] = s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
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

        assertEveryTextSlotHasInk(v, bmp, out.getName());

        try (FileOutputStream fos = new FileOutputStream(out)) {
            bmp.compress(Bitmap.CompressFormat.PNG, 100, fos);
        }
        assertTrue("wrote " + out.getName(), out.length() > 0);
        return bmp;
    }

    /**
     * v108.2 — THE THIRD FALSE GREEN IN THIS HARNESS, and the nastiest so far.
     *
     * Everything above this line can pass while a TextView draws absolutely
     * nothing. The view is VISIBLE, it has the right text, the right colour, the
     * right text size and a correctly-laid-out box — and the pixels are blank.
     *
     * That is not hypothetical. The first build of the redesign shipped it twice
     * at once: `android:gravity` on a `singleLine` TextView inflated through
     * RemoteViews left both the ring's "3%" and the action bar's "as of 12:15 PM"
     * invisible. `assertVisible` passed. Adding `assertSays` — which checks the
     * actual string — ALSO passed, because the string was genuinely there. Only
     * counting pixels found it. (The fix is `layout_gravity` for placement inside
     * a parent, and no `gravity` on a single-line RemoteViews TextView.)
     *
     * So this is the assertion of record: a text slot that claims to say
     * something must put ink on the canvas. Uniform region => nothing was drawn.
     */
    private static void assertEveryTextSlotHasInk(View root, Bitmap bmp, String tag) {
        int[] ids = { R.id.w_appname, R.id.w_pill, R.id.w_label, R.id.w_big, R.id.w_of,
                      R.id.w_week, R.id.w_ringpct, R.id.w_action, R.id.w_asof,
                      R.id.w_aux_hours, R.id.w_aux_weeks, R.id.w_aux_rate };
        for (int id : ids) {
            View c = root.findViewById(id);
            if (!(c instanceof TextView) || c.getVisibility() != View.VISIBLE) continue;
            TextView t = (TextView) c;
            if (t.getText() == null || t.getText().length() == 0) continue;

            int x0 = 0, y0 = 0;
            for (View p = c; p != null && p != root.getParent(); ) {
                x0 += p.getLeft(); y0 += p.getTop();
                if (p == root) break;
                p = (p.getParent() instanceof View) ? (View) p.getParent() : null;
            }
            int x1 = Math.min(bmp.getWidth(),  x0 + c.getWidth());
            int y1 = Math.min(bmp.getHeight(), y0 + c.getHeight());
            x0 = Math.max(0, x0); y0 = Math.max(0, y0);
            if (x1 <= x0 || y1 <= y0) continue;

            int lo = 255, hi = 0;
            for (int y = y0; y < y1; y++) {
                for (int x = x0; x < x1; x++) {
                    int p = bmp.getPixel(x, y);
                    int lum = (int) (0.299 * ((p >> 16) & 0xFF)
                                   + 0.587 * ((p >> 8) & 0xFF)
                                   + 0.114 * (p & 0xFF));
                    if (lum < lo) lo = lum;
                    if (lum > hi) hi = lum;
                }
            }
            assertTrue(tag + ": " + idName(c) + " says \"" + t.getText()
                       + "\" but drew NOTHING — the region is a flat "
                       + lo + " (see the note on android:gravity above)",
                       hi - lo > 25);
        }
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
