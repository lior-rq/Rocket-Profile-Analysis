#!/bin/sh
# Everything the desktop shell bundles: build/dist/{rpa-service,rasaero,template}.
# Usage: build/build_service.sh [--skip-ui] [--skip-host] [--skip-smoke]
# Then:  cd app && npm run tauri build
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "${PYTHON:-}" ]; then PY=$PYTHON; elif [ -x "$ROOT/.venv/bin/python" ]; then PY="$ROOT/.venv/bin/python"; else PY=$(command -v python3 || command -v python || true); fi
# fail here, not after the multi-minute UI build
[ -n "$PY" ] && "$PY" -c "import PyInstaller" 2>/dev/null || { echo "build_service.sh: need a python with PyInstaller (pip install -r requirements.txt); got '${PY:-none}'" >&2; exit 1; }
echo "python: $PY"
SKIP_UI=0; SKIP_HOST=0; SKIP_SMOKE=0
for a in "$@"; do
  case "$a" in --skip-ui) SKIP_UI=1 ;; --skip-host) SKIP_HOST=1 ;; --skip-smoke) SKIP_SMOKE=1 ;; esac
done
cd "$ROOT"
"$PY" build/sync_version.py
"$PY" build/make_template.py
mkdir -p build/dist
rm -rf build/dist/template && cp -R build/template build/dist/template
if [ "$SKIP_UI" = 0 ]; then
  [ -d app/node_modules ] || (cd app && npm ci --no-audit --no-fund)
  (cd app && npm run build)
fi
rm -rf rpa/service/ui && cp -R app/dist rpa/service/ui
rm -rf build/dist/rpa-service
"$PY" -m PyInstaller build/rpa-service.spec --noconfirm --distpath build/dist --workpath build/work --log-level WARN
[ "$SKIP_HOST" = 0 ] && sh build/publish_host.sh
[ "$SKIP_SMOKE" = 0 ] && "$PY" build/smoke_service.py build/dist/rpa-service
echo "service: build/dist/rpa-service ($(du -sh build/dist/rpa-service | cut -f1))"
