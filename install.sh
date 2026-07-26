#!/usr/bin/env bash
# Install Thermal Print Studio and keep it running.
#
# Installs the app for this user, registers a systemd user service so the
# server comes back after a reboot, and prints the address to open. Everything
# lands under $HOME; nothing here needs root.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port="${THERMAL_WEB_PORT:-8760}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Installing Thermal Print Studio"
if command -v uv >/dev/null 2>&1; then
    uv tool install --force --editable "$here"
elif command -v pipx >/dev/null 2>&1; then
    pipx install --force --editable "$here"
else
    python3 -m pip install --user --editable "$here"
fi

if [ ! -x "$HOME/.local/bin/thermal-print-studio" ]; then
    echo "thermal-print-studio did not land in ~/.local/bin; add your installer's bin directory to PATH" >&2
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    say "Registering the service"
    mkdir -p "$HOME/.config/systemd/user"
    sed "s/THERMAL_WEB_PORT=8760/THERMAL_WEB_PORT=$port/" \
        "$here/packaging/thermal-print-studio.service" > "$HOME/.config/systemd/user/thermal-print-studio.service"
    systemctl --user daemon-reload
    systemctl --user enable --now thermal-print-studio.service
    sleep 1
    systemctl --user --no-pager --lines=3 status thermal-print-studio.service || true

    cat <<NOTE

The service starts when you log in. To keep it running with nobody logged in:

    sudo loginctl enable-linger $USER
NOTE
else
    cat <<NOTE

No systemd here, so nothing was registered to run in the background. Start it
by hand with:

    thermal-print-studio
NOTE
fi

say "Open http://127.0.0.1:$port"
cat <<NOTE
Chrome offers "Install" from the address bar, which gives it its own window and
icon and makes the desktop app unnecessary.

To reach it from a phone on the same network, edit
~/.config/systemd/user/thermal-print-studio.service, set THERMAL_WEB_HOST=0.0.0.0,
then: systemctl --user restart thermal-print-studio
NOTE
