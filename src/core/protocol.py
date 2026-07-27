# printer head width comes from config (printer.width) - images must match or be padded
# raster data uses packed bits: 8 pixels per byte, 1=ink (inverted from normal image)

import struct
from typing import Tuple, Type
from PIL import Image

from ..config.defaults import (
    FEED_MAX_DOTS,
    PRINTER_WIDTH_BITS_PER_BYTE,
    PROTOCOL_STATUS_RESPONSE_LENGTH,
    PROTOCOL_MODULO,
)
from .graphics_commands import build_bands
from ..config.printer_profile import (
    get_command,
    get_cut_style,
    get_density,
    get_flow,
    get_graphics_command,
    get_print_area,
    get_printer_width,
    supports,
)


class _ProtocolMeta(type):
    # resolved on every access so a config change takes effect without restart
    @property
    def PRINTER_WIDTH(cls) -> int:
        return get_printer_width()

    @property
    def CMD_STATUS_REQUEST(cls) -> bytes:
        return get_command("status_request")

    @property
    def CMD_START_PRINT(cls) -> bytes:
        return get_command("start_print")

    @property
    def CMD_END_PRINT(cls) -> bytes:
        return get_command("end_print")


class PrinterProtocol(metaclass=_ProtocolMeta):
    # standard ESC/POS - portable across essentially all thermal printers
    CMD_INITIALIZE = b"\x1b\x40"
    CMD_RASTER_BITMAP = b"\x1d\x76\x30\x00"

    # PRINTER_WIDTH / CMD_STATUS_REQUEST / CMD_START_PRINT / CMD_END_PRINT are
    # supplied by _ProtocolMeta from the active printer profile.

    CMD_LINE_FEED = b"\x0a"
    CMD_CARRIAGE_RETURN = b"\x0d"

    # --- optional ESC/POS features -------------------------------------------
    # Guarded by profile capability flags. Printers that do not implement these
    # may emit stray characters, so callers must check the supports_* helpers.

    # GS V - paper cut. m=0 full, m=1 partial
    CMD_CUT_FULL = b"\x1d\x56\x00"
    CMD_CUT_PARTIAL = b"\x1d\x56\x01"

    # Four ways to say "cut" and four to say "cut most of the way", because all
    # eight exist in the wild and a printer that does not know the one it is
    # sent prints the bytes instead of obeying them. The profile picks.
    CUT_COMMANDS = {
        "gsv0": b"\x1d\x56\x00",            # GS V 0, the common one
        "gsv65": b"\x1d\x56\x41\x00",       # GS V 65 n, feed then full cut
        "esci": b"\x1b\x69",                # ESC i, older Epson and clones
        "escd0": b"\x1b\x64\x00",           # ESC d 0
        "gsv1": b"\x1d\x56\x01",            # GS V 1, partial
        "gsv66": b"\x1d\x56\x42\x00",       # GS V 66 n, feed then partial
        "escm": b"\x1b\x6d",                # ESC m, partial on many clones
        "escd1": b"\x1b\x64\x01",           # ESC d 1
        "none": b"",
    }

    # the same table said in words, for a dropdown in the printer type editor
    CUT_LABELS = {
        "gsv0": "GS V 0, full cut, the common one",
        "gsv65": "GS V 65, feed then full cut",
        "esci": "ESC i, full cut, older Epson and clones",
        "escd0": "ESC d 0, full cut",
        "gsv1": "GS V 1, partial cut",
        "gsv66": "GS V 66, feed then partial cut",
        "escm": "ESC m, partial cut, many clones",
        "escd1": "ESC d 1, partial cut",
        "none": "No cutter",
    }

    # GS ( k - QR code function set
    _QR_MODEL = b"\x1d\x28\x6b\x04\x00\x31\x41\x32\x00"
    _QR_STORE_PREFIX = b"\x1d\x28\x6b"
    _QR_PRINT = b"\x1d\x28\x6b\x03\x00\x31\x51\x30"

    # GS k - barcode. 73 = CODE128
    _BARCODE_CODE128 = 73

    @classmethod
    def build_feed_dots(cls, dots: int) -> bytes:
        """ESC J - advance the paper by n dot rows.

        A bare LF only ever advances a whole line (1/6 inch by default), which
        is too coarse to align a tear-off against the tear bar. ESC J takes a
        single byte, so longer feeds are split into repeats.
        """
        if dots <= 0:
            return b""

        command = b""
        remaining = min(dots, FEED_MAX_DOTS)
        while remaining > 0:
            step = min(255, remaining)
            command += b"\x1b\x4a" + bytes([step])
            remaining -= step
        return command

    @classmethod
    def supports_cut(cls) -> bool:
        return supports("paperFullCut") or supports("paperPartCut")

    @classmethod
    def supports_qr(cls) -> bool:
        return supports("qrCode")

    @classmethod
    def supports_barcode(cls) -> bool:
        return supports("barcodeA")

    @classmethod
    def build_cut_command(cls, partial: bool = False) -> bytes:
        """Feed and cut, in whichever dialect the profile names.

        The feed before it is what carries the last printed line past the
        blade, and how far that is belongs to the printer's body rather than to
        this code, so the profile can say it in dots. Three line feeds remain
        the default, being what most of these printers want.
        """
        if not cls.supports_cut():
            return b""

        style = get_cut_style()
        wanted = style["partial"] if (partial and supports("paperPartCut")) else style["full"]
        command = cls.CUT_COMMANDS.get(wanted)
        if command is None:
            command = cls.CMD_CUT_PARTIAL if partial else cls.CMD_CUT_FULL
        if not command:
            return b""

        feed = (cls.build_feed_dots(style["feed_dots"])
                if style["feed_dots"] else cls.CMD_LINE_FEED * 3)
        return feed + command

    # --- density -------------------------------------------------------------
    # How hard the head burns. This is not the same as darkening the bitmap:
    # more heat makes the same dots blacker, where more contrast makes more
    # dots black and costs the edges. Printers disagree about the command, and
    # one that does not know it prints the bytes, so it is opt-in per profile.
    @classmethod
    def build_density_command(cls) -> bytes:
        """GS ( L fn49, the standard graphics density setting. b'' if unsupported."""
        density = get_density()
        if not density["supported"]:
            return b""
        level = max(0, min(8, int(density["level"])))
        # GS ( L pL pH m fn m: 2 bytes of parameters, function 49
        return b"\x1d\x28\x4c\x02\x00\x30\x31" + bytes([level])

    @classmethod
    def build_qr_command(cls, data: str, module_size: int = 6) -> bytes:
        """Native QR via GS ( k. Returns b'' when unsupported.

        Printing natively is sharper and far faster than rasterising, but the
        payload must fit the printer's buffer - hence the length guard.
        """
        if not cls.supports_qr() or not data:
            return b""

        payload = data.encode("utf-8", errors="replace")
        # 2 bytes of the length field are the function code, so 65535-3 is the
        # ceiling; anything near that is unprintable in practice anyway
        if len(payload) > 7089:
            return b""

        module_size = max(1, min(16, module_size))
        size_cmd = b"\x1d\x28\x6b\x03\x00\x31\x43" + bytes([module_size])
        # error correction level L
        ec_cmd = b"\x1d\x28\x6b\x03\x00\x31\x45\x30"

        length = len(payload) + 3
        store = (
            cls._QR_STORE_PREFIX
            + bytes([length % PROTOCOL_MODULO, length // PROTOCOL_MODULO])
            + b"\x31\x50\x30"
            + payload
        )

        return cls._QR_MODEL + size_cmd + ec_cmd + store + cls._QR_PRINT

    @classmethod
    def build_barcode_command(cls, data: str, height: int = 80, width: int = 2) -> bytes:
        """CODE128 barcode via GS k. Returns b'' when unsupported or invalid."""
        if not cls.supports_barcode() or not data:
            return b""

        try:
            payload = data.encode("ascii")
        except UnicodeEncodeError:
            # CODE128 subset B covers ASCII only
            return b""

        if len(payload) > 255:
            return b""

        height = max(1, min(255, height))
        width = max(2, min(6, width))

        # GS h (height), GS w (width), GS k m n data
        return (
            b"\x1d\x68" + bytes([height])
            + b"\x1d\x77" + bytes([width])
            + b"\x1d\x6b" + bytes([cls._BARCODE_CODE128, len(payload)])
            + payload
        )

    STATUS_RESPONSE_LENGTH = PROTOCOL_STATUS_RESPONSE_LENGTH

    # What the bits in an automatic status back (ASB) byte mean. The printer is
    # already telling us why it stopped; throwing the bytes away turned "the
    # paper has run out" into "it did not print".
    _STATUS_BITS = (
        (0x04, "cover_open", "The cover is open"),
        (0x08, "paper_feed", "The feed button is held down"),
        (0x20, "paper_out", "Out of paper"),
        (0x40, "error", "The printer is reporting an error"),
    )
    _ERROR_BITS = (
        (0x04, "cutter_error", "The cutter is jammed"),
        (0x08, "fatal_error", "An unrecoverable error"),
        (0x40, "over_temperature", "The head is too hot; let it cool"),
        (0x20, "voltage_error", "The supply voltage is out of range"),
    )

    @classmethod
    def decode_status(cls, raw: bytes) -> dict:
        """Turn a status reply into words.

        The reply is one byte in the common case and four when the printer
        answers with the full automatic status. Anything shorter than a byte
        means it did not answer, which is not the same as everything being
        well, so that is said too.
        """
        if not raw:
            return {"answered": False, "ok": None, "flags": [], "messages": []}

        first = raw[0]
        flags, messages = [], []
        for mask, flag, message in cls._STATUS_BITS:
            if first & mask:
                flags.append(flag)
                messages.append(message)

        # a four byte reply carries the error and paper bytes as well
        if len(raw) >= 3:
            for mask, flag, message in cls._ERROR_BITS:
                if raw[2] & mask:
                    flags.append(flag)
                    messages.append(message)
        if len(raw) >= 4 and raw[3] & 0x0C:
            flags.append("paper_low")
            messages.append("The paper is nearly out")

        serious = {"paper_out", "cover_open", "cutter_error",
                   "fatal_error", "over_temperature", "voltage_error"}
        return {
            "answered": True,
            "ok": not serious.intersection(flags),
            "flags": flags,
            "messages": messages,
            "raw": raw.hex(),
        }

    @classmethod
    def fit_to_head(cls, image: Image.Image) -> Image.Image:
        """Put a composed page where the head can print it.

        A page is composed at the printable width, which is the head unless the
        profile says the printer prints less of it than it has. Anything
        narrower is padded out to the head with blank dots and offset by the
        left margin, because the raster command counts in whole bytes of head
        and a short row would desynchronise every row after it.
        """
        area = get_print_area()
        head = area["max_dots"]
        if image.size[0] == head:
            return image
        if image.size[0] > head:
            return image.crop((0, 0, head, image.size[1]))

        # mode "1" here is already inverted for the wire, where 0 is no dot
        sheet = Image.new(image.mode, (head, image.size[1]), 0)
        left = min(area["margin_left"], head - image.size[0])
        sheet.paste(image, (left, 0))
        return sheet

    @classmethod
    def build_raster_command(cls: Type["PrinterProtocol"], image: Image.Image) -> bytes:
        image = cls.fit_to_head(image)
        width_bytes = image.size[0] // PRINTER_WIDTH_BITS_PER_BYTE
        height = image.size[1]

        command = bytearray(cls.CMD_RASTER_BITMAP)

        # width low byte then high byte
        command.extend(struct.pack('2B', width_bytes % PROTOCOL_MODULO, width_bytes // PROTOCOL_MODULO))

        # height low byte then high byte
        command.extend(struct.pack('2B', height % PROTOCOL_MODULO, height // PROTOCOL_MODULO))

        command.extend(image.tobytes())
        return bytes(command)

    # One command for a whole page asks the printer to hold the whole page.
    # These printers cannot, so the page is handed over a band at a time: each
    # band is a complete raster command, which the firmware finishes before it
    # reads the next one. A late or lost byte can then spoil one band rather
    # than every row below it, and the head is never asked to buffer more than
    # it can print.
    BAND_ROWS = 64

    @classmethod
    def build_raster_bands(cls, image: Image.Image, band_rows: int = 0):
        """Yield the page as complete commands, a band at a time.

        Which command that is belongs to the profile: GS v 0 for almost
        everything, column mode for the firmwares that never learned it. The
        band height is the profile's too, since how much a printer can hold is
        a fact about the printer.
        """
        rows = band_rows or get_flow()["band_rows"] or cls.BAND_ROWS
        yield from build_bands(cls.fit_to_head(image), get_graphics_command(), rows)

    @classmethod
    def calculate_dimensions(cls: Type["PrinterProtocol"], width: int, height: int) -> Tuple[bytes, bytes]:
        w_bytes = width // PRINTER_WIDTH_BITS_PER_BYTE
        width_bytes = struct.pack('2B', w_bytes % PROTOCOL_MODULO, w_bytes // PROTOCOL_MODULO)
        height_bytes = struct.pack('2B', height % PROTOCOL_MODULO, height // PROTOCOL_MODULO)
        return width_bytes, height_bytes

    @classmethod
    def get_line_feeds(cls: Type["PrinterProtocol"], count: int = 1) -> bytes:
        return cls.CMD_LINE_FEED * count
