#!/bin/bash
# Double-click in Finder to open the Rocket Profile Analysis GUI. (Prefer the .app: `python -m rpa gui --make-app`.)
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "No .venv yet - creating it (python3 -m venv .venv && pip install -r requirements.txt)"
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt || { echo "setup failed"; read -r -p "press return"; exit 1; }
fi
exec .venv/bin/python -m rpa gui "$@"
