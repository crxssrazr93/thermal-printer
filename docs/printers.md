# Printers

## Transports

A printer is reached one of three ways, and the app treats all three the same
once the connection is open: bytes go out, the printer prints.

| Transport | What it is | When to use it |
|-----------|------------|----------------|
| Bluetooth | An RFCOMM socket to a paired device | Battery printers, anything portable |
| USB | The character device the kernel exposes, usually `/dev/usb/lp0` | A printer on a cable, no pairing to lose |
| CUPS | An existing print queue, driven with `lp` | A printer already set up on the machine or on the network |

Bluetooth is the one with prerequisites: the device has to be paired first
(`bluetoothctl` does this, or your desktop's Bluetooth panel), and BlueZ has to
be running. USB needs your user to be in the group that owns the device node,
which is `lp` on most distributions.

## Devices

Settings lists what the machine can see and lets you save any of it as a
profile: a name, a transport, an address, a capability profile and a tear-off
gap. Saved profiles appear in the picker at the top of the window, and the app
reconnects to the active one on demand rather than holding the port open.

Profiles live in `config.yaml` beside the code. That file holds your printer's
MAC address, so it is deliberately not committed;
[`config.example.yaml`](../config.example.yaml) shows its shape.

## Capability profiles

Printers agree on the basics of ESC/POS and disagree on everything else, so
what a given model can do is data rather than code. The profiles follow the
[escpos-printer-db](https://github.com/receipt-print-hq/escpos-printer-db)
schema and say the head width, whether the printer can cut, and whether it has
native QR and barcode commands. Choosing the right one means QR codes print as
QR codes rather than as pictures of QR codes, which is both sharper and much
faster.

The shipped set covers generic 58 mm and 80 mm printers, the Core Innovation
CTP-500 and the NT-5890K. Adding one is an entry in the same JSON.

## The tear-off gap

Paper has to come out far enough to clear the tear bar, and how far is a fact
about the printer's body rather than a preference. Settings has a small wizard
for it: print the test strip, tear it off, and see where the tear landed
against the printed line. On the line means the gap is right; short of it means
the paper needs to come out further, so step up a millimetre and print again.
Saving it means every job afterwards feeds that much and stops in the right
place.

## What gets sent

The renderer produces a 1-bit page at the head's width. `ImageProcessor` turns
that into raster bytes, inverting the polarity because a set bit means a fired
dot. The page then goes out **a band at a time**, 64 rows to a band, each band
its own `GS v 0` command.

That banding matters. A whole page in one command asks the printer to hold the
whole page, which these printers cannot do; the buffer fills, bytes are
dropped, and everything after the drop lands shifted, so the tail of the
receipt comes out as vertical streaks. Every write also goes out in full in
small pieces, because a socket send is free to accept less than it is given and
silently drop the rest.

## Printing rules

Writes are serialised behind a lock. A thermal printer is a single serial
stream, so two overlapping jobs would interleave their bytes and print garbage.
The lock holds however many tabs are open and whichever pane the job came from.
