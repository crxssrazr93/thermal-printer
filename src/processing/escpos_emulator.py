# reading a byte stream back as paper
#
# Everything else here turns a document into ESC/POS. This turns ESC/POS back
# into a picture of what would come out, which is the only way to answer the
# two questions that matter when a printer misbehaves: is the app sending the
# wrong bytes, or is the printer misreading the right ones.
#
# It is a reader, not a printer emulator: it understands the commands this app
# and its neighbours emit, draws the bitmaps, obeys the feeds, and lists
# everything else by name rather than pretending to execute it. A stream from
# another app can be dropped in the same way, which is how you find out what
# that app does differently.

from typing import Any, Dict, List, Tuple

from PIL import Image

# names for the sequences worth calling out in the listing. Anything not here
# is reported as unknown, with its bytes, rather than skipped silently.
_NAMED: List[Tuple[bytes, str]] = [
    (b"\x1b\x40", "initialise"),
    (b"\x1d\x56\x00", "cut, full"),
    (b"\x1d\x56\x01", "cut, partial"),
    (b"\x1b\x69", "cut, full (ESC i)"),
    (b"\x1b\x6d", "cut, partial (ESC m)"),
    (b"\x1b\x61\x00", "align left"),
    (b"\x1b\x61\x01", "align centre"),
    (b"\x1b\x61\x02", "align right"),
]

MAX_ROWS = 40000        # a stream that never stops feeding is a bug, not a page


class Sheet:
    """Paper that grows downwards as things are printed on it."""

    def __init__(self, width: int):
        self.width = width
        self.rows: List[Image.Image] = []
        self.height = 0

    def paste(self, band: Image.Image) -> None:
        if self.height + band.height > MAX_ROWS:
            return
        self.rows.append(band.convert("L"))
        self.height += band.height

    def feed(self, dots: int) -> None:
        if dots <= 0:
            return
        dots = min(dots, MAX_ROWS - self.height)
        if dots > 0:
            self.paste(Image.new("L", (self.width, dots), 255))

    def image(self) -> Image.Image:
        if not self.rows:
            return Image.new("L", (self.width, 1), 255)
        sheet = Image.new("L", (self.width, self.height), 255)
        y = 0
        for band in self.rows:
            sheet.paste(band, (0, y))
            y += band.height
        return sheet


def _raster_band(data: bytes, offset: int, width_dots: int):
    """GS v 0 m xL xH yL yH, then the rows. Returns (band, bytes consumed)."""
    if len(data) < offset + 8:
        return None, len(data) - offset
    width_bytes = data[offset + 4] + data[offset + 5] * 256
    height = data[offset + 6] + data[offset + 7] * 256
    payload = offset + 8
    needed = width_bytes * height
    chunk = data[payload:payload + needed]
    if not width_bytes or not height or len(chunk) < needed:
        return None, len(data) - offset

    # the wire has a set bit meaning a fired dot, which is the opposite of an
    # image, so the band is inverted on the way back to something viewable
    band = Image.frombytes("1", (width_bytes * 8, height), chunk).convert("L")
    band = Image.eval(band, lambda value: 255 - value)
    if band.width < width_dots:
        sheet = Image.new("L", (width_dots, height), 255)
        sheet.paste(band, (0, 0))
        band = sheet
    return band.crop((0, 0, width_dots, height)), 8 + needed


