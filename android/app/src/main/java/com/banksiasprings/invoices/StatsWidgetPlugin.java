package com.banksiasprings.invoices;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * v107.0 — the app's one way to hand the home-screen widget a new snapshot.
 *
 * Deliberately tiny and deliberately separate from NativeGeoPlugin: this touches
 * no location, no permissions and no lifecycle, and mixing it into the geofencing
 * plugin would put the money mirror behind that plugin's permission gates.
 *
 * The write is synchronous and cheap (one SharedPreferences string); the redraw
 * it triggers is handed to WorkManager, so nothing renders on the caller's thread.
 */
@CapacitorPlugin(name = "StatsWidget")
public class StatsWidgetPlugin extends Plugin {

    @PluginMethod
    public void updateSnapshot(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.length() == 0) {
            call.reject("No snapshot supplied");
            return;
        }
        try {
            WidgetStore.save(getContext(), json);
            GoalWidgetProvider.requestRefresh(getContext());
            JSObject ret = new JSObject();
            ret.put("saved", true);
            // Reported back so JS can tell "written but nobody is looking" from
            // "written and drawn" — a widget the user has not added yet is a
            // perfectly normal state, not a failure.
            ret.put("widgets", GoalWidgetProvider.installedCount(getContext()));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Widget snapshot write failed: " + e.getMessage(), e);
        }
    }

    /**
     * Drains the screen a widget tap asked for, if any. Read-and-clear in one
     * call so a navigation can never be replayed on the next resume.
     *
     * v108.0 also returns `week`: the Monday key of the tapped bar, or null for
     * the whole-card tap. Both keys are cleared together — clearing only the
     * screen would leave a week banked, and the NEXT plain tap would silently
     * inherit a filter from a bar press the user made minutes earlier.
     */
    @PluginMethod
    public void consumePendingScreen(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            String screen = WidgetStore.prefs(getContext()).getString("pending_screen", null);
            String week = WidgetStore.prefs(getContext()).getString("pending_week", null);
            if (screen != null) {
                WidgetStore.prefs(getContext()).edit()
                        .remove("pending_screen").remove("pending_week").apply();
            }
            ret.put("screen", screen);
            ret.put("week", week);
        } catch (Exception e) {
            ret.put("screen", null);
            ret.put("week", null);
        }
        call.resolve(ret);
    }

    /** Lets Setup Health (and the tests) ask what the widget currently believes. */
    @PluginMethod
    public void getSnapshot(PluginCall call) {
        JSObject ret = new JSObject();
        String raw = WidgetStore.rawJson(getContext());
        ret.put("present", raw != null);
        ret.put("json", raw);
        ret.put("widgets", GoalWidgetProvider.installedCount(getContext()));
        call.resolve(ret);
    }
}
