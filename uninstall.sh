#!/usr/bin/env bash
# Remove the service and the app. Presets, to-dos, images and themes are left
# alone: they live in ~/.local/share/thermal-printer and are yours.
set -euo pipefail

if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now thermal-print-studio.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/thermal-print-studio.service"
    systemctl --user daemon-reload 2>/dev/null || true
fi

if command -v uv >/dev/null 2>&1 && uv tool list 2>/dev/null | grep -q thermal-print-studio; then
    uv tool uninstall thermal-print-studio
elif command -v pipx >/dev/null 2>&1 && pipx list 2>/dev/null | grep -q thermal-print-studio; then
    pipx uninstall thermal-print-studio
else
    python3 -m pip uninstall -y thermal-print-studio || true
fi

echo "Removed. Your data is still in ~/.local/share/thermal-printer"
