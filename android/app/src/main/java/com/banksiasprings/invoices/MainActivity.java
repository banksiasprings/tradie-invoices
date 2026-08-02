package com.banksiasprings.invoices;

import android.content.Intent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** v107.0 — set by the home-screen widget's tap intent. */
    public static final String EXTRA_OPEN_SCREEN = "mcn_open_screen";

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NativeGeoPlugin.class);
        registerPlugin(StatsWidgetPlugin.class);
        super.onCreate(savedInstanceState);
        bankPendingScreen(getIntent());
    }

    /** singleTask: a tap while the app is already running arrives here, not onCreate. */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bankPendingScreen(intent);
    }

    /**
     * Banked to SharedPreferences rather than eval'd into the WebView.
     *
     * The WebView is very often not ready when the intent lands — on a cold open
     * it does not exist yet — so calling into JS from here would silently do
     * nothing on exactly the launch that matters most. Banking it and letting JS
     * drain it when it is ready is the same native-banks / JS-reads shape the
     * geofence queue and the trip log already use, and it behaves identically
     * whether the process was alive or dead.
     */
    private void bankPendingScreen(Intent intent) {
        if (intent == null) return;
        String screen = intent.getStringExtra(EXTRA_OPEN_SCREEN);
        if (screen == null || screen.isEmpty()) return;
        WidgetStore.prefs(this).edit().putString("pending_screen", screen).apply();
        // Cleared from the intent so a configuration change or a relaunch from
        // recents does not replay a navigation the user has since moved on from.
        intent.removeExtra(EXTRA_OPEN_SCREEN);
    }
}
