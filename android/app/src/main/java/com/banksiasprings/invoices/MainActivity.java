package com.banksiasprings.invoices;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NativeGeoPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
