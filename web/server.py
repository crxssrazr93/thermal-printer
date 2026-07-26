# local web server for the browser front end
#
# Deliberately stdlib-only. This is a personal tool that runs on the same
# machine as the printer, so pulling in a web framework would add install
# friction for no benefit at this size.
#
# The browser cannot open an RFCOMM socket or write to /dev/usb/lp0, so
# everything that touches hardware stays in Python and the page talks to it
# over JSON. Rendering also stays here, which means the preview the browser
# shows is the exact bitmap that gets sent to the printer rather than a CSS
# approximation of it.

import base64
import binascii
import datetime
import hashlib
import io
import json
import logging
import mimetypes
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.config.defaults import (                # noqa: E402
    MAX_TEAR_GAP_MM,
    TEAR_CALIBRATION_LINES,
)
from src.config.printer_profile import (          # noqa: E402
    get_dpi,
    get_printer_width,
    get_profile_labels,
    get_tear_gap_mm,
    mm_to_dots,
    set_tear_gap_mm,
)
from src.config.settings import SettingsFactory   # noqa: E402
from src.core import device_profiles as profiles  # noqa: E402
from src.core.device_discovery import (           # noqa: E402
    list_bluetooth_devices,
    list_cups_queues,
    list_usb_devices,
)
from src.core.printer import PrinterConnection    # noqa: E402
from src.core.protocol import PrinterProtocol     # noqa: E402
import numpy as np                                 # noqa: E402
from PIL import Image                              # noqa: E402

from src.processing.image_dither import (                     # noqa: E402
    DITHER_LABELS,
    DITHER_MODES,
)
from src.processing.calendar_renderer import CalendarRenderer   # noqa: E402
from src.processing.image_processor import ImageProcessor      # noqa: E402
from src.processing.label_renderer import (                    # noqa: E402
    LabelRenderer,
    TextAreaConfig,
)
from src.processing.symbols import SYMBOL_GROUPS               # noqa: E402
from src.processing.markdown_renderer import MarkdownRenderer  # noqa: E402
from src.utils.font_manager import get_font_manager            # noqa: E402

logger = logging.getLogger("thermal.web")

STATIC_DIR = Path(__file__).resolve().parent / "static"

# user data lives outside the repo so presets survive a git checkout
DATA_DIR = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "thermal-printer"
PRESETS_FILE = DATA_DIR / "presets.json"
TODOS_FILE = DATA_DIR / "todos.json"

# A theme is a CSS file plus a manifest entry. Built-ins ship with the app;
# anything the user drops in the data directory is merged on top, so a theme
# can be added, or a built-in replaced, without touching the source.
THEMES_DIR = STATIC_DIR / "themes"
USER_THEMES_DIR = DATA_DIR / "themes"

# Images live beside the presets rather than in the document: markdown carries
# a reference, and the renderer loads the file when it prints.
IMAGES_DIR = DATA_DIR / "images"

# label backgrounds ship with the app; a user's own go beside them
TEMPLATES_DIR = ROOT / "gallery" / "templates"

DEFAULT_FONT = "DejaVuSansMono"   # family names carry no spaces; a miss falls back silently
DEFAULT_SIZE = 24
DEFAULT_LINE_SPACING = 1.1
MAX_IMAGE_BYTES = 8 * 1024 * 1024


# -----------------------------------------------------------------------------
# json-backed storage
# -----------------------------------------------------------------------------
_store_lock = threading.Lock()


def _read_json(path: Path, fallback):
    try:
        with path.open() as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback
    except OSError as error:
        logger.warning("Could not read %s: %s", path, error)
        return fallback


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # write via a temp file so a crash mid-write cannot truncate the store
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w") as handle:
        json.dump(payload, handle, indent=2)
    temp.replace(path)


def load_presets():
    return _read_json(PRESETS_FILE, [])


def load_todos():
    return _read_json(TODOS_FILE, [])


