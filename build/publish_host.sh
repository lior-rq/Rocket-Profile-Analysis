#!/bin/sh
# Self-contained RASAero host + engine -> build/dist/rasaero (Mac/Linux).
# Usage: build/publish_host.sh [rid]   (default: this machine's RID)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) DEF=osx-arm64 ;; Darwin-*) DEF=osx-x64 ;;
  Linux-aarch64) DEF=linux-arm64 ;; *) DEF=linux-x64 ;;
esac
RID=${1:-$DEF}
OUT="$ROOT/build/dist/rasaero"
[ -f "$ROOT/vendor/rasaero/RASAeroEngine.dll" ] || { echo "vendor/rasaero/RASAeroEngine.dll missing: python tools/rasaero_fetch.py" >&2; exit 1; }
rm -rf "$OUT"
dotnet publish "$ROOT/native/RasaeroHost" -c Release -r "$RID" --self-contained true \
  -p:PublishReadyToRun=true -p:TieredPGO=true -o "$OUT" --nologo -v q
cp "$ROOT/vendor/rasaero/RASAeroEngine.dll" "$ROOT/vendor/rasaero/rasp.eng" "$OUT/"
rm -f "$OUT"/*.pdb
echo "host: $OUT ($RID, $(du -sh "$OUT" | cut -f1))"
