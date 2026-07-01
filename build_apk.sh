#!/bin/bash
set -e
export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
export ANDROID_HOME="/Users/openclaw/Library/Android/sdk"
cd "/Users/openclaw/Documents/mcnichol-invoices/android"
echo Starting build...
./gradlew assembleDebug
# Gradle build dir for this project is android/build/… (not app/build/…).
APK=$(find build app/build -name 'app-debug.apk' -path '*debug*' 2>/dev/null | head -1)
[ -n "$APK" ] || { echo "✗ could not find built app-debug.apk"; exit 1; }
cp "$APK" "/Users/openclaw/Documents/mcnichol-invoices/InvoicePDF-latest.apk"
echo Done