def load_themes():
    """Built-in themes, then user themes; a repeated id replaces the built-in."""
    merged = {}
    for directory, prefix, source in (
        (THEMES_DIR, "themes/", "builtin"),
        (USER_THEMES_DIR, "/themes/user/", "user"),
    ):
        manifest = _read_json(directory / "themes.json", {})
        for entry in manifest.get("themes", []):
            theme_id = str(entry.get("id") or "").strip()
            stylesheet = entry.get("stylesheet") or ""
            if not theme_id or not stylesheet:
                continue
            merged[theme_id] = {
                "id": theme_id,
                "name": entry.get("name") or f"Theme {theme_id}",
                "href": prefix + stylesheet,
                "swatch": entry.get("swatch") or [],
                "print": entry.get("print") or {},
                "source": source,
            }
    return list(merged.values())


# -----------------------------------------------------------------------------
# template tokens
# -----------------------------------------------------------------------------
# Expanded at render time rather than when a preset is saved, so a stored
# preset stays a template and prints today's date every time it is used.
_TOKENS = {
    "date": "%d %b %Y",
    "time": "%H:%M",
    "datetime": "%d %b %Y, %H:%M",
    "weekday": "%A",
}
_TOKEN_RE = re.compile(r"\{\{\s*(" + "|".join(_TOKENS) + r")\s*\}\}", re.IGNORECASE)


def expand_tokens(text: str) -> str:
    if not text or "{{" not in text:
        return text
    now = time.localtime()
    return _TOKEN_RE.sub(
        lambda m: time.strftime(_TOKENS[m.group(1).lower()], now), text
    )


