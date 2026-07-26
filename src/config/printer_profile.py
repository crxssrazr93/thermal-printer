# runtime resolution of printer geometry, capabilities and protocol quirks
#
# These are deliberately functions rather than module constants. Import-time
# constants get baked into default arguments, which is why printer.width in
# config.yaml previously had no effect on rendering.
#
# Profile schema follows escpos-printer-db so entries are portable between
# this project, python-escpos and escpos-php. See doc/CREDITS.md.

import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from .defaults import (
    DEFAULT_PRINTER_WIDTH,
    DEFAULT_PRINTER_PROFILE,
    PRINTER_WIDTH_BITS_PER_BYTE,
)
from .keys import SettingsKeys

logger = logging.getLogger(__name__)

_PROFILES_PATH = Path(__file__).parent / "data" / "printer_profiles.json"

# fallback used only if the bundled profile file is missing or corrupt, so a
# broken install degrades to "works like a standard 58mm printer" rather than
# refusing to start
_FALLBACK_PROFILE: Dict[str, Any] = {
    "name": "Generic 58mm ESC/POS",
    "vendor": "Generic",
    "media": {"dpi": 203, "width": {"mm": 57.5, "pixels": DEFAULT_PRINTER_WIDTH}},
    "features": {
        "bitImageRaster": True,
        "qrCode": True,
        "barcodeA": True,
        "paperFullCut": False,
        "paperPartCut": False,
    },
    "commands": {"start_print": "", "end_print": "", "status_request": ""},
    "notes": "Built-in fallback profile.",
}

_profiles_cache: Optional[Dict[str, Dict[str, Any]]] = None


def _settings():
    # imported lazily so this module stays usable before settings are built
    from .settings import get_settings
    return get_settings()


def load_profiles() -> Dict[str, Dict[str, Any]]:
    global _profiles_cache
    if _profiles_cache is not None:
        return _profiles_cache

    try:
        with open(_PROFILES_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        profiles = data["profiles"]
        if not isinstance(profiles, dict) or not profiles:
            raise ValueError("profiles section is empty")
    except (OSError, ValueError, KeyError) as error:
        logger.warning(
            "Could not load printer profiles from %s (%s) - using fallback",
            _PROFILES_PATH, error
        )
        profiles = {DEFAULT_PRINTER_PROFILE: dict(_FALLBACK_PROFILE)}

    _profiles_cache = profiles
    return profiles


# -----------------------------------------------------------------------------
# profile selection
# -----------------------------------------------------------------------------
def get_profile_name() -> str:
    profiles = load_profiles()
    try:
        name = _settings().get(SettingsKeys.Printer.PROFILE, DEFAULT_PRINTER_PROFILE)
    except AttributeError:
        name = DEFAULT_PRINTER_PROFILE

    if name in profiles:
        return name
    if DEFAULT_PRINTER_PROFILE in profiles:
        return DEFAULT_PRINTER_PROFILE
    return next(iter(profiles))


def get_profile() -> Dict[str, Any]:
    return load_profiles()[get_profile_name()]


def get_profile_labels() -> Dict[str, str]:
    """Maps profile key -> display label, for the settings dropdown."""
    return {
        key: value.get("name", key)
        for key, value in load_profiles().items()
    }


# -----------------------------------------------------------------------------
# geometry
# -----------------------------------------------------------------------------
def get_printer_width() -> int:
    """Head width in dots, rounded down to a whole byte.

    An explicit printer.width in config wins, so a user can correct a profile
    that does not quite match their hardware. Otherwise the profile supplies it.

    The raster protocol packs 8 dots per byte, so a width that is not a
    multiple of 8 would desynchronise every row.
    """
    width = None

    try:
        configured = _settings().get(SettingsKeys.Printer.WIDTH, None)
        if configured is not None:
            width = int(configured)
    except (ValueError, TypeError, AttributeError):
        width = None

    if width is None:
        try:
            width = int(get_profile()["media"]["width"]["pixels"])
        except (KeyError, TypeError, ValueError):
            width = DEFAULT_PRINTER_WIDTH

    if width < PRINTER_WIDTH_BITS_PER_BYTE:
        width = DEFAULT_PRINTER_WIDTH

    return width - (width % PRINTER_WIDTH_BITS_PER_BYTE)


def get_printer_width_mm() -> Optional[float]:
    try:
        return float(get_profile()["media"]["width"]["mm"])
    except (KeyError, TypeError, ValueError):
        return None


# -----------------------------------------------------------------------------
# capabilities
# -----------------------------------------------------------------------------
def supports(feature: str) -> bool:
    """True if the active profile advertises the named escpos-printer-db feature."""
    return bool(get_profile().get("features", {}).get(feature, False))


# -----------------------------------------------------------------------------
# vendor command sequences
# -----------------------------------------------------------------------------
def get_command(name: str) -> bytes:
    """Vendor byte sequence for the active profile, or b'' when not needed."""
    raw = get_profile().get("commands", {}).get(name, "")
    if not raw:
        return b""
    try:
        return bytes.fromhex(raw)
    except ValueError:
        logger.warning("Profile %s has invalid hex for command %r: %r",
                       get_profile_name(), name, raw)
        return b""


def reset_cache() -> None:
    """Drop the cached profile table - used by tests and after editing profiles."""
    global _profiles_cache
    _profiles_cache = None
