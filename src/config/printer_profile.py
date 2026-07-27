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

# A printer nobody has written a profile for is still a printer, so one can be
# described here instead: same schema, kept with the user's data rather than in
# the repo, and merged over the shipped table so a bundled entry can also be
# corrected without editing the source.
import os                                                     # noqa: E402

_USER_PROFILES_PATH = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "thermal-printer" / "printer-profiles.json"

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

    profiles = dict(profiles)
    for key, entry in load_user_profiles().items():
        if isinstance(entry, dict) and entry.get("media"):
            entry = dict(entry)
            entry["custom"] = True
            profiles[key] = entry

    _profiles_cache = profiles
    return profiles


def load_user_profiles() -> Dict[str, Dict[str, Any]]:
    """Whatever the user has described, keyed the same way as the shipped set."""
    try:
        with open(_USER_PROFILES_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    entries = data.get("profiles") if isinstance(data, dict) else None
    return entries if isinstance(entries, dict) else {}


def save_user_profile(key: str, profile: Dict[str, Any]) -> None:
    """Write one user profile and drop the cache, so it takes effect at once."""
    entries = load_user_profiles()
    entries[key] = profile
    _USER_PROFILES_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = _USER_PROFILES_PATH.with_suffix(".json.tmp")
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump({"profiles": entries}, handle, indent=2)
    temp.replace(_USER_PROFILES_PATH)
    reset_cache()


def delete_user_profile(key: str) -> bool:
    entries = load_user_profiles()
    if key not in entries:
        return False
    del entries[key]
    _USER_PROFILES_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_USER_PROFILES_PATH, "w", encoding="utf-8") as handle:
        json.dump({"profiles": entries}, handle, indent=2)
    reset_cache()
    return True


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


# -----------------------------------------------------------------------------
# local extensions to the schema
# -----------------------------------------------------------------------------
# escpos-printer-db describes what a printer can do, not how to talk to it
# without falling over. These blocks are ours, kept separate so a profile is
# still readable by anything that expects that schema and ignores the rest.

FLOW_DEFAULTS = {
    "chunk_bytes": 1024,       # a write this size at a time
    "chunk_pause_ms": 10,      # and this long between them
    "band_rows": 64,           # rows to a raster command
    "drain_seconds": 0.0,      # wait before closing, for printers with a slow buffer
}


def get_flow() -> Dict[str, Any]:
    """How fast the printer can be fed without dropping bytes.

    These three numbers decide whether a printer works at all: a whole page in
    one write is what made this one streak. They were constants tuned against
    one machine; now they belong to the profile, so a second machine can be
    fixed without editing code.
    """
    flow = dict(FLOW_DEFAULTS)
    stored = get_profile().get("flow") or {}
    for key in flow:
        if key in stored:
            try:
                flow[key] = type(flow[key])(stored[key])
            except (TypeError, ValueError):
                pass
    flow["chunk_bytes"] = max(64, min(65536, int(flow["chunk_bytes"])))
    flow["chunk_pause_ms"] = max(0, min(500, int(flow["chunk_pause_ms"])))
    flow["band_rows"] = max(8, min(1024, int(flow["band_rows"])))
    flow["drain_seconds"] = max(0.0, min(30.0, float(flow["drain_seconds"])))
    return flow


def get_driver_name() -> str:
    """Which printer language this profile speaks.

    A receipt printer and a label printer sold beside it look identical and
    understand nothing of each other: ESC/POS streams down an endless roll,
    TSPL declares a label of a known size. Sending one the other's bytes prints
    a page of characters, so this is a property of the model, not a setting.
    """
    return str(get_profile().get("driver") or "escpos")


def get_graphics_command() -> str:
    """Which opcode carries a bitmap. GS v 0 unless the profile says otherwise."""
    return str(get_profile().get("graphics") or "gsv0")


def get_cut_style() -> Dict[str, Any]:
    """Which cut command this printer answers to, and how far to feed first."""
    stored = get_profile().get("cut") or {}
    return {
        "full": str(stored.get("full") or "gsv0"),
        "partial": str(stored.get("partial") or "gsv1"),
        "feed_dots": max(0, min(600, int(stored.get("feed_dots") or 0))),
    }


def get_density() -> Dict[str, Any]:
    """How hard the head burns, when the printer lets that be set at all."""
    stored = get_profile().get("density") or {}
    return {
        "supported": bool(stored.get("supported")),
        "level": max(0, min(8, int(stored.get("level") or 0))),
    }


def get_print_area() -> Dict[str, int]:
    """The head, and the part of it this printer actually prints.

    max_dots is the head. dots_per_line is what the page is composed at, which
    is the same thing unless the profile narrows it. margin_left shifts the
    composed page inside the head, for printers whose paper does not start
    where their head does.
    """
    width = get_printer_width()
    stored = get_profile().get("media", {}).get("print_area") or {}
    try:
        line = int(stored.get("dots_per_line") or width)
    except (TypeError, ValueError):
        line = width
    try:
        left = int(stored.get("margin_left") or 0)
    except (TypeError, ValueError):
        left = 0
    line = max(PRINTER_WIDTH_BITS_PER_BYTE, min(width, line))
    line -= line % PRINTER_WIDTH_BITS_PER_BYTE
    left = max(0, min(width - line, left))
    return {"max_dots": width, "dots_per_line": line, "margin_left": left}


def reset_cache() -> None:
    """Drop the cached profile table - used by tests and after editing profiles."""
    global _profiles_cache
    _profiles_cache = None


# -----------------------------------------------------------------------------
# tear-off calibration (per profile)
# -----------------------------------------------------------------------------
def get_dpi() -> int:
    try:
        return int(get_profile()["media"]["dpi"])
    except (KeyError, TypeError, ValueError):
        return 203


def mm_to_dots(mm: float) -> int:
    """Millimetres to dot rows at the active profile's DPI."""
    return max(0, int(round(mm * get_dpi() / 25.4)))


def dots_to_mm(dots: int) -> float:
    return dots * 25.4 / get_dpi()


def get_tear_gap_mm() -> float:
    """Calibrated tear-off gap for the active profile, 0 when uncalibrated.

    Stored per profile because the head-to-tear-bar distance belongs to the
    printer body, not to the document being printed.
    """
    try:
        table = _settings().get(SettingsKeys.Printing.TEAR_GAP_MM, {}) or {}
        if isinstance(table, dict):
            return float(table.get(get_profile_name(), 0))
        # tolerate a bare number written by hand
        return float(table)
    except (TypeError, ValueError, AttributeError):
        return 0.0


def set_tear_gap_mm(mm: float) -> None:
    settings = _settings()
    table = settings.get(SettingsKeys.Printing.TEAR_GAP_MM, {}) or {}
    if not isinstance(table, dict):
        table = {}
    table[get_profile_name()] = round(float(mm), 2)
    settings.set(SettingsKeys.Printing.TEAR_GAP_MM, table)

    # save() is debounced behind a daemon timer, so a short-lived process can
    # exit before the write lands. A calibration result must survive that.
    if hasattr(settings, "save_immediate"):
        settings.save_immediate()
    else:
        settings.save()
