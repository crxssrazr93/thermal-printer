# the label printer language
#
# TSPL thinks in labels, not in paper. A job says how big the label is, how big
# the gap between labels is, clears the buffer, puts a bitmap at a position on
# it and prints one copy. There is no notion of a page that keeps going, which
# is why an ESC/POS stream sent to one of these prints a label of gibberish and
# then stops.
#
# The commands are lines of ASCII terminated by CRLF, with one binary payload:
# BITMAP, whose data is packed one bit per dot, and inverted with respect to
# ESC/POS - here a set bit is bare label and a clear bit is ink.

from typing import Iterator

from PIL import Image

from .base import Driver
from ...config.printer_profile import dots_to_mm, get_profile


def _label_geometry(image: Image.Image):
    """Label size and gap in millimetres, which is what TSPL takes."""
    media = (get_profile().get("media") or {})
    label = media.get("label") or {}
    try:
        width_mm = float(label.get("width_mm") or dots_to_mm(image.width))
    except (TypeError, ValueError):
        width_mm = dots_to_mm(image.width)
    try:
        height_mm = float(label.get("height_mm") or dots_to_mm(image.height))
    except (TypeError, ValueError):
        height_mm = dots_to_mm(image.height)
    try:
        gap_mm = float(label.get("gap_mm") or 0)
    except (TypeError, ValueError):
        gap_mm = 0.0
    return width_mm, height_mm, gap_mm


class TsplDriver(Driver):
    name = "tspl"

    def prologue(self) -> bytes:
        # Deliberately empty: SIZE and GAP depend on the picture, so the whole
        # job is emitted in bands() where the picture is in hand. A prologue
        # that guessed the size would be a label wasted per guess.
        return b""

    def bands(self, image: Image.Image) -> Iterator[bytes]:
        """One label: geometry, then the bitmap, then print one copy.

        Not banded, because TSPL has nothing to band: the printer holds the
        whole label before it prints any of it. Labels are small enough that
        this is not the buffer problem it would be on a receipt roll.
        """
        # the image arrives in wire polarity for the raster protocol, where a
        # set bit is a fired dot, so bare label is 0 here and inverted at the end
        mono = image.convert("1")
        width_bytes = (mono.width + 7) // 8
        if mono.width % 8:
            padded = Image.new("1", (width_bytes * 8, mono.height), 0)
            padded.paste(mono, (0, 0))
            mono = padded

        width_mm, height_mm, gap_mm = _label_geometry(mono)

        header = (
            f"SIZE {width_mm:.1f} mm,{height_mm:.1f} mm\r\n"
            f"GAP {gap_mm:.1f} mm,0 mm\r\n"
            "DIRECTION 0\r\n"
            "CLS\r\n"
        ).encode("ascii")

        # BITMAP x,y,width in bytes,height in dots,mode,data. Mode 0 overwrites.
        bitmap = (f"BITMAP 0,0,{width_bytes},{mono.height},0,").encode("ascii")

        # TSPL reads a set bit as bare label and a clear bit as ink, which is
        # the opposite of what arrived, so the picture is flipped on the way out
        payload = bytes(255 - byte for byte in mono.tobytes())

        yield header + bitmap + payload + b"\r\n"

    def epilogue(self, feed_dots: int = 0) -> bytes:
        # PRINT copies,sets. A label printer feeds to the next gap itself, so
        # the tear-off feed that a receipt roll needs has nothing to do here.
        return b"PRINT 1,1\r\n"