def _column_band(data: bytes, offset: int, mode: int, width_dots: int):
    """ESC * m nL nH, then one byte per eight vertical dots, column by column."""
    rows = 24 if mode in (32, 33) else 8
    columns = data[offset + 3] + data[offset + 4] * 256
    payload = offset + 5
    needed = columns * (rows // 8)
    chunk = data[payload:payload + needed]
    if not columns or len(chunk) < needed:
        return None, len(data) - offset, rows

    band = Image.new("L", (width_dots, rows), 255)
    pixels = band.load()
    per_column = rows // 8
    for x in range(min(columns, width_dots)):
        for byte_index in range(per_column):
            value = chunk[x * per_column + byte_index]
            for bit in range(8):
                if value & (0x80 >> bit):
                    pixels[x, byte_index * 8 + bit] = 0
    return band, 5 + needed, rows


def emulate(data: bytes, width_dots: int = 384) -> Dict[str, Any]:
    """Read a byte stream and return the paper it describes, plus a listing.

    The listing is the useful half: it says what each command was and how many
    bytes it took, so a stream that prints nothing can be looked at rather than
    guessed about.
    """
    sheet = Sheet(width_dots)
    events: List[Dict[str, Any]] = []
    text = bytearray()
    index = 0
    cuts = 0

    def flush_text():
        if text:
            events.append({"at": index - len(text), "command": "text",
                           "detail": bytes(text).decode("latin-1", "replace"),
                           "bytes": len(text)})
            text.clear()

    while index < len(data):
        byte = data[index]

        if data[index:index + 3] == b"\x1d\x76\x30":
            flush_text()
            band, used = _raster_band(data, index, width_dots)
            if band is None:
                events.append({"at": index, "command": "raster image",
                               "detail": "truncated", "bytes": used})
                break
            sheet.paste(band)
            events.append({"at": index, "command": "raster image",
                           "detail": f"{band.width} x {band.height} dots",
                           "bytes": used})
            index += used
            continue

        if data[index:index + 2] == b"\x1b\x2a" and index + 4 < len(data):
            flush_text()
            mode = data[index + 2]
            band, used, rows = _column_band(data, index, mode, width_dots)
            if band is None:
                events.append({"at": index, "command": "column image",
                               "detail": "truncated", "bytes": used})
                break
            sheet.paste(band)
            events.append({"at": index, "command": "column image",
                           "detail": f"mode {mode}, {rows} dot rows",
                           "bytes": used})
            index += used
            continue

        if data[index:index + 2] == b"\x1b\x4a" and index + 2 < len(data):
            flush_text()
            dots = data[index + 2]
            sheet.feed(dots)
            events.append({"at": index, "command": "feed",
                           "detail": f"{dots} dots", "bytes": 3})
            index += 3
            continue

        if data[index:index + 2] == b"\x1b\x64" and index + 2 < len(data):
            flush_text()
            # ESC d is print and feed n lines, unless the profile is using it
            # as a cut dialect, in which case n is 0 or 1 and the paper stops
            lines = data[index + 2]
            if lines > 1:
                sheet.feed(lines * 24)
                events.append({"at": index, "command": "feed lines",
                               "detail": str(lines), "bytes": 3})
            else:
                cuts += 1
                events.append({"at": index, "command": "cut",
                               "detail": "ESC d", "bytes": 3})
            index += 3
            continue

        matched = next(((seq, name) for seq, name in _NAMED
                        if data[index:index + len(seq)] == seq), None)
        if matched:
            flush_text()
            sequence, name = matched
            if name.startswith("cut"):
                cuts += 1
            events.append({"at": index, "command": name, "detail": "",
                           "bytes": len(sequence)})
            index += len(sequence)
            continue

        if byte == 0x0A:
            flush_text()
            sheet.feed(24)
            events.append({"at": index, "command": "line feed",
                           "detail": "", "bytes": 1})
            index += 1
            continue

        if byte == 0x1B or byte == 0x1D:
            flush_text()
            # an escape this reader does not know: say so with its bytes rather
            # than swallow it, since an unknown command is usually the answer
            tail = data[index:index + 4]
            events.append({"at": index, "command": "unknown",
                           "detail": tail.hex(" "), "bytes": 2})
            index += 2
            continue

        text.append(byte)
        index += 1

    flush_text()
    return {
        "image": sheet.image(),
        "events": events,
        "cuts": cuts,
        "width": width_dots,
        "height": sheet.height,
        "bytes": len(data),
    }


__all__ = ["emulate", "Sheet"]
