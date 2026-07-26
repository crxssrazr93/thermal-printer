# Changes in this fork

Attribution for everything this builds on is in `doc/CREDITS.md`.

## 1. Not hardcoded to the CTP-500

Upstream targeted one printer. Three things were baked in:

- `PrinterProtocol.PRINTER_WIDTH = 384` was a class constant, and it was used as
  a **default argument value** in `TextRenderer`, `ImageProcessor`,
  `CalendarRenderer`, `LabelRenderer` and `BannerFrame`. Default arguments are
  evaluated at import time, so `printer.width` in `config.yaml` had no effect on
  rendering — setting it to 576 for an 80mm printer changed nothing.
- The start/end/status byte sequences (`GS I f0 19`, `0x9a`, `RS G 3`) are CTP-500
  vendor extensions, not ESC/POS, and were sent unconditionally to every printer.
- A width that was not a multiple of 8 would desynchronise every raster row,
  with no guard.

Now:

- Capability profiles live in `src/config/data/printer_profiles.json`, using the
  **escpos-printer-db** schema so they are portable to python-escpos and
  escpos-php.
- `config/printer_profile.py` resolves width, capability flags and vendor
  commands **at call time**, so config changes take effect.
- Width is rounded down to a whole byte (580 → 576).
- An explicit `printer.width` overrides the profile, for hardware that does not
  quite match its profile.
- Profiles ship for generic 58mm, generic 80mm, NT-5890K and the CTP-500. The
  CTP-500 remains the default so existing users are unaffected.
- The profile is selectable in **Settings → Printer**, which also shows the
  resolved width and capabilities.

## 2. USB and CUPS transports

Upstream was Bluetooth-only: `connect()` took a MAC address and opened an RFCOMM
socket, and that was the sole path.

`src/core/transport.py` adds two socket-compatible transports, so the same code
drives all three:

- `UsbTransport` — writes to `/dev/usb/lp*`. Opened non-blocking, so a printer
  that never replies cannot wedge the UI thread.
- `CupsTransport` — spools via `lp -o raw` to any configured queue, covering USB,
  network and Bluetooth-backed queues.

New entry points: `PrinterConnection.connect_usb()`, `.connect_cups()`,
`.list_usb_devices()`, `.list_cups_destinations()`.

## 3. Native QR, barcode and paper cut

Previously everything had to be rasterised as an image. Added, each gated behind
the active profile's capability flags so unsupported printers are never sent
commands they would echo as garbage:

- `build_qr_command()` — `GS ( k`, guarded by `qrCode`
- `build_barcode_command()` — CODE128 via `GS k`, guarded by `barcodeA`
- `build_cut_command()` — `GS V`, guarded by `paperFullCut` / `paperPartCut`

## 4. Responsive layout

The control rows used `pack(side="left")` with hardcoded pixel widths
(`width=50/75/85/160/180/240`). They could neither shrink nor grow, so:

- Narrowing the window **silently clipped controls off the right edge**. Below
  roughly 840px the **Symbols** button and **Add Date** checkbox became
  unreachable — not wrapped or scrolled, just gone. `MIN_WINDOW_WIDTH` was 600,
  so the window was resizable into a broken state.
- Widening left a large dead band; only the text area expanded.

`src/gui/widgets/flow_frame.py` adds a `FlowFrame` container that lays children
out left to right and **wraps onto a new row** when width runs out, reporting its
own height so the parent allocates correctly. Applied to the control rows in
`base_text_frame.py` and `image_frame.py`. At 640px wide the controls now wrap to
four rows with everything reachable.

## 5. Launcher fixes

- The shipped `.desktop` used
  `Exec=bash -c 'cd "$HOME/code/personal/print" && ./run.sh'` — an unquoted `&`
  and nested quotes, which fails `desktop-file-validate` and can be rejected by
  the launcher. `Exec` now points straight at `run.sh`.
- That required `run.sh` to set its own working directory (`cd "$SCRIPT_DIR"`),
  since `python -m src.main` only resolves with the repo root as cwd.

## Known limitations

- `config.yaml` is tracked in git upstream, so local settings (including the
  printer MAC address) show as modifications. It should arguably be gitignored
  with a shipped `config.example.yaml`.
- The CTP-500 vendor commands remain unverified on non-CTP-500 hardware; the
  `generic-*` profiles avoid them entirely.
- `CupsTransport` is spooled, not streaming — bytes reach the printer as one job
  on `close()`, so interactive status reads are not meaningful on that path.
