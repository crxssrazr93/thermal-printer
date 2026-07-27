# the several ways a thermal printer will accept a bitmap
#
# GS v 0 is the one nearly everything understands, and it is the default here.
# It is not universal: older firmwares, STAR-derived ones and a few clones
# either ignore it or print the bytes as characters, which is what "my images
# come out as garbage" usually means. So the opcode is a property of the
# printer rather than a constant, and this module holds one builder per opcode.
#
# Every builder takes a 1-bit image, already the right width and already
# inverted for the wire, and yields complete commands a band at a time. A band
# is a whole command the firmware finishes before reading the next, which is
# what stops the buffer filling mid-page.

import struct
from typing import Iterator

from PIL import Image

from ..config.defaults import PRINTER_WIDTH_BITS_PER_BYTE, PROTOCOL_MODULO

# ESC * modes: (mode byte, dot rows per pass). 0 and 1 are eight dot single and
# double speed; 32 and 33 are twenty four dot, which is what most 58 mm heads
# were designed around before raster mode existed.
_ESC_STAR_MODES = {
    "esc_star_0": (0, 8),
    "esc_star_1": (1, 8),
    "esc_star_32": (32, 24),
    "esc_star_33": (33, 24),
}

COMMANDS = {
    "gsv0": "GS v 0, the raster command nearly everything speaks",
    "gsv0_escj": "GS v 0, with an explicit feed after each band",
    "esc_star_33": "ESC * 33, twenty four dot column mode, double density",
    "esc_star_32": "ESC * 32, twenty four dot column mode",
    "esc_star_1": "ESC * 1, eight dot column mode, double density",
    "esc_star_0": "ESC * 0, eight dot column mode",
}


def _raster(band: Image.Image) -> bytes:
    """GS v 0: width in bytes, height in rows, then the rows themselves."""
    width_bytes = band.size[0] // PRINTER_WIDTH_BITS_PER_BYTE
    height = band.size[1]
    command = bytearray(b"\x1d\x76\x30\x00")
    command.extend(struct.pack("2B", width_bytes % PROTOCOL_MODULO,
                               width_bytes // PROTOCOL_MODULO))
    command.extend(struct.pack("2B", height % PROTOCOL_MODULO,
                               height // PROTOCOL_MODULO))
    command.extend(band.tobytes())
    return bytes(command)


def _esc_star(band: Image.Image, mode: int, rows: int) -> bytes:
    """ESC * m nL nH: columns rather than rows.

    Column mode reads the image the other way round. Each byte is a vertical
    run of eight dots, and a pass covers eight or twenty four rows at a time,
    so the image is transposed here rather than on the printer. It is slower to
    build and slower to print, which is why it is the fallback and not the
    default.
    """
    width = band.size[0]
    pixels = band.load()
    out = bytearray()

    for top in range(0, band.size[1], rows):
        out += b"\x1b\x2a" + bytes([mode])
        out += struct.pack("2B", width % PROTOCOL_MODULO, width // PROTOCOL_MODULO)
        for x in range(width):
            for byte_index in range(rows // 8):
                value = 0
                for bit in range(8):
                    y = top + byte_index * 8 + bit
                    if y < band.size[1] and pixels[x, y]:
                        value |= 0x80 >> bit
                out.append(value)
        # a column pass leaves the head where it started, so the paper is moved
        out += b"\x1b\x4a" + bytes([rows])
    return bytes(out)


def build_bands(image: Image.Image, command: str = "gsv0",
                band_rows: int = 64) -> Iterator[bytes]:
    """Yield the whole image as complete commands, a band at a time."""
    rows = max(8, band_rows)
    esc_star = _ESC_STAR_MODES.get(command)

    for top in range(0, image.size[1], rows):
        band = image.crop((0, top, image.size[0],
                           min(top + rows, image.size[1])))
        if esc_star:
            mode, pass_rows = esc_star
            yield _esc_star(band, mode, pass_rows)
        elif command == "gsv0_escj":
            # some firmwares print the band but do not advance the paper until
            # they are told to, which stacks every band on the same rows
            yield _raster(band) + b"\x1b\x4a" + bytes([min(255, band.size[1])])
        else:
            yield _raster(band)