# -----------------------------------------------------------------------------
# printer session
# -----------------------------------------------------------------------------
class Session:
    """Owns the one printer connection and serialises access to it.

    A thermal printer is a single serial stream: two overlapping jobs
    interleave their bytes and produce garbage, so every write goes through
    one lock regardless of how many browser tabs are open.
    """

    def __init__(self):
        self.settings = SettingsFactory.create()
        self.printer = PrinterConnection()
        self.lock = threading.Lock()
        self.last_error: Optional[str] = None

    # --- rendering -----------------------------------------------------------
    def _pipeline(self, text: str, options: Dict[str, Any]):
        """Render markdown and return (rendered image, configured processor)."""
        text = expand_tokens(text)
        head_width = get_printer_width()

        # Along the roll rather than across it: the page is composed on a strip
        # as long as the user asks for and only as deep as the head is wide,
        # then turned a quarter turn so the lines run down the paper. Lines get
        # long and few, which is the trade: a banner, a label, a ticket.
        Session.trimmed = False
        landscape = (options.get("orientation") or "portrait") == "landscape"
        length = max(head_width, int(options.get("page_length") or 1200))
        compose_width = length if landscape else head_width

        renderer = MarkdownRenderer(
            width=compose_width,
            font_family=options.get("font") or DEFAULT_FONT,
            font_size=int(options.get("size") or DEFAULT_SIZE),
            line_spacing=float(options.get("line_spacing") or DEFAULT_LINE_SPACING),
            # how the page is set: the theme's own typographic voice, so its
            # printed output is as recognisable as its chrome
            style=options.get("style") or None,
            image_root=IMAGES_DIR,
        )
        image = renderer.render(text or " ")

        if landscape:
            image = self._turn(self._trim_tail(image, options), head_width)
        processor = ImageProcessor(
            brightness=1.0,
            contrast=float(options.get("darkness") or 1.0),
            auto_resize=False,
            printer_width=get_printer_width(),
        )
        return image, processor

    # set when the last composed strip was deeper than the head, so the UI can
    # say so rather than let the user find out on paper
    trimmed = False

    @staticmethod
    def _trim_tail(image, options: Dict[str, Any]):
        """Cut the blank end off a strip composed along the roll.

        The strip length is how much room the words have, not how much paper
        the job should use: a two word banner on a 150 mm strip would otherwise
        feed 150 mm of blank paper after it. So the strip is cut back to the
        last column with any ink in it, plus the margin the page was set with,
        and what is left is what feeds. The length still bounds the page, since
        that is what decides where a line runs out of room.
        """
        margin = int((options.get("style") or {}).get("margin") or 24)
        pixels = np.asarray(image.convert("L")) < 200

        # A rule runs the width of the page, so it says nothing about where the
        # words stop and would defeat the measurement. Rows that are inked
        # nearly all the way across are therefore left out of it; they are cut
        # to the same length as everything else, which is what a rule under a
        # trimmed heading should do anyway.
        spans = pixels.mean(axis=1) < 0.9
        body = pixels[spans] if spans.any() else pixels
        inked = np.where(body.any(axis=0))[0]
        if not len(inked):
            # nothing on it at all: a short blank strip beats a long one
            return image.crop((0, 0, min(image.width, margin * 4), image.height))

        end = min(image.width, int(inked.max()) + margin + 1)
        return image.crop((0, 0, end, image.height))

    @staticmethod
    def _turn(image, head_width: int):
        """Rotate a composed strip so it prints along the paper.

        Anything deeper than the head is wide cannot be printed at all in this
        direction, so it is trimmed rather than silently scaled, which would
        change the type size the user chose.
        """
        Session.trimmed = image.height > head_width
        if Session.trimmed:
            image = image.crop((0, 0, image.width, head_width))

        turned = image.transpose(Image.ROTATE_270)
        if turned.width < head_width:
            padded = Image.new("RGB", (head_width, turned.height), "white")
            padded.paste(turned, (0, 0))
            return padded
        return turned

    def render_for_print(self, text: str, options: Dict[str, Any]):
        # process() inverts polarity for the raster protocol, where a set bit
        # means a fired dot. That is what goes on the wire.
        image, processor = self._pipeline(text, options)
        return processor.process(image)

    def render_preview(self, text: str, options: Dict[str, Any]):
        # get_full_preview re-inverts, so the browser sees black ink on white
        # paper rather than the printer's bit pattern.
        image, processor = self._pipeline(text, options)
        return processor.get_full_preview(image)

    # --- connection ----------------------------------------------------------
    def connect(self, name: str) -> Tuple[bool, str]:
        profile = profiles.find_profile(name)
        if profile is None:
            return False, f"No saved profile named {name!r}"

        transport = profile.get("transport")
        address = profile.get("address", "")

        with self.lock:
            try:
                if self.printer.is_connected:
                    self.printer.disconnect()

                if transport == profiles.TRANSPORT_BLUETOOTH:
                    ok = self.printer.connect(address, device_name=profile["name"])
                elif transport == profiles.TRANSPORT_USB:
                    ok = self.printer.connect_usb(address)
                else:
                    ok = self.printer.connect_cups(address)
            except Exception as error:
                logger.warning("Connect failed: %s", error)
                self.last_error = str(error)
                return False, str(error)

        if ok:
            profiles.set_active(profile["name"])
            self.last_error = None
            return True, "connected"
        return False, "Could not open the device"

    def disconnect(self) -> None:
        with self.lock:
            if self.printer.is_connected:
                self.printer.disconnect()

    # --- printing ------------------------------------------------------------
    def print_image(self, image, feed_dots: int = 0) -> Tuple[bool, str]:
        """Print a page that is already a picture.

        Calendars, labels and calibration strips are drawn rather than set from
        markdown, so they come here instead of through print_text. Everything
        after the rendering is the same, and lives in one place.
        """
        if not self.printer.is_connected:
            return False, "Not connected to a printer"

        processor = ImageProcessor(
            brightness=1.0, contrast=1.0, auto_resize=False,
            printer_width=get_printer_width(),
        )
        return self._send(processor.process(image), feed_dots or None)

    def print_text(self, text: str, options: Dict[str, Any]) -> Tuple[bool, str]:
        if not self.printer.is_connected:
            return False, "Not connected to a printer"

        return self._send(self.render_for_print(text, options), None)

    def _send(self, image, feed_dots: Optional[int]) -> Tuple[bool, str]:
        gap_dots = feed_dots if feed_dots is not None else mm_to_dots(get_tear_gap_mm())

        with self.lock:
            try:
                self.printer.initialize()
                self.printer.start_print()
                for band in PrinterProtocol.build_raster_bands(image):
                    self.printer.send_image(band)
                if gap_dots:
                    self.printer.send_raw(PrinterProtocol.build_feed_dots(gap_dots))
                self.printer.end_print()
            except Exception as error:
                logger.warning("Print failed: %s", error)
                self.last_error = str(error)
                return False, str(error)

        return True, f"Printed {image.height} rows"

    # --- state ---------------------------------------------------------------
    def state(self) -> Dict[str, Any]:
        active = profiles.get_active()
        return {
            "connected": self.printer.is_connected,
            "activeProfile": active["name"] if active else None,
            "profiles": [
                {
                    "name": p.get("name"),
                    "transport": p.get("transport"),
                    "address": p.get("address"),
                    "capabilityProfile": p.get("capability_profile"),
                    "tearGapMm": p.get("tear_gap_mm", 0),
                }
                for p in profiles.list_profiles()
            ],
            "capabilityProfiles": get_profile_labels(),
            "width": get_printer_width(),
            "dpi": get_dpi(),
            "tearGapMm": get_tear_gap_mm(),
            "lastError": self.last_error,
        }


