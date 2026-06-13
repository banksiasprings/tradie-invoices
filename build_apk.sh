#!/bin/bash
set -e
export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
export ANDROID_HOME="/Users/openclaw/Library/Android/sdk"
cd "/Users/openclaw/Documents/mcnichol-invoices/android"
echo Starting build...
./gradlew assembleDebug
APK=$(find app/build/outputs/apk/debug -name '*.apk' | head -1)
cp "$APK" "/Users/openclaw/Documents/mcnichol-invoices/InvoicePDF-latest.apk"
echo Done
