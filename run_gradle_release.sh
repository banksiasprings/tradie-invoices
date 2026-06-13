#!/bin/bash
export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
export PATH="$JAVA_HOME/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export ANDROID_HOME="$HOME/Library/Android/sdk"
# Resolve the project dir from this script's location (repo is mcnichol-invoices;
# the old hard-coded ~/Documents/tradie-invoices path was stale and broke the build).
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android" || exit 1
# Sync the latest www/ into the Android assets before bundling.
(cd .. && npx cap sync android) >> /tmp/gradle_build.log 2>&1
./gradlew bundleRelease > /tmp/gradle_build.log 2>&1
echo "EXIT:$?" >> /tmp/gradle_build.log
echo "AAB: $(find app/build/outputs/bundle/release -name '*.aab' 2>/dev/null | head -1)"
