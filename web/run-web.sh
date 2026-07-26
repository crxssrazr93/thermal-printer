#!/bin/bash
# Start the browser front end. Reuses the app's virtualenv for Pillow and the
# rendering code; the server itself is stdlib only.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
VENV="$ROOT/.venv_print"

if [ ! -d "$VENV" ]; then
    echo "Error: virtualenv not found at $VENV"
    exit 1
fi

cd "$ROOT"
exec "$VENV/bin/python" web/server.py "$@"
