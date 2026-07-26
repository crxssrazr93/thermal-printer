# Credits and Attribution

This is a fork of [n3m0-22/thermal-printer](https://github.com/n3m0-22/thermal-printer),
which is itself built on earlier community reverse-engineering work. Everything
below is upstream of this fork and deserves the credit for the project existing
at all.

## Upstream project

**[n3m0-22/thermal-printer](https://github.com/n3m0-22/thermal-printer)** — the
direct parent of this fork. The GUI, template system, calendar renderer, symbol
picker, Unicode handling and Wayland support are all its work. Licensed
AGPL-3.0; this fork remains AGPL-3.0.

## Original protocol research

The Core Innovation CTP-500 Bluetooth protocol was reverse-engineered by the
maker and hacker community. Per the upstream credits:

- **Mel (ThirtyThreeDown Studio)** — primary developer of the original
  `CTP500PrinterApp`; Bluetooth protocol analysis and GUI implementation.
  <https://thirtythreedown.com> ·
  <https://github.com/thirtythreedown/CTP500PrinterApp>
- **voidsshadows** — creator of the CorePrint print server, the stripped-down
  Python implementation that formed the foundation.
  <https://github.com/voidsshadows/CorePrint-print-server>
- **SecKC contributors** (<https://seckc.org>) — **bitflip** (shared critical
  code resources and collaboration) and **Tsathoggualware** (research and
  development support).

## Data and specifications used by this fork

- **[escpos-printer-db](https://github.com/receipt-print-hq/escpos-printer-db)**
  — the printer capability schema in `src/config/data/printer_profiles.json`
  follows this project's format (`media.width.{mm,pixels}`, `features`,
  `vendor`, `notes`), and the `nt-5890k` capability data is taken from it.
  Licensed **CC BY 4.0**. The same database backs
  [python-escpos](https://github.com/python-escpos/python-escpos) and
  escpos-php, so profiles are portable between all three projects.

  The `commands` block is a local extension and is *not* part of the upstream
  schema — escpos-printer-db assumes standards-compliant printers, whereas some
  units need vendor byte sequences wrapped around a job.

- **[python-escpos](https://github.com/python-escpos/python-escpos)** — used as
  the reference for the ESC/POS command encodings added in this fork:
  `GS ( k` (QR code), `GS k` / `GS h` / `GS w` (CODE128 barcode) and `GS V`
  (paper cut). No code was copied; only the published command formats were
  followed.

- **ESC/POS command set** — originally specified by Seiko Epson Corporation.

## Fonts

- **Catrinity** (`fonts/Catrinity.ttf`) — see `fonts/Catrinity-OFL.txt` for its
  SIL Open Font License terms. Bundled by upstream.

## Changes made in this fork

See `doc/FORK-CHANGES.md`.
