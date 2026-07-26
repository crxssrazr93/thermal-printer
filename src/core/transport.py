# non-bluetooth transports
#
# PrinterConnection was written against a raw RFCOMM socket and only ever calls
# send / recv / shutdown / close on it. These classes present the same surface
# so a USB or CUPS-backed printer can be driven by the identical code path.

import errno
import glob
import logging
import os
import socket
import subprocess
import time
from typing import List, Optional

logger = logging.getLogger(__name__)

# usblp character devices exposed by the kernel for USB class-7 printers
USB_PRINTER_GLOB = "/dev/usb/lp*"

# Rough consumption rate of a 203 dpi thermal head, used only to size the drain
# pause before closing. Deliberately conservative - overshooting costs a moment,
# undershooting truncates the print.
USB_DRAIN_BYTES_PER_SECOND = 12000
MAX_DRAIN_SECONDS = 8.0


class TransportError(Exception):
    pass


class UsbTransport:
    """Socket-like wrapper around a USB printer character device.

    Thermal printers on the usblp driver appear as /dev/usb/lp0 and accept raw
    ESC/POS on write(). Reads are best-effort: many units never reply, so recv()
    returns b'' on timeout rather than blocking the UI thread forever.
    """

    def __init__(self, device_path: str, read_timeout: float = 0.4):
        self.device_path = device_path
        self._read_timeout = read_timeout
        self._fd: Optional[int] = None
        self._bytes_written = 0

    # -- lifecycle ------------------------------------------------------------
    def connect(self, _address=None) -> None:
        try:
            # Blocking writes. With O_NONBLOCK the kernel accepts only what fits
            # in the usblp buffer and the rest has to be retried; closing before
            # the device has drained silently truncates the job mid-raster.
            self._fd = os.open(self.device_path, os.O_RDWR)
            self._bytes_written = 0
        except PermissionError as error:
            raise TransportError(
                f"No permission to open {self.device_path}. Add your user to the "
                f"'lp' group and re-login: {error}"
            )
        except OSError as error:
            if error.errno == errno.ENOENT:
                raise TransportError(
                    f"{self.device_path} does not exist - is the printer plugged in "
                    f"and powered on?"
                )
            raise TransportError(f"Could not open {self.device_path}: {error}")

    def close(self) -> None:
        if self._fd is None:
            return

        # Let the printer consume what is still buffered. Closing immediately
        # after the final write drops the tail of the job - the last raster
        # rows and any trailing feeds simply never appear.
        try:
            os.fsync(self._fd)
        except OSError:
            pass

        if self._bytes_written:
            time.sleep(min(MAX_DRAIN_SECONDS,
                           self._bytes_written / USB_DRAIN_BYTES_PER_SECOND))

        try:
            os.close(self._fd)
        except OSError:
            pass
        self._fd = None
        self._bytes_written = 0

    def shutdown(self, _how=None) -> None:
        # nothing to half-close on a character device
        pass

    # -- io -------------------------------------------------------------------
    def send(self, data: bytes) -> int:
        if self._fd is None:
            raise socket.error("USB transport is not open")

        total = 0
        while total < len(data):
            try:
                total += os.write(self._fd, data[total:])
            except BlockingIOError:
                # only reachable if the fd was reopened non-blocking
                continue
            except OSError as error:
                raise socket.error(f"USB write failed: {error}")
        self._bytes_written += total
        return total

    def recv(self, size: int) -> bytes:
        if self._fd is None:
            raise socket.error("USB transport is not open")
        try:
            return os.read(self._fd, size)
        except BlockingIOError:
            return b""
        except OSError:
            return b""


class CupsTransport:
    """Socket-like wrapper that spools raw bytes to a CUPS queue via lp.

    Useful when the printer is already configured in CUPS - it works for USB,
    network and Bluetooth-backed queues alike without touching device nodes.
    """

    def __init__(self, queue_name: str):
        self.queue_name = queue_name
        self._buffer = bytearray()
        self._open = False

    def connect(self, _address=None) -> None:
        if not _queue_exists(self.queue_name):
            raise TransportError(f"CUPS queue {self.queue_name!r} not found")
        self._buffer.clear()
        self._open = True

    def close(self) -> None:
        if self._open and self._buffer:
            self.flush()
        self._open = False

    def shutdown(self, _how=None) -> None:
        pass

    def send(self, data: bytes) -> int:
        if not self._open:
            raise socket.error("CUPS transport is not open")
        self._buffer.extend(data)
        return len(data)

    def recv(self, _size: int) -> bytes:
        # a spooled queue gives no back-channel
        return b""

    def flush(self) -> None:
        """Submit the buffered job. CUPS is spooled, so bytes only reach the
        printer as a complete job rather than streaming like a socket."""
        if not self._buffer:
            return
        try:
            subprocess.run(
                ["lp", "-d", self.queue_name, "-o", "raw", "-"],
                input=bytes(self._buffer),
                check=True,
                capture_output=True,
            )
        except (subprocess.CalledProcessError, FileNotFoundError) as error:
            raise socket.error(f"Failed to spool job to {self.queue_name}: {error}")
        finally:
            self._buffer.clear()


# -----------------------------------------------------------------------------
# discovery
# -----------------------------------------------------------------------------
def list_usb_printers() -> List[str]:
    """Character devices that look like USB printers, newest first."""
    return sorted(glob.glob(USB_PRINTER_GLOB))


def list_cups_queues() -> List[str]:
    try:
        result = subprocess.run(
            ["lpstat", "-p"], capture_output=True, text=True, timeout=5
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return []

    queues = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "printer":
            queues.append(parts[1])
    return queues


def _queue_exists(name: str) -> bool:
    return name in list_cups_queues()
