package com.banksiasprings.invoices;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;

/**
 * v107.0 — the home-screen widget's ONLY data source.
 *
 * The app computes every figure and hands over a finished JSON blob (see
 * buildWidgetSnapshot in www/index.html); this class parses it and derives
 * nothing but calendar lookups. That boundary is deliberate: a second
 * implementation of the money math, in Java, that the money tests never run
 * against, is precisely how a home screen comes to disagree with the app it
 * mirrors.
 *
 * There is no Firestore, no auth and no network here. The widget process reads
 * one SharedPreferences string and renders it.
 *
 * Absence is modelled explicitly. A missing figure is null (Double), never 0 —
 * a widget that prints "$0.00" against a goal reads as "you earned nothing",
 * which is the opposite of "nobody has told me yet", and a home screen has no
 * room to explain the difference in prose.
 */
public class WidgetStore {

    private static final String PREFS = "mcn_widget_prefs";
    private static final String KEY_SNAPSHOT = "snapshot_json";

    /** How old a snapshot may be before the widget says so rather than implying it is live. */
    static final long STALE_AFTER_MS = 36L * 60L * 60L * 1000L;

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void save(Context ctx, String json) {
        prefs(ctx).edit().putString(KEY_SNAPSHOT, json).apply();
    }

    public static String rawJson(Context ctx) {
        return prefs(ctx).getString(KEY_SNAPSHOT, null);
    }

    /** One week bucket, keyed by its Monday (yyyy-MM-dd) exactly as retainedWeeks() writes it. */
    public static class Week {
        public final String key;
        public final double hours;
        public final double retained;
        Week(String key, double hours, double retained) {
            this.key = key; this.hours = hours; this.retained = retained;
        }
    }

    public static class Milestone {
        public final double usd;
        public final String label;
        public final boolean reached;
        Milestone(double usd, String label, boolean reached) {
            this.usd = usd; this.label = label; this.reached = reached;
        }
    }

    public static class Snapshot {
        /** False when nothing has ever been written — a fresh install, not a zero. */
        public boolean present = false;
        public long generatedAt = 0;
        public String fyLabel = "";
        /** "ok" states from JS: behind / ahead / level / reached / no-target / no-data. */
        public String state = "no-data";
        public boolean hasData = false;
        public double retained = 0;
        public Double target = null;
        public Double pct = null;
        public Double remaining = null;
        public String gapText = "";
        public String paceNote = null;
        public Double weekGoalHours = null;
        public Double effectiveRate = null;
        public int workedWeeks = 0;
        public int elapsedWeeks = 0;
        public List<Week> weeks = new ArrayList<>();
        public List<Milestone> milestones = new ArrayList<>();

        public boolean isStale(long nowMs) {
            return generatedAt > 0 && (nowMs - generatedAt) > STALE_AFTER_MS;
        }

        /**
         * Hours in the week containing `nowMs`. Returns null when that week has no
         * bucket at all — which is the honest reading of "no days confirmed this
         * week", and lets the caller print "—" rather than a decisive 0.0h.
         */
        public Double hoursForWeekOf(long nowMs, int weeksBack) {
            String want = mondayKey(nowMs, weeksBack);
            for (Week w : weeks) if (w.key.equals(want)) return w.hours;
            return null;
        }
    }

    /**
     * The Monday key for a moment, matching widgetWeekKey()/retainedWeeks() in JS.
     * Deriving this natively is what lets a 30-minute refresh roll the week over on
     * Monday morning without the app ever being opened — it is calendar lookup, not
     * arithmetic over dollars, so it does not cross the boundary this class defends.
     */
    public static String mondayKey(long ms, int weeksBack) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(ms);
        c.add(Calendar.DAY_OF_YEAR, -7 * weeksBack);
        // Calendar.MONDAY == 2; shift so Monday is 0.
        int dow = (c.get(Calendar.DAY_OF_WEEK) + 5) % 7;
        c.add(Calendar.DAY_OF_YEAR, -dow);
        return String.format(Locale.US, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    /** Never throws: a malformed blob yields an absent snapshot, not a crashed widget. */
    public static Snapshot load(Context ctx) {
        Snapshot s = new Snapshot();
        String raw = rawJson(ctx);
        if (raw == null || raw.length() == 0) return s;
        try {
            JSONObject o = new JSONObject(raw);
            s.present = true;
            s.generatedAt = o.optLong("generatedAt", 0);
            s.fyLabel = o.optString("fyLabel", "");
            s.state = o.optString("state", "no-data");
            s.hasData = o.optBoolean("hasData", false);
            s.retained = o.optDouble("retained", 0);
            s.target = optDouble(o, "target");
            s.pct = optDouble(o, "pct");
            s.remaining = optDouble(o, "remaining");
            s.gapText = o.optString("gapText", "");
            s.paceNote = o.isNull("paceNote") ? null : o.optString("paceNote", null);
            s.weekGoalHours = optDouble(o, "weekGoalHours");
            s.effectiveRate = optDouble(o, "effectiveRate");
            s.workedWeeks = o.optInt("workedWeeks", 0);
            s.elapsedWeeks = o.optInt("elapsedWeeks", 0);

            JSONArray wk = o.optJSONArray("weeks");
            if (wk != null) {
                for (int i = 0; i < wk.length(); i++) {
                    JSONObject w = wk.optJSONObject(i);
                    if (w == null) continue;
                    s.weeks.add(new Week(w.optString("k", ""), w.optDouble("h", 0), w.optDouble("r", 0)));
                }
            }
            JSONArray ms = o.optJSONArray("milestones");
            if (ms != null) {
                for (int i = 0; i < ms.length(); i++) {
                    JSONObject m = ms.optJSONObject(i);
                    if (m == null) continue;
                    s.milestones.add(new Milestone(
                            m.optDouble("usd", 0), m.optString("label", ""), m.optBoolean("reached", false)));
                }
            }
        } catch (Exception e) {
            // A corrupt blob is indistinguishable from none: show the empty state.
            return new Snapshot();
        }
        return s;
    }

    private static Double optDouble(JSONObject o, String key) {
        if (!o.has(key) || o.isNull(key)) return null;
        double v = o.optDouble(key, Double.NaN);
        return Double.isNaN(v) ? null : v;
    }

    /**
     * Money formatting mirroring fmtUsd() in the shared pure block: two decimals
     * under $100, none above, always grouped. Formatting is presentation, not
     * arithmetic — every value here was computed by the app.
     */
    public static String money(double v) {
        String body = (Math.abs(v) < 100)
                ? String.format(Locale.US, "%,.2f", v)
                : String.format(Locale.US, "%,.0f", v);
        return "$" + body;
    }

    /** Compact form for the smallest widget, where "$23,221" must fit beside a label. */
    public static String moneyCompact(double v) {
        double a = Math.abs(v);
        if (a >= 100000) return "$" + String.format(Locale.US, "%.0fk", v / 1000);
        if (a >= 10000)  return "$" + String.format(Locale.US, "%.1fk", v / 1000);
        return money(v);
    }

    /**
     * Shortest readable form, for the milestone chips where three values share one
     * narrow row. Whole thousands: "$47k", not "$46.8k" — a milestone is a marker,
     * and the extra digit cost more width than it carried meaning.
     */
    public static String moneyTiny(double v) {
        double a = Math.abs(v);
        if (a >= 1000) return "$" + String.format(Locale.US, "%,.0fk", v / 1000);
        return "$" + String.format(Locale.US, "%,.0f", v);
    }

    public static String hours(Double h) {
        if (h == null) return "—";
        return String.format(Locale.US, "%.1fh", h);
    }
}
