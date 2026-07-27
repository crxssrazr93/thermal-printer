# one driver per printer language
#
# ESC/POS is the language of receipt printers, and it is what nearly everything
# in this price range speaks. It is not the only one: the label printers sold
# beside them, the ones that expect a roll of gapped or black-marked stock,
# usually speak TSPL instead, and a TSPL printer sent ESC/POS prints the bytes
# as characters and wastes a label doing it.
#
# The two languages disagree about everything except the picture: one streams
# bands down an endless roll, the other declares a label of a known size, puts
# a bitmap on it and prints it. So the driver is chosen by the profile, and
# each one answers the same three questions: what to send before a job, how to
# send the picture, and what to send after.

from typing import Dict, Type

from .base import Driver
from .escpos import EscPosDriver
from .tspl import TsplDriver

DRIVERS: Dict[str, Type[Driver]] = {
    "escpos": EscPosDriver,
    "tspl": TsplDriver,
}

DRIVER_LABELS = {
    "escpos": "ESC/POS, receipt printers",
    "tspl": "TSPL, label printers",
}


def get_driver(name: str = "") -> Driver:
    """The driver the active profile asks for, ESC/POS unless it says otherwise."""
    if not name:
        from ...config.printer_profile import get_driver_name
        name = get_driver_name()
    return DRIVERS.get(name, EscPosDriver)()


__all__ = ["Driver", "DRIVERS", "DRIVER_LABELS", "get_driver"]
