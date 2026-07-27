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
CTP-500 and the NT-5890K.

A printer nobody has written down can be described instead: **Describe one**,
beside the printer type in Add a device, takes a name, a vendor, the head width
in dots, the resolution and the feature flags. Editing a shipped type copies
it; editing one of your own edits it. What you write is kept in
`~/.local/share/thermal-printer/printer-profiles.json` in the same schema and
merged over the shipped table, so a bundled entry can be corrected the same way
and nothing is lost when the app is updated.

The head width is the part that has to be right. Everything else degrades
gracefully: a QR code on a printer with no QR command is drawn into the picture
instead, which is slower and softer but always prints.

## How to talk to it

What a printer can do and how to reach it are different questions, and the
escpos-printer-db schema only answers the first. The second lives in blocks of
this project's own, under **How to talk to it** in the type editor, and it is
folded away because the defaults are right for nearly every printer.

- **Printer language.** Receipt printers speak ESC/POS. The label printers sold
  beside them usually speak TSPL, which thinks in labels of a declared size
  rather than in an endless roll. A TSPL printer sent ESC/POS prints a label of
  characters and stops. The TSPL driver is written but untested: no label
  printer has been through it, so treat it as a starting point and tell us how
  it goes.
- **Images are sent as.** `GS v 0` is the raster command nearly everything
  understands. Firmwares that do not know it print the bytes as characters,
  which is what "my pictures come out as garbage" means; column mode
  (`ESC *`) is the older way and works nearly everywhere.
- **Flow.** Bytes per write, the pause between writes, rows per image command,
  and how long to wait before closing. These four decide whether a long page
  prints or streaks: a printer that drops the bottom half of everything is
  being fed faster than it can burn.
- **Cut.** Eight dialects exist in the wild and a printer sent the wrong one
  prints the bytes instead of obeying them. The feed before the cut is how far
  the last line has to travel to clear the blade.
- **Heat.** More heat makes the same dots blacker. More darkness, in the page
  settings, makes more dots black and costs the fine detail, so reach for heat
  first if the printer accepts it.
- **Before and after a job.** Two byte sequences, in hex, for printers that
  want a reset, a character set or a last feed the firmware forgets.

If a page still comes out wrong, **What goes on the wire** in Settings reads
the byte stream back as paper: the picture it describes and every command in
it, with the ones it does not recognise called out. A capture from another app
can be pasted in the same way, which is how to find out what that app does
differently on the same printer.

## The paper and the print area

These are two different widths and confusing them is the usual reason a page
comes out wrong. The roll is 58 mm; the head prints 48 mm of it, 384 dots at
203 dpi. The rest is margin whether you asked for one or not.

The preview says so: the sheet is drawn at the width of the roll and the part
the head can reach is outlined inside it. Turn it off in Settings under Paper
if you would rather see the bitmap alone.

Both numbers belong to the printer type, so **Describe one** takes the paper
width in millimetres and the print area in dots, with a **From mm** button that
does the multiplication: dots are millimetres times eight at 203 dpi, times
twelve at 304, rounded down to a whole byte because eight dots share one. The
hint under the field says what the numbers come to, and warns you when the
print area is wider than the paper you said it uses.

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

## Along the roll

A page composed along the roll is turned a quarter turn before it is sent, and
the blank end of the strip is cut off first, so the paper used is the paper the
words needed. What bounds it is the strip length: that is how much room a line
has, not how much paper the job will take.

## Printing rules

Writes are serialised behind a lock. A thermal printer is a single serial
stream, so two overlapping jobs would interleave their bytes and print garbage.
The lock holds however many tabs are open and whichever pane the job came from.