SESSION: Optional[Session] = None


# -----------------------------------------------------------------------------
# routing
# -----------------------------------------------------------------------------
Route = Tuple[str, re.Pattern, Callable]
ROUTES = []


def route(method: str, pattern: str):
    compiled = re.compile(f"^{pattern}$")

    def register(function):
        ROUTES.append((method, compiled, function))
        return function
    return register


# --- helpers shared by the picture-shaped endpoints --------------------------
def _png(handler, image: Image.Image):
    buffer = io.BytesIO()
    image.convert("L").save(buffer, format="PNG", optimize=True)
    return 200, ("image/png", buffer.getvalue())


def _fit(image: Image.Image) -> Image.Image:
    """Scale a rendered page to the paper, and never past it."""
    width = get_printer_width()
    if image.width == width:
        return image
    height = max(1, round(image.height * width / image.width))
    return image.resize((width, height), Image.LANCZOS)


def _parse_date(value) -> Optional[datetime.datetime]:
    try:
        return datetime.datetime.strptime(str(value), "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _print_image(image: Image.Image, feed_dots: int = 0):
    ok, message = SESSION.print_image(image, feed_dots=feed_dots)
    return (200 if ok else 400), {"ok": ok, "message": message}


def _tear_sample(mm: float) -> Image.Image:
    """A short page whose last line is where the tear should land."""
    from PIL import ImageDraw

    width = get_printer_width()
    font = get_font_manager().load_font(family=DEFAULT_FONT, size=22)
    line_height = 32
    height = line_height * (TEAR_CALIBRATION_LINES + 1) + 12
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)

    draw.text((10, 6), f"TEAR TEST {mm:g}mm", font=font, fill="black")
    for line in range(1, TEAR_CALIBRATION_LINES):
        draw.text((10, 6 + line * line_height), "." * 24, font=font, fill="black")
    rule_y = height - 8
    draw.line([(0, rule_y), (width, rule_y)], fill="black", width=3)
    return image


# --- state ---
@route("GET", "/api/state")
def api_state(handler, match, body):
    return 200, SESSION.state()


@route("GET", "/api/fonts")
def api_fonts(handler, match, body):
    families = get_font_manager().get_available_families() or [DEFAULT_FONT]
    return 200, {"fonts": families, "default": DEFAULT_FONT}


@route("GET", "/api/themes")
def api_themes(handler, match, body):
    return 200, {"themes": load_themes()}


@route("GET", r"/themes/user/(?P<name>[A-Za-z0-9._-]+\.css)")
def api_user_theme(handler, match, body):
    target = (USER_THEMES_DIR / match.group("name")).resolve()
    if target.parent != USER_THEMES_DIR.resolve() or not target.is_file():
        return 404, {"error": "not found"}
    return 200, ("text/css", target.read_bytes())


@route("GET", "/api/dither")
def api_dither(handler, match, body):
    return 200, {
        "modes": [{"id": mode, "label": DITHER_LABELS.get(mode, mode)} for mode in DITHER_MODES],
        "default": "floyd-steinberg",
    }


@route("GET", "/api/symbols")
def api_symbols(handler, match, body):
    """The glyph table, grouped, for the picker.

    Sent whole rather than searched here: it is a few tens of kilobytes and
    never changes, so the browser can hold it and search it as you type.
    """
    return 200, {
        "groups": [
            {"name": name,
             "symbols": [{"char": char, "name": label, "use": use}
                         for char, label, use in symbols]}
            for name, symbols in SYMBOL_GROUPS.items()
        ]
    }


