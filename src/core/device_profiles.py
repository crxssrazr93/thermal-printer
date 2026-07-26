# saved device profiles
#
# A device profile is everything needed to talk to one physical printer: how to
# reach it (transport + address), what it can do (capability profile), and how
# it tears (calibrated gap). Bundling them means switching printers is one
# choice rather than four, and calibration follows the printer it belongs to.

import logging
from typing import Any, Dict, List, Optional

from ..config.keys import SettingsKeys

logger = logging.getLogger(__name__)

TRANSPORT_BLUETOOTH = "Bluetooth"
TRANSPORT_USB = "USB"
TRANSPORT_CUPS = "CUPS"
TRANSPORTS = [TRANSPORT_BLUETOOTH, TRANSPORT_USB, TRANSPORT_CUPS]


def _settings():
    from ..config.settings import get_settings
    return get_settings()


def _persist(settings) -> None:
    # save() is debounced behind a daemon timer; profile edits must survive an
    # immediate close
    if hasattr(settings, "save_immediate"):
        settings.save_immediate()
    else:
        settings.save()


# -----------------------------------------------------------------------------
# read
# -----------------------------------------------------------------------------
def list_profiles() -> List[Dict[str, Any]]:
    try:
        stored = _settings().get(SettingsKeys.Printer.DEVICES, []) or []
    except AttributeError:
        return []
    return [p for p in stored if isinstance(p, dict) and p.get("name")]


def get_profile_names() -> List[str]:
    return [p["name"] for p in list_profiles()]


def find_profile(name: str) -> Optional[Dict[str, Any]]:
    for profile in list_profiles():
        if profile.get("name") == name:
            return profile
    return None


def get_active_name() -> str:
    try:
        return _settings().get(SettingsKeys.Printer.ACTIVE_DEVICE, "") or ""
    except AttributeError:
        return ""


def get_active() -> Optional[Dict[str, Any]]:
    profile = find_profile(get_active_name())
    if profile:
        return profile
    profiles = list_profiles()
    return profiles[0] if profiles else None


def set_active(name: str) -> None:
    settings = _settings()
    settings.set(SettingsKeys.Printer.ACTIVE_DEVICE, name)
    _persist(settings)


# -----------------------------------------------------------------------------
# write
# -----------------------------------------------------------------------------
def _unique_name(desired: str, exclude: Optional[str] = None) -> str:
    existing = {n for n in get_profile_names() if n != exclude}
    if desired not in existing:
        return desired
    index = 2
    while f"{desired} ({index})" in existing:
        index += 1
    return f"{desired} ({index})"


def save_profile(
    name: str,
    transport: str,
    address: str,
    capability_profile: str,
    tear_gap_mm: float = 0.0,
    original_name: Optional[str] = None,
) -> str:
    """Create or update a profile. Returns the name actually stored."""
    if not name.strip():
        raise ValueError("Profile name cannot be empty")
    if transport not in TRANSPORTS:
        raise ValueError(f"Unknown transport {transport!r}")

    name = _unique_name(name.strip(), exclude=original_name)
    profiles = list_profiles()

    entry = {
        "name": name,
        "transport": transport,
        "address": address,
        "capability_profile": capability_profile,
        "tear_gap_mm": round(float(tear_gap_mm or 0), 2),
    }

    target = original_name or name
    for index, existing in enumerate(profiles):
        if existing.get("name") == target:
            profiles[index] = entry
            break
    else:
        profiles.append(entry)

    settings = _settings()
    settings.set(SettingsKeys.Printer.DEVICES, profiles)
    if get_active_name() in ("", target):
        settings.set(SettingsKeys.Printer.ACTIVE_DEVICE, name)
    _persist(settings)
    return name


def rename_profile(old_name: str, new_name: str) -> str:
    profile = find_profile(old_name)
    if profile is None:
        raise KeyError(f"No profile named {old_name!r}")
    return save_profile(
        name=new_name,
        transport=profile.get("transport", TRANSPORT_BLUETOOTH),
        address=profile.get("address", ""),
        capability_profile=profile.get("capability_profile", ""),
        tear_gap_mm=profile.get("tear_gap_mm", 0),
        original_name=old_name,
    )


def delete_profile(name: str) -> None:
    profiles = [p for p in list_profiles() if p.get("name") != name]
    settings = _settings()
    settings.set(SettingsKeys.Printer.DEVICES, profiles)
    if get_active_name() == name:
        settings.set(
            SettingsKeys.Printer.ACTIVE_DEVICE,
            profiles[0]["name"] if profiles else ""
        )
    _persist(settings)


def set_tear_gap(name: str, mm: float) -> None:
    profile = find_profile(name)
    if profile is None:
        return
    save_profile(
        name=name,
        transport=profile.get("transport", TRANSPORT_BLUETOOTH),
        address=profile.get("address", ""),
        capability_profile=profile.get("capability_profile", ""),
        tear_gap_mm=mm,
        original_name=name,
    )
