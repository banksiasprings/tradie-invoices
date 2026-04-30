#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Package and publish an OTA update
#
# Usage:
#   ./deploy.sh <version>
#
# Example:
#   ./deploy.sh 1.0.1
#
# What it does:
#   1. Zips www/ into updates/bundle.zip  (index.html at zip root)
#   2. Writes updates/latest.json with the new version + download URL
#   3. Commits both files and pushes to main → GitHub Pages picks it up
#
# The app's "Check for Update" button fetches latest.json, compares version,
# and hot-swaps the bundle — no APK reinstall needed.
# ─────────────────────────────────────────────────────────────────────────────

set -e

VERSION="$1"

if [ -z "$VERSION" ]; then
  echo "❌  Usage: ./deploy.sh <version>   e.g.  ./deploy.sh 1.0.1"
  exit 1
fi

REPO_DIR="$HOME/Documents/tradie-invoices"
BUNDLE_URL="https://banksiasprings.github.io/tradie-invoices/updates/bundle.zip"

cd "$REPO_DIR"

echo "📦  Packaging bundle v$VERSION …"
mkdir -p updates

# Sync sw.js cache name to APP_VERSION so the cache busts every deploy.
# Single source of truth: APP_VERSION constant in www/index.html.
APP_VER=$(grep -E "^const APP_VERSION = '" www/index.html | head -1 | sed -E "s/.*'([^']+)'.*/\1/")
if [ -z "$APP_VER" ]; then
  echo "❌  Could not extract APP_VERSION from www/index.html"
  exit 1
fi
echo "🔁  Syncing sw.js cache to APP_VERSION=$APP_VER"
sed -i.bak "s/const CACHE = 'invoice-pdf-[^']*'/const CACHE = 'invoice-pdf-${APP_VER}'/" www/sw.js
rm -f www/sw.js.bak

# Zip www/ with index.html at the zip root (not nested inside www/)
rm -f updates/bundle.zip
(cd www && zip -r "$REPO_DIR/updates/bundle.zip" . --exclude "*.DS_Store" --exclude "__MACOSX/*")

echo "📝  Writing manifest …"
cat > updates/latest.json << JSONEOF
{
  "version": "$VERSION",
  "url": "$BUNDLE_URL"
}
JSONEOF

echo "🚀  Committing and pushing …"
rm -f .git/index.lock .git/HEAD.lock
git add updates/bundle.zip updates/latest.json www/sw.js
git commit -m "chore: OTA bundle v$VERSION"
git push origin main

echo ""
echo "✅  Done! v$VERSION is live."
echo "   Manifest : $BUNDLE_URL"
echo ""
echo "   Users will see the update next time they open the app"
echo "   or tap 'Check for Update' in Settings."
