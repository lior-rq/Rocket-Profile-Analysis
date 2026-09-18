#!/bin/sh
# Dev build of the Mac app from the working tree: .app only, no DMG, no updater signing.
# Usage: build/dev_mac.sh [build_service.sh flags: --skip-ui --skip-host --skip-smoke]
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
sh "$ROOT/build/build_service.sh" "$@"
cd "$ROOT/app"
npm run tauri build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
APP="$ROOT/app/src-tauri/target/release/bundle/macos/Rocket Profile Analysis.app"
echo "app: $APP"
echo "run: open \"$APP\""
