# Platforms

Linux is what this is built and tested on. The rest of this page is what a
contributor on another platform would be walking into, researched but not
verified on hardware, so that nobody has to start from nothing.

## Linux

Everything works: Bluetooth RFCOMM, USB through `/dev/usb/lp*`, and CUPS
queues. Tested on CachyOS with a 58 mm MPT-II over Bluetooth and USB.

## Windows

Closer than it looks.

- **Bluetooth.** CPython has supported `AF_BLUETOOTH` with `BTPROTO_RFCOMM` on
  Windows since 3.9, mapped onto Winsock's `AF_BTH`, with the same
  `(address, channel)` tuple this code already builds. The socket half should
  work unchanged. What does not port is pairing and discovery, which go through
  `bluetoothctl` and BlueZ here: on Windows you pair in Settings and the app
  would need the address typed in, or a WinRT enumeration package to list
  paired devices. Channel 1 is almost always right for these printers.
- **USB.** There is no character device. The way through is raw passthrough
  with `win32print`: open the queue, start a document with the `RAW` datatype,
  write the ESC/POS, close. `WindowsRawTransport` in
  [`src/core/transport.py`](../src/core/transport.py) does exactly that and is
  written but untested; it needs `pywin32`, which is not a dependency, so
  without it the app simply lists no Windows printers.
- **Avoid** driving USB through libusb. Windows binds `usbprint.sys` to printer
  class devices, so libusb needs the driver replaced, which breaks the printer
  for everything else on the machine.
- **pybluez is dead** (last commit December 2023, wheels stop at Python 3.7)
  and **bleak does not help**: it is BLE only, and these printers are Bluetooth
  Classic SPP.

## macOS

The one genuinely missing piece.

- **USB and CUPS.** CUPS is present, so the existing `lp` path should work once
  the printer has a queue. That is the cheapest way to a printing Mac and
  probably needs no new code at all.
- **Bluetooth.** Darwin has no Bluetooth socket layer, so `AF_BLUETOOTH` is not
  available and the socket transport cannot be used. A bonded device that
  advertises the standard serial service appears as `/dev/cu.<name>`, which can
  be opened and written to like any other device node; `list_usb_printers()`
  already globs for those on Darwin, so a printer that behaves that way may
  work today. Whether the node appears, and survives a reconnect, is the part
  that needs somebody with a Mac and one of these printers to confirm.
- If the node never appears, the fallback is IOBluetooth through pyobjc, which
  is a delegate and run-loop model with nothing in common with the current
  transport. That is a real piece of work rather than a branch.
- **Do not** plan on CUPS over Bluetooth on macOS: the CUPS Bluetooth backend
  has been broken since Sonoma.

## If you want to help

Windows Bluetooth and the `win32print` path are the closest to done, and both
can be tested without touching the rest of the app: a device profile, a
connection, and a page. macOS over CUPS is likely a documentation change rather
than a code one, and confirming or disproving the `/dev/cu.*` route would
settle the Bluetooth question there.

Issues and pull requests are welcome for any of it. The transports are small,
independent classes with a four method surface, which is where to start.
