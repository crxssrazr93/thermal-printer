# the receipt printer language, which is what nearly everything here speaks
#
# Nothing new is invented here: the commands live in protocol.py and
# graphics_commands.py, and this is the driver interface put in front of them
# so that a second language can exist beside them.

from typing import Iterator

from PIL import Image

from .base import Driver


class EscPosDriver(Driver):
    name = "escpos"

    def prologue(self) -> bytes:
        from ..protocol import PrinterProtocol
        # density before the vendor's start sequence, and both after the
        # reset, which is the order these printers were tested in
        return (PrinterProtocol.CMD_INITIALIZE
                + PrinterProtocol.build_density_command()
                + PrinterProtocol.CMD_START_PRINT)

    def bands(self, image: Image.Image) -> Iterator[bytes]:
        from ..protocol import PrinterProtocol
        return PrinterProtocol.build_raster_bands(image)

    def epilogue(self, feed_dots: int = 0) -> bytes:
        from ..protocol import PrinterProtocol
        tail = PrinterProtocol.build_feed_dots(feed_dots) if feed_dots else b""
        return tail + PrinterProtocol.CMD_END_PRINT
