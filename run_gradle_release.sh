#!/bin/bash
export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
export PATH="$JAVA_HOME/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd "$HOME/Documents/tradie-invoices/android"
./gradlew bundleRelease > /tmp/gradle_build.log 2>&1
echo "EXIT:$?" >> /tmp/gradle_build.log
