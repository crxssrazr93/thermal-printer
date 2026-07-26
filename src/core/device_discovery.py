# device enumeration for the connection picker
#
# Each transport returns (label, value) pairs: the label is what the user sees
# in the dropdown, the value is what the connect call actually needs. Picking a
# printer by name beats typing a MAC address or a /dev path from memory.

import logging
import os
import re
import subprocess
from pathlib import Path
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

Device = Tuple[str, str]  # (display label, connect value)

USB_PRINTER_GLOB = "/dev/usb/lp*"
_SUBPROCESS_TIMEOUT = 6


# -----------------------------------------------------------------------------
# bluetooth
# -----------------------------------------------------------------------------
def list_bluetooth_devices() -> List[Device]:
    """Known Bluetooth devices, paired and connected ones first.

    Uses BlueZ over D-Bus when available so already-paired printers appear
    without waiting for a scan, falling back to parsing bluetoothctl.
    """
    devices = _bluetooth_via_dbus()
    if devices is None:
        devices = _bluetooth_via_cli()

    # printers first, then paired, then everything else - the target is almost
    # always a paired printer and scans surface a lot of unrelated hardware
    devices.sort(key=lambda d: (not d[2], not d[3], d[0].lower()))
    return [(_bluetooth_label(name, mac, paired, connected), mac)
            for name, mac, is_printer, paired, connected in devices]


def _bluetooth_label(name: str, mac: str, paired: bool, connected: bool) -> str:
    marks = []
    if connected:
        marks.append("connected")
    elif paired:
        marks.append("paired")
    suffix = f" [{', '.join(marks)}]" if marks else ""
    return f"{name or 'Unknown'} ({mac}){suffix}"


def _bluetooth_via_dbus():
    try:
        from ..utils.bluetooth_dbus import BluetoothDBusManager
    except ImportError:
        return None

    try:
        manager = BluetoothDBusManager()
        result = []
        for device in manager.get_devices():
            address = getattr(device, "address", "") or ""
            if not address:
                continue
            name = getattr(device, "name", "") or "Unknown"
            uuids = getattr(device, "uuids", []) or []
            result.append((
                name,
                address,
                _looks_like_printer(name, uuids),
                bool(getattr(device, "paired", False)),
                bool(getattr(device, "connected", False)),
            ))
        return result
    except Exception as error:
        logger.debug("D-Bus device listing unavailable: %s", error)
        return None


def _bluetooth_via_cli():
    devices = []
    try:
        listing = subprocess.run(
            ["bluetoothctl", "devices"],
            capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT
        ).stdout
    except (FileNotFoundError, subprocess.SubprocessError) as error:
        logger.debug("bluetoothctl unavailable: %s", error)
        return devices

    for line in listing.splitlines():
        match = re.match(r"Device\s+([0-9A-F:]{17})\s+(.*)", line.strip(), re.I)
        if not match:
            continue
        mac, name = match.group(1), match.group(2).strip()

        paired = connected = False
        uuids = []
        try:
            info = subprocess.run(
                ["bluetoothctl", "info", mac],
                capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT
            ).stdout
            paired = "Paired: yes" in info
            connected = "Connected: yes" in info
            uuids = re.findall(r"UUID:\s*(.+?)\s*\(", info)
        except subprocess.SubprocessError:
            pass

        devices.append((name, mac, _looks_like_printer(name, uuids), paired, connected))
    return devices


def _looks_like_printer(name: str, uuids) -> bool:
    lowered = (name or "").lower()
    if any(token in lowered for token in
           ("print", "pos", "ptr", "thermal", "receipt", "label")):
        return True
    # Serial Port Profile is what these printers expose
    return any("serial port" in str(u).lower() or "00001101" in str(u).lower()
               for u in (uuids or []))


# -----------------------------------------------------------------------------
# usb
# -----------------------------------------------------------------------------
def list_usb_devices() -> List[Device]:
    """USB printer character devices, labelled with their real identity."""
    import glob

    devices = []
    for path in sorted(glob.glob(USB_PRINTER_GLOB)):
        name = _usb_identity(path)
        label = f"{name} ({path})" if name else path
        devices.append((label, path))
    return devices


def _usb_identity(device_path: str) -> Optional[str]:
    """Vendor and model for a /dev/usb/lpN node.

    Prefers the USB descriptor strings, falling back to the IEEE 1284 device ID
    the printer reports, which is often more accurate than the marketing name.
    """
    try:
        stat = os.stat(device_path)
        sysfs = Path(f"/sys/dev/char/{os.major(stat.st_rdev)}:{os.minor(stat.st_rdev)}")
        resolved = sysfs.resolve()
    except OSError:
        return None

    # walk up to the USB device node that carries the descriptor strings
    node = resolved
    for _ in range(8):
        product = node / "product"
        if product.is_file():
            try:
                model = product.read_text().strip()
                vendor_file = node / "manufacturer"
                vendor = vendor_file.read_text().strip() if vendor_file.is_file() else ""
                return f"{vendor} {model}".strip()
            except OSError:
                break
        if node.parent == node:
            break
        node = node.parent

    ieee = resolved / "device" / "ieee1284_id"
    try:
        if ieee.is_file():
            raw = ieee.read_text()
            fields = dict(
                part.split(":", 1) for part in raw.strip().split(";") if ":" in part
            )
            vendor = fields.get("MFG", "").strip()
            model = fields.get("MDL", "").strip()
            if vendor or model:
                return f"{vendor} {model}".strip()
    except (OSError, ValueError):
        pass

    return None


# -----------------------------------------------------------------------------
# cups
# -----------------------------------------------------------------------------
def list_cups_queues() -> List[Device]:
    """Configured CUPS queues, labelled with their description."""
    try:
        result = subprocess.run(
            ["lpstat", "-l", "-p"],
            capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT
        )
    except (FileNotFoundError, subprocess.SubprocessError) as error:
        logger.debug("lpstat unavailable: %s", error)
        return []

    queues: List[Device] = []
    current: Optional[str] = None

    for line in result.stdout.splitlines():
        stripped = line.strip()
        parts = stripped.split()
        if len(parts) >= 2 and parts[0] == "printer":
            current = parts[1]
            queues.append((current, current))
        elif stripped.startswith("Description:") and current and queues:
            description = stripped.split(":", 1)[1].strip()
            if description:
                queues[-1] = (f"{description} ({current})", current)

    return queues