@route("POST", "/api/calendar")
def api_calendar(handler, match, body):
    """Render a month or a week as a page, in the paper's own width."""
    renderer = CalendarRenderer(font_size=int(body.get("size") or 14))
    try:
        if (body.get("range") or "month") == "week":
            image = renderer.render_week(_parse_date(body.get("date")))
        else:
            today = datetime.date.today()
            image = renderer.render_month(
                int(body.get("year") or today.year),
                int(body.get("month") or today.month),
            )
    except (ValueError, IndexError, KeyError) as error:
        return 400, {"error": str(error)}

    if body.get("print"):
        return _print_image(_fit(image))
    return _png(handler, _fit(image))


@route("GET", "/api/templates")
def api_templates(handler, match, body):
    """The label backgrounds on offer, with their sizes.

    A caller needs the size to place text on one, since the coordinates are in
    the template's own pixels rather than the paper's.
    """
    entries = []
    for path in sorted(TEMPLATES_DIR.glob("*.png")):
        try:
            with Image.open(path) as picture:
                width, height = picture.size
        except OSError:
            continue
        entries.append({"name": path.stem, "file": path.name,
                        "width": width, "height": height})
    return 200, {"templates": entries}


@route("GET", r"/templates/(?P<name>[A-Za-z0-9._-]+\.png)")
def api_template_file(handler, match, body):
    target = (TEMPLATES_DIR / match.group("name")).resolve()
    if target.parent != TEMPLATES_DIR.resolve() or not target.is_file():
        return 404, {"error": "not found"}
    return 200, ("image/png", target.read_bytes())


@route("POST", "/api/label")
def api_label(handler, match, body):
    """Compose text onto a label background and preview or print it."""
    name = str(body.get("template") or "")
    target = (TEMPLATES_DIR / name).resolve()
    if target.parent != TEMPLATES_DIR.resolve() or not target.is_file():
        return 400, {"error": "no such template"}

    with Image.open(target) as picture:
        background = picture.convert("RGB")

    renderer = LabelRenderer(template=background, target_width=get_printer_width())
    areas = [TextAreaConfig.from_dict(area) for area in body.get("areas") or []]
    darkness = float(body.get("darkness") or 1.5)
    image = renderer.get_print_image(areas, darkness=darkness)
    if image is None:
        return 400, {"error": "nothing to render"}

    if body.get("print"):
        return _print_image(image)
    return _png(handler, image)


@route("POST", "/api/tear-test")
def api_tear_test(handler, match, body):
    """Print a strip that ends in a line, then feed the gap being tried.

    Calibration is a physical question, so it is answered physically: print
    this, tear it off, and see whether the tear landed on the line.
    """
    gap = max(0.0, min(MAX_TEAR_GAP_MM, float(body.get("mm") or 0)))
    image = _tear_sample(gap)
    ok, message = SESSION.print_image(image, feed_dots=mm_to_dots(gap))
    return (200 if ok else 400), {"ok": ok, "message": message, "mm": gap}


@route("POST", "/api/images")
def api_image_upload(handler, match, body):
    """Take a data URL from the editor and keep it as a file.

    Named by the hash of its contents, so inserting the same picture twice
    costs one copy and a document that references it keeps working.
    """
    data_url = body.get("data") or ""
    match_data = re.match(r"data:image/(?P<kind>[a-z+]+);base64,(?P<payload>.+)", data_url, re.S)
    if not match_data:
        return 400, {"ok": False, "message": "Expected an image data URL"}

    try:
        raw = base64.b64decode(match_data.group("payload"))
    except (ValueError, binascii.Error):
        return 400, {"ok": False, "message": "Could not decode that image"}

    if len(raw) > MAX_IMAGE_BYTES:
        return 400, {"ok": False, "message": "That image is larger than 8 MB"}

    try:
        image = Image.open(io.BytesIO(raw))
        image.verify()
    except Exception:
        return 400, {"ok": False, "message": "That file is not an image"}

    name = f"{hashlib.sha256(raw).hexdigest()[:16]}.png"
    target = IMAGES_DIR / name
    if not target.exists():
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        Image.open(io.BytesIO(raw)).convert("RGB").save(target, format="PNG")

    return 200, {"ok": True, "url": f"/images/{name}"}


