# printer head width comes from config (printer.width) - images must match or be padded
# raster data uses packed bits: 8 pixels per byte, 1=ink (inverted from normal image)

import struct
from typing import Tuple, Type
from PIL import Image

from ..config.defaults import (
    PRINTER_WIDTH_BITS_PER_BYTE,
    PROTOCOL_STATUS_RESPONSE_LENGTH,
    PROTOCOL_MODULO,
)
from ..config.printer_profile import get_printer_width, get_command, supports


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

    # GS ( k - QR code function set
    _QR_MODEL = b"\x1d\x28\x6b\x04\x00\x31\x41\x32\x00"
    _QR_STORE_PREFIX = b"\x1d\x28\x6b"
    _QR_PRINT = b"\x1d\x28\x6b\x03\x00\x31\x51\x30"

    # GS k - barcode. 73 = CODE128
    _BARCODE_CODE128 = 73

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
        """Feed and cut. Returns b'' when the profile has no cutter."""
        if not cls.supports_cut():
            return b""
        if partial and supports("paperPartCut"):
            return cls.CMD_LINE_FEED * 3 + cls.CMD_CUT_PARTIAL
        return cls.CMD_LINE_FEED * 3 + cls.CMD_CUT_FULL

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

    @classmethod
    def build_raster_command(cls: Type["PrinterProtocol"], image: Image.Image) -> bytes:
        width_bytes = image.size[0] // PRINTER_WIDTH_BITS_PER_BYTE
        height = image.size[1]

        command = bytearray(cls.CMD_RASTER_BITMAP)

        # width low byte then high byte
        command.extend(struct.pack('2B', width_bytes % PROTOCOL_MODULO, width_bytes // PROTOCOL_MODULO))

        # height low byte then high byte
        command.extend(struct.pack('2B', height % PROTOCOL_MODULO, height // PROTOCOL_MODULO))

        command.extend(image.tobytes())
        return bytes(command)

    @classmethod
    def calculate_dimensions(cls: Type["PrinterProtocol"], width: int, height: int) -> Tuple[bytes, bytes]:
        w_bytes = width // PRINTER_WIDTH_BITS_PER_BYTE
        width_bytes = struct.pack('2B', w_bytes % PROTOCOL_MODULO, w_bytes // PROTOCOL_MODULO)
        height_bytes = struct.pack('2B', height % PROTOCOL_MODULO, height // PROTOCOL_MODULO)
        return width_bytes, height_bytes

    @classmethod
    def get_line_feeds(cls: Type["PrinterProtocol"], count: int = 1) -> bytes:
        return cls.CMD_LINE_FEED * count