@route("GET", r"/images/(?P<name>[A-Za-z0-9._-]+)")
def api_image(handler, match, body):
    target = (IMAGES_DIR / match.group("name")).resolve()
    if target.parent != IMAGES_DIR.resolve() or not target.is_file():
        return 404, {"error": "not found"}
    kind = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    return 200, (kind, target.read_bytes())


@route("GET", "/api/devices")
def api_devices(handler, match, body):
    transport = handler.query.get("transport", [profiles.TRANSPORT_BLUETOOTH])[0]
    if transport == profiles.TRANSPORT_USB:
        found = list_usb_devices()
    elif transport == profiles.TRANSPORT_CUPS:
        found = list_cups_queues()
    else:
        found = list_bluetooth_devices()
    return 200, {"devices": [{"label": l, "value": v} for l, v in found]}


# --- connection ---
@route("POST", "/api/connect")
def api_connect(handler, match, body):
    ok, message = SESSION.connect(body.get("profile", ""))
    return (200 if ok else 400), {"ok": ok, "message": message, "state": SESSION.state()}


@route("POST", "/api/disconnect")
def api_disconnect(handler, match, body):
    SESSION.disconnect()
    return 200, {"ok": True, "state": SESSION.state()}


# --- device profiles ---
@route("POST", "/api/profiles")
def api_profile_save(handler, match, body):
    try:
        name = profiles.save_profile(
            name=body.get("name", ""),
            transport=body.get("transport", profiles.TRANSPORT_BLUETOOTH),
            address=body.get("address", ""),
            capability_profile=body.get("capabilityProfile", ""),
            tear_gap_mm=body.get("tearGapMm", 0),
            original_name=body.get("originalName"),
        )
    except ValueError as error:
        return 400, {"ok": False, "message": str(error)}
    return 200, {"ok": True, "name": name, "state": SESSION.state()}


@route("DELETE", "/api/profiles/(?P<name>.+)")
def api_profile_delete(handler, match, body):
    from urllib.parse import unquote
    profiles.delete_profile(unquote(match.group("name")))
    return 200, {"ok": True, "state": SESSION.state()}


@route("POST", "/api/tear-gap")
def api_tear_gap(handler, match, body):
    set_tear_gap_mm(float(body.get("mm", 0)))
    return 200, {"ok": True, "state": SESSION.state()}


# --- preview + print ---
@route("POST", "/api/preview")
def api_preview(handler, match, body):
    image = SESSION.render_preview(body.get("text", ""), body.get("options", {}))
    buffer = io.BytesIO()
    image.convert("L").save(buffer, format="PNG", optimize=True)
    # the page itself cannot say that some of it was cut off, so the response does
    handler.extra_headers = {"X-Trimmed": "1" if SESSION.trimmed else "0"}
    return 200, ("image/png", buffer.getvalue())


@route("POST", "/api/print")
def api_print(handler, match, body):
    ok, message = SESSION.print_text(body.get("text", ""), body.get("options", {}))
    return (200 if ok else 400), {"ok": ok, "message": message}


# --- presets ---
@route("GET", "/api/presets")
def api_presets(handler, match, body):
    return 200, {"presets": load_presets()}


@route("POST", "/api/presets")
def api_preset_save(handler, match, body):
    name = (body.get("name") or "").strip()
    if not name:
        return 400, {"ok": False, "message": "A preset needs a name"}

    with _store_lock:
        presets = load_presets()
        entry = {
            "id": body.get("id") or uuid.uuid4().hex[:12],
            "name": name,
            "description": (body.get("description") or "").strip(),
            "text": body.get("text", ""),
            # a preset carries the render settings it was designed against, so
            # reopening one does not silently print at whatever size was last used
            "options": {
                "font": body.get("options", {}).get("font") or DEFAULT_FONT,
                "size": int(body.get("options", {}).get("size") or DEFAULT_SIZE),
                "darkness": float(body.get("options", {}).get("darkness") or 1.0),
            },
            "updated": time.time(),
        }
        for index, existing in enumerate(presets):
            if existing.get("id") == entry["id"]:
                presets[index] = entry
                break
        else:
            presets.append(entry)
        _write_json(PRESETS_FILE, presets)

    return 200, {"ok": True, "preset": entry, "presets": presets}


@route("DELETE", "/api/presets/(?P<id>[a-z0-9]+)")
def api_preset_delete(handler, match, body):
    with _store_lock:
        presets = [p for p in load_presets() if p.get("id") != match.group("id")]
        _write_json(PRESETS_FILE, presets)
    return 200, {"ok": True, "presets": presets}


# --- to-dos ---
@route("GET", "/api/todos")
def api_todos(handler, match, body):
    return 200, {"todos": load_todos()}


@route("POST", "/api/todos")
def api_todo_add(handler, match, body):
    text = (body.get("text") or "").strip()
    if not text:
        return 400, {"ok": False, "message": "Empty item"}
    with _store_lock:
        todos = load_todos()
        todos.append({"id": uuid.uuid4().hex[:12], "text": text, "done": False})
        _write_json(TODOS_FILE, todos)
    return 200, {"ok": True, "todos": todos}


@route("PATCH", "/api/todos/(?P<id>[a-z0-9]+)")
def api_todo_toggle(handler, match, body):
    with _store_lock:
        todos = load_todos()
        for todo in todos:
            if todo.get("id") == match.group("id"):
                todo["done"] = bool(body.get("done", not todo.get("done")))
                if "text" in body:
                    todo["text"] = body["text"]
        _write_json(TODOS_FILE, todos)
    return 200, {"ok": True, "todos": todos}


@route("DELETE", "/api/todos/(?P<id>[a-z0-9]+)")
def api_todo_delete(handler, match, body):
    with _store_lock:
        todos = [t for t in load_todos() if t.get("id") != match.group("id")]
        _write_json(TODOS_FILE, todos)
    return 200, {"ok": True, "todos": todos}


@route("POST", "/api/todos/clear-done")
def api_todo_clear(handler, match, body):
    with _store_lock:
        todos = [t for t in load_todos() if not t.get("done")]
        _write_json(TODOS_FILE, todos)
    return 200, {"ok": True, "todos": todos}


# -----------------------------------------------------------------------------
# http plumbing
# -----------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "ThermalPrinterWeb/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        logger.debug("%s - %s", self.address_string(), fmt % args)

    # --- helpers ---
    def _send(self, status: int, payload) -> None:
        if isinstance(payload, tuple):          # (content_type, raw bytes)
            content_type, data = payload
        else:
            content_type = "application/json"
            data = json.dumps(payload).encode()

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        # this is a localhost tool; no caching keeps edits visible immediately
        self.send_header("Cache-Control", "no-store")
        # anything a handler wanted to say about the payload rather than in it
        for name, value in getattr(self, "extra_headers", {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def _serve_static(self, path: str) -> None:
        relative = path.lstrip("/") or "index.html"
        target = (STATIC_DIR / relative).resolve()

        # never serve outside the static directory
        if not str(target).startswith(str(STATIC_DIR.resolve())):
            self._send(403, {"error": "forbidden"})
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self._send(404, {"error": "not found"})
            return

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send(200, (content_type, target.read_bytes()))

    def _dispatch(self, method: str) -> None:
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        self.query = parse_qs(parsed.query)

        for route_method, pattern, function in ROUTES:
            if route_method != method:
                continue
            match = pattern.match(parsed.path)
            if not match:
                continue
            try:
                status, payload = function(self, match, self._read_body())
            except Exception as error:
                logger.exception("Handler failed")
                status, payload = 500, {"ok": False, "message": str(error)}
            self._send(status, payload)
            return

        if method == "GET":
            self._serve_static(parsed.path)
        else:
            self._send(404, {"error": "no such endpoint"})

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    global SESSION
    SESSION = Session()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    host = os.environ.get("THERMAL_WEB_HOST", "127.0.0.1")
    port = int(os.environ.get("THERMAL_WEB_PORT", "8760"))

    server = ThreadingHTTPServer((host, port), Handler)
    logger.info("Thermal Printer web UI on http://%s:%d", host, port)
    logger.info("Presets: %s", PRESETS_FILE)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down")
    finally:
        server.server_close()
        if SESSION.printer.is_connected:
            SESSION.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
