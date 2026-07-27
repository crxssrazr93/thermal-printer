# RawBT 7.1.2 vs Thermal Print Studio — findings

Sources used, and how to reproduce every quote:

- APK: `/tmp/claude-1000/-home-crxssrazr93/147e97a1-a302-48a3-a93d-6eabef44076a/scratchpad/rawbt/base/`
  - `strings -n 6 base/classes.dex` → written to `scratchpad/dex.txt` (32,225 lines)
  - `strings -n 8 base/resources.arsc` → written to `scratchpad/arsc.txt` (6,785 lines; the
    English UI copy sits roughly at lines 796–1400, the pool is alphabetically sorted)
  - `base/assets/app/index.html`, `base/assets/app/app.js`, `base/assets/app/iconv-lite.bundle.js`
- Public repo: <https://github.com/402d/RawBt-and-ESCPOS-coffee>
- This app: README.md, docs/, src/, web/

Conventions in this document: **[EVIDENCE]** = a literal string or file path pulled from the
APK or the repo. **[INFERENCE]** = my reading of what that string implies; not directly proven.

A note on the GitHub repo up front, because it shapes what can and cannot be claimed:
`402d/RawBt-and-ESCPOS-coffee` is **not** RawBT's engine. It is a 6-commit Unlicense demo
Android app (`app/`, `MainActivity.java`) showing how to drive RawBT from the escpos-coffee
Java library. Its README states the library's graphics path "cannot operate in Android
environments, as it requires `java.awt.image.BufferedImage`" and calls implementing it
"Impossible" without redesign. So RawBT's actual raster/dither/driver code is closed and
lives only in `classes.dex`; everything below about the pipeline is mined from the dex and
resource strings, not from that repo. **[EVIDENCE]**

---

## 1. RawBT's printer model

RawBT has **two overlapping printer models**: a persisted Room/SQLite entity (the full
editable printer record) and a smaller parcelable descriptor exposed over its AIDL/SDK
surface to third-party apps.

### 1a. The persisted printer record (Room table `printers`)

Single most valuable artifact in the whole APK. Full `CREATE TABLE` string, verbatim from
`dex.txt:11915`: **[EVIDENCE]**

```sql
CREATE TABLE IF NOT EXISTS `printers` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` TEXT, `description` TEXT, `current` INTEGER NOT NULL,
  `protocol` INTEGER NOT NULL,
  `mac` TEXT, `host` TEXT, `port` INTEGER NOT NULL,
  `vid` TEXT, `pid` TEXT, `baud` INTEGER NOT NULL, `serialComDriver` TEXT,
  `profileClass` TEXT,
  `dots` INTEGER NOT NULL, `dpi` INTEGER NOT NULL,
  `printLanguageType` INTEGER NOT NULL, `printLanguage` TEXT,
  `codePage` TEXT,
  `graphicsCommand` INTEGER NOT NULL,
  `skipLinesAfterJob` INTEGER NOT NULL,
  `cutCommand` INTEGER NOT NULL,
  `pulseCommand` INTEGER NOT NULL,
  `addFrame` INTEGER NOT NULL,
  `sleepAfter` INTEGER NOT NULL,
  `lan_delayMS` INTEGER NOT NULL,
  `abs` INTEGER NOT NULL,
  `darkness` INTEGER NOT NULL,
  `bytes_init` TEXT, `bytes_finish` TEXT,
  `pageName` TEXT, `useDithering` INTEGER NOT NULL
)
```

Field-by-field, with the English UI label where one exists (`arsc.txt`):

| Column | UI label / evidence | What it is |
|---|---|---|
| `name`, `description` | `Name / Comment`, `Description` | free text |
| `protocol` | `Connection method`; enum `PROTOCOL_BT`, `PROTOCOL_BLE`, `PROTOCOL_USB`, `PROTOCOL_COM`, `PROTOCOL_LAN`, `PROTOCOL_AIDL`, `PROTOCOL_PRN`, `PROTOCOL_IMAGE`, `PROTOCOL_NOTSET` (`dex.txt`) | transport family, stored per printer |
| `mac` / `host` / `port` | `IP or host name`, `127.0.0.1` | BT MAC or LAN endpoint |
| `vid`/`pid`/`baud`/`serialComDriver` | `Baud rate`, `Serial port driver`, `Flow control`, `CDC/ACM protocol`, `CH340, CH341A`, `Prolific`, `COM over USB`, `Printer works as Serial port` | USB-serial identity + line settings |
| `profileClass` | `esc_general`, `esc_gs_v_0`, `cpcl_general`, `epl_general`, `tspl_general`, `zpl_general`, `cat_printer`, `paperang`, `peripage`, `dothan_printer`, `cylobtprinter`, `raw_transfer`, `virtual` (`dex.txt:25164…32127`) | which profile/driver class drives it |
| `dots` | `Dots per line`, `Print area (dots)`, `Other width`, and the help text *"Enter the number of points of the printer's thermal head (the maximum size of the print area). Or multiply the desired width by the formula millimeters by (8 or 12). The 'Calculate' button will help you enter the desired width value."* plus a dedicated `CalcDotsActivity` (`res/layout/activity_calc_dots.xml`, `dex.txt:20517`) | head width in dots |
| `dpi` | `203dpi (1mm - 8dots)`, `304dpi (1mm - 12dots)` (`arsc.txt:813`, `arsc.txt` `304dpi…`) | only two choices offered |
| `printLanguageType` / `printLanguage` | `CP_TYPE`, `CP_LANGUAGE`, `Internationalization`, `Typical initialization for selected language` | codepage family + language |
| `codePage` | `Default encoding`, `default_cp`, `EPSON (ESC;t;#)`, `STAR (ESC;GS;t;#) , # - CP number`, `ESC GS t 128`, `ESC 9 0x01`, `For printers with UTF-8:`, `Don't send ESC R` | how a codepage is selected on this model |
| `graphicsCommand` | `Command for print image`; see §3 | which bit-image opcode to emit |
| `skipLinesAfterJob` | `Count of lines scrolling`, `Use it, if printer do not print end of document.`, array `skipLines` | trailing feed |
| `cutCommand` | `Paper cut`, arrays `cutTypes`/`cutTypesLabel`; values `fullCut1 - GS;V;0`, `fullCut2 - GS;V;41;0`, `fullCut3 - ESC;i`, `fullCut4 - ESC;d;0`, `partialCut1 - GS;V;1`, `partialCut2 - GS;V;42;0`, `partialCut3 - ESC;m`, `partialCut4 - ESC;d;1` (`arsc.txt`), mirrored by dex constants `FULL_CUT_GSV0`, `FULL_CUT_GSV65`, `FULL_CUT_ESC_I`, `FULL_CUT_ESC_D`, `PARTIAL_CUT_GSV1`, `PARTIAL_CUT_GSV66`, `PARTIAL_CUT_ESC_M`, `PARTIAL_CUT_ESC_D`, and the tri-state `CUT_FULL` / `CUT_PART` / `CUT_NOT_SUPPORTED` | **eight** distinct cut opcodes, user-selectable |
| `pulseCommand` | `CommandOpenCashDriver` (`dex.txt`) | cash drawer kick |
| `addFrame` | `Add frame around print area`, `Crop the frame around`, `Preview frame` | debug/alignment frame |
| `sleepAfter` | `Wait seconds before disconnect`, `DRV_FC_SLEEP_AFTER` | drain delay before closing the link |
| `lan_delayMS` | `Delay between packets for prevent buffer overflow (ms)`, `LAN_DELAY_MS`, `get_lan_delay`, `setLan_delayMS` | inter-chunk pause |
| `abs` | `DRV_FC_ABS_MODE`, grouped under `Flow control` | **[INFERENCE]** Automatic Status Back — send-then-wait-for-status handshaking. Note dex also carries `[-]ESC RS a n - Set ABS:` (a STAR command) so the naming is at least overloaded |
| `darkness` | `Darkness print`, `DRV_DARKNESS`, `getDarkness`/`setDarkness` | print density |
| `bytes_init` / `bytes_finish` | `start bytes`, `finish bytes`, `You may add ESC commands`, `Init as in prev versions of the app:`, `after default init print job` | arbitrary user hex prepended/appended per job |
| `pageName` | `Paper Roll`, `Paper Roll Long`, `Paper Roll not cut`, `for photos`, `for photos not cut`, `for square`, `for square not cut`, `for A4`, `for LETTER`, `for LEGAL`, `for JIS_B4`, `for ROC_16K` (`dex.txt:26242…`) | named media/page-size preset |
| `useDithering` | `isUseDithering` / `setUseDithering`, plus the standalone SQL `UPDATE printers SET pageName = ?, useDithering = ? WHERE name = ?` | per-printer dithering on/off |

### 1b. The SDK-facing descriptor (`rawbt/sdk/PrinterInfo`, `rawbt/api/*`)

A second, flatter key set appears as snake_case JSON/parcel keys with matching accessors —
this is what third-party apps see: **[EVIDENCE]**

```
dots_per_line   (dex.txt:25909)   getDots_per_line / setDots_per_line
max_dots        (dex.txt:28641)
margin_left     (dex.txt:28607)
margin_right    (dex.txt:28608)
cut_pos         (dex.txt:25721)   getCut_pos
cut_type        (dex.txt:25722)
encoding        (dex.txt)         getEncoding / setEncoding
driver          (dex.txt)         getDriver, driver_get
density         (dex.txt:25799)   getDensity / setDensity
darkness        (dex.txt:25724)   getDarkness / setDarkness
```

plus the constant forms `DOTS_PER_LINE`, `DOTS_PER_INCH`, `DRIVER`, `PRINTER_DRIVER`,
`PRINTER_CURRENT`, `PRINTER_VIRTUAL`, `PRINTER_GALLERY`, `PRINTER_RAW_TRANSFER`.

Two things here that my app has no equivalent of:

- **`dots_per_line` vs `max_dots` are separate.** `max_dots` is the physical head; `dots_per_line`
  is the currently-used print width. **[INFERENCE]** This is exactly the "paper width vs print
  area" distinction my `docs/printers.md` describes in prose but stores as a single number.
- **`margin_left` / `margin_right` are per-printer, in dots.** My app has no printer-level
  margin at all — margins are a *typographic* style property inside the renderer. RawBT also
  emits real ESC/POS margin commands: `GS L - left margin:` and `GS W - print width:`
  (`dex.txt:13753`, `13754`), and `CommandLeftMargin` / `CommandPrintWidth` in the emulator.

Also worth noting: RawBT ships **model-specific presets**, not just generic families —
`peripage_a3_`, `peripage_a7`, `peripage_a8+`, `peripage_a8p`, `peripage_a9+`, `peripage_a9_`,
`peripage_q7p`, `peripage_q9`, `peripage_q9p`, `peripage_q9s` (`dex.txt:29507–29516`), and a
whole `ProfilePeripageActivity` / `ProfilePaperangActivity` / `ProfileCatActivity` /
`ProfileZplActivity` / `ProfileEscActivity` / `ProfileMediumActivity` / `ProfileMinimalActivity`
set of editors (`dex.txt:20560–20591`). The profile *editor UI differs per driver family.*

---

## 2. Driver / protocol families

Full driver enum, verbatim (`dex.txt:12993–13008`): **[EVIDENCE]**

```
DRIVER_ESC_GENERAL      DRIVER_GSv0            DRIVER_RAW_TRANSFER
DRIVER_ZPL              DRIVER_TSPL            DRIVER_CPCL           DRIVER_EPL
DRIVER_PERIPAGE         DRIVER_PAPERANG        DRIVER_PAPERANG2      DRIVER_CAT_PRINTER
DRIVER_DOTHAN_TECH
DRIVER_AIDL_ATOL10      DRIVER_AIDL_COM_IPOS
DRIVER_AIDL_WOYOU_IPOS  DRIVER_AIDL_WOYOU_JIUIV5
```

Backed by real classes (`dex.txt:20306–20338`): `rawbt/sdk/drivers/EscGeneral`, `GSv0Driver`,
`ZplDriver`, `TsplDriver`, `CpclDriver`, `EplDriver`, `PeripageDriver`, `PaperangP1Driver`,
`PaperangP2Driver`, `CatPrinterDriver`, `DothanTechDriver`, `RealRAW`, `Aidl_Atol10`,
`Aidl_iPOS_Printer`, `Aidl_woyou_iPOS_Printer`, `Aidl_jiuiv5`, all under
`AbstractDriver` / `AbstractDriverWithTransport` / `PrinterDriverFactory`.

What each family means for hardware my app cannot currently drive:

- **ZPL / TSPL / EPL / CPCL** — label-printer command languages. Zebra (ZPL/EPL), TSC and
  most cheap Chinese 4×6 shipping-label printers (TSPL), Zebra/Comtec mobile (CPCL). These
  are *not* ESC/POS supersets; they are page-description languages with their own image
  opcodes (`^GF` for ZPL, `BITMAP` for TSPL). My app sends `GS v 0` and would print nothing
  but garbage on any of them. RawBT's own help says as much: *"The situation with label
  printers is much worse (there are a lot of different, incompatible sets of commands)."*
  **[EVIDENCE]**
- **PERIPAGE / PAPERANG / PAPERANG2 / CAT_PRINTER** — the popular pocket BLE "sticker/mini"
  printers (PeriPage A6/A9, Paperang P1/P2, and the MX05/GB01/GB02 "cat printers"). These use
  proprietary framed packet protocols over BLE GATT, not ESC/POS over RFCOMM. Evidence of a
  full Paperang command set in the dex: `Paperang (0xA5..0x5A)` (framing bytes),
  `PRT_PRINT_DATA`, `PRT_PRINT_DATA_COMPRESS`, `PRT_SET_HEAT_DENSITY`, `PRT_GET_HEAT_DENSITY`,
  `PRT_GET_TEMP`, `PRT_GET_VOLTAGE`, `PRT_GET_BAT_STATUS`, `PRT_SET_CRC_KEY`, `crcPacket`,
  `crckeyset`, `PRT_PAPER_FEED_SPEED`, `PRT_SET_POWER_DOWN_TIME`, `PRT_USB_UPDATE_FIRMWARE`.
  **[EVIDENCE]** My app cannot talk to any of these.
- **AIDL_ATOL10 / AIDL_COM_IPOS / AIDL_WOYOU_IPOS / AIDL_WOYOU_JIUIV5** — Android-only. These
  bind to a vendor service on integrated POS terminals (Sunmi = "woyou", iPOS, ATOL fiscal
  registrars) instead of opening a port. `AIDL - for POS terminals` (`arsc.txt`). **Irrelevant
  to a Linux print server — skip.**
- **DOTHAN_TECH / `cylobtprinter`** — DothanTech / D11-class BLE label printers.
- **GSv0 as a *driver* distinct from ESC_GENERAL** — **[INFERENCE]** a stripped-down mode that
  only ever emits `GS v 0` raster and no text/codepage commands, for printers whose text path
  is broken. That is essentially what my app already does, which is reassuring.
- **RAW_TRANSFER / `RealRAW`** — pass bytes straight through, no driver. Useful escape hatch.

Transports are a separate axis from drivers (`rawbt/sdk/transport/`): `Bt`, `BLE`,
`USB`, `SerialCom`, `P910nd`, `AIDL`, `HidBridge`, `PrintToFile`, `PrintToGallery`,
`PrintToMemory`, behind a `TransportFactory`. **[EVIDENCE]** Notable: `P910nd` = raw
port-9100 (RawBT can *be* a network print server: `Enable service: Settings - Additional
services - LanShare on 9100`), and `HidBridge` for printers that enumerate as USB-HID rather
than usblp. My app has Bluetooth/USB/CUPS; it has no HID path and no 9100 listener.

---

## 3. Image pipeline

### 3a. Screening / dithering

Ten modes, from the dex enum (`dex.txt:12964–12973`) and their English labels (`arsc.txt`):
**[EVIDENCE]**

| Constant | UI label |
|---|---|
| `DITHERING_BW` | `Black & White (free)` |
| `DITHERING_127` | `Threshold 127 (free)` |
| `DITHERING_REGULAR` | `Bayer matrix` (also `bayerMatrix`, `dex.txt:24948`) |
| `DITHERING_SF` | `Dithering SF` (`ditheringSF_real`) |
| `DITHERING_SIERA` | `ditheringSiera16` |
| `DITHERING_ATKINSON` | `Atkinson` (`ditheringAtkinson`) |
| `DITHERING_BURKES` | `ditheringBurkes` |
| `DITHERING_BEST_CONTRAST` | `Best contrast` |
| `DITHERING_SKETCH` | `Sketch filter` |
| `DITHERING_NONE_RESIZE_ONLY` | `Resize only` |

Selected via `graphicFilter` / `getGraphicFilter` / `setGraphicFilter`, presented as
`Graphics filter`, and gated at the *printer* level by `useDithering`. Two internal keys
`format_K_threshold` and `format_K_threshold127` (`dex.txt:26269–26270`) suggest the threshold
value is fixed at 127/128 rather than user-adjustable. **[INFERENCE]**

**My app is ahead here.** `src/processing/image_dither.py` ships eleven modes including
`jarvis`, `stucki`, `sierra-two-row`, `sierra-lite`, `false-floyd-steinberg`, plus a real
user-controlled **cutoff (`t=`, 0–255) and amount (`s=`, 0–1)** per image via the markdown
title slot. RawBT has no equivalent knob. What RawBT has that I do not: `Best contrast`
(**[INFERENCE]** auto-levels/histogram stretch before screening) and `Sketch filter`
(**[INFERENCE]** edge-detect, for line art from photos).

Related image-fitting options: `doScale`, `Squeeze images`, `no scaling`, `fill screen`,
`fits inside screen`, `free_form`, `WidthTruncateModeNames`, `Clipping part of page`,
`cut max empty space`, `cut 1/2 inch fields`, `Cut points (1/72 inch)`, `Flip horizontally`,
`Flip vertically`, `Inverse colors`, `rotate`, `invert`. **[EVIDENCE]**
`cut max empty space` is auto-whitespace-trim; my app does this only for along-the-roll pages.

### 3b. Density / darkness

Two separate mechanisms:

1. `darkness` / `DRV_DARKNESS` / `Darkness print` on the printer record — a real command sent
   to the printer. For ESC/POS the dex carries `[-]ESC RS d n - STAR. Set print density:` and
   `GS(L fn49 - Set the reference standard dot density for graphics.` / `GS8L fn49 - …`.
   **[EVIDENCE]**
2. For Paperang, a full round-trip: `PRT_SET_HEAT_DENSITY` / `PRT_GET_HEAT_DENSITY` /
   `PRT_SENT_HEAT_DENSITY`, plus `PRT_PAPER_FEED_SPEED` and `PRT_ENERGY`. **[EVIDENCE]**

My app's `darkness` render option (`docs/api.md`) is *contrast applied to the bitmap before
screening* — a completely different thing. I have **no** command that tells the head to fire
hotter. That is a real gap: burning darker in software costs ink coverage and blurs edges;
burning darker in firmware does not.

### 3c. Chunking and delays

- `lan_delayMS`, labelled `Delay between packets for prevent buffer overflow (ms)`, with
  `getMaxPacketSize`, `Incomplete frame: maxpacketsize < realpacketsize`, `sendBandle`
  (sic, "band"), and the BLE MTU dance `requestMtu` / `onMtuChanged` / `waitMtu` /
  `mtuWait ended`. **[EVIDENCE]**
- `sleepAfter` = `Wait seconds before disconnect`, explained in help: *"Upon completion of
  sending data, RawBT is disconnected from the printer. At the moment of shutdown, data output
  to paper stops. To solve the problem, you need to configure data flow control. Find the
  optimal ratio of the delay in seconds before disconnecting and waiting in milliseconds
  between sending chunks of data."* **[EVIDENCE]**
- Root cause stated plainly: *"The reason is an overflow of the printer's internal buffer due
  to the fact that data is sent to the printer faster than it can process it."* **[EVIDENCE]**
- `abs` / `DRV_FC_ABS_MODE` — **[INFERENCE]** status-based flow control rather than blind
  timing.
- `Allow data compression` / `DATA_COMPRESS` / `PRT_PRINT_DATA_COMPRESS` — RLE compression on
  the wire for Paperang. **[EVIDENCE]**

My app's equivalents: `_WRITE_CHUNK = 1024` with `_WRITE_PAUSE = 0.01` (`src/core/printer.py:441`),
`BAND_ROWS = 64` (`src/core/protocol.py:184`), and `USB_DRAIN_BYTES_PER_SECOND = 12000` /
`MAX_DRAIN_SECONDS = 8.0` in `src/core/transport.py`. All hard-coded constants. RawBT exposes
every one of these as a per-printer setting — which is the right call when the same code has to
survive hundreds of firmwares.

### 3d. Overheating / anti-blur

RawBT does **not** actively throttle for heat in the ESC/POS path. What it has:

- **Documentation.** FAQ entries `Due to overheating`, `After printing a dark area`, and the
  body text: *"When printing for a long time, when printing an image with large black coverage,
  at high ambient temperatures, or when heated by sunlight, the thermal protection may be
  activated."* and *"The printer prints by heating. The more dark dots in a line, the more power
  is required from the battery. When the battery charge is low and the required heating current
  is high, the voltage may drop below a critical value and the printer electronics will turn
  off for a short time."* **[EVIDENCE]**
- **Status decoding.** `Thermal head high temperature` (`dex.txt:22743`), `Motor high temperature`
  (`dex.txt:21269`), `Paper less` (`dex.txt:21687`) — these sit next to the Paperang
  `PRT_SENT_STATUS` / `PRT_GET_TEMP` / `PRT_GET_VOLTAGE` / `PRT_GET_BAT_STATUS` command set and
  the ESC/POS `CommandSensors` + `rawbt/sdk/drivers/responses/{StatusResponse,BatteryResponse,
  ModelResponse,SerialNumberResponse,ModelVersionResponse,WrongResponse}` classes.
  **[INFERENCE]** So it reads and reports temperature/battery on protocols that offer it, and
  surfaces the condition to the user, but the mitigation offered is "wait for it to cool":
  *"When it cools down, the printer can continue to work."* **[EVIDENCE]**
- **Anti-blur** in the sense of legibility is handled *upstream*, not in the driver:
  `Fuzzy letters`, `If it prints small letters`, `Alphabet letter size`, and the long help text
  *"Increase the size of the letters in the original document so that there are 30–32 letters
  per line for body text. The print driver should not reformat the text."* plus the explanation
  that anti-aliased screen text screened to 1-bit produces angular edges. **[EVIDENCE]**

Honest summary: **RawBT's overheating story is a help article plus a status readout, not a
mitigation.** There is nothing here to copy wholesale — but the *status readout* is worth
copying (see §6).

### 3e. Raster vs bit-image: how it decides

**It does not decide. The user picks, per printer**, via `graphicsCommand` / `escGraphicsCommand`,
labelled `Command for print image`, with the help text: *"Try other commands for printing
graphics. For most printers, the first two items from the list of those implemented in the
application are suitable."* **[EVIDENCE]**

The implementations are concrete classes under `rawbt/sdk/drivers/esc_commands/`
(`dex.txt:20339–20356`) with a `GraphCommand` base and an `EscGraphicsCommandList` registry:
**[EVIDENCE]**

| Class | Menu string in dex | ESC/POS command |
|---|---|---|
| `Gsv0` | `GS v 0 - default` | `GS v 0` raster |
| `GSv0old` | (`photo_wrong_gsv0`, `photo_wrong_gsv0_new` illustration assets) | legacy variant |
| `Gsv0AndEscJ` | — | raster band + `ESC J` feed between bands |
| `GS_L` | `GS ( L - Epson modern` | `GS ( L` graphics |
| `GS8L` | `GS 8 L - Epson modern` | `GS 8 L` large graphics |
| `GsAsterisk` | `GS * - Define downloaded bit image. Obsolete.` + `GS * - Attention! Read the printer manual before.` | `GS *` |
| `EscAsterisk`, `EscAsterisk0`, `EscAsterisk5`, `EscAsterisk39`, `EscAsterisk73`, `EscAsteriskA` | `ESC * 39 - Epson 180x180 dpi`, `ESC * 73 - 48 dots printers`, `ESC * a - raster format` | `ESC *` column mode, all densities |
| `EscXforStar`, `EscX4forStar`, `EsckForStar` | `ESC X - STAR (24 dot) fine density bit image`, `ESC k - STAR (24 dot) fine density bit image`, `ESC X 4 - STAR Define user-defined bit image` | STAR |
| `EscGsS` | `ESC GS S - starPRNT` | STAR raster |

Also present: `decodeRasterFormat` and `decodeColumnFormat` (`dex.txt`), `eachLinePixForStar`,
`eachLinePixToCmd`, `encodeLine` — the packing routines for both orientations.

**[INFERENCE]** The `Gsv0AndEscJ` variant is the interesting one: it is banded `GS v 0` with an
explicit `ESC J` dot-feed between bands, which is what you need on firmwares that do not
auto-advance after a raster block. My app bands but never interleaves a feed.

---

## 4. What RawBT has that I do not, ranked for a single-user 58 mm setup

Ranked by *how much it would actually improve my app*. Android-only and paid-tier-only items
are excluded (no AIDL/POS terminal drivers, no Play billing, no Android print-service
plumbing, no "free version watermark").

1. **Per-printer flow-control settings instead of hard-coded constants.**
   `lan_delayMS` (inter-chunk ms), `sleepAfter` (drain seconds), and band size. My
   `_WRITE_CHUNK=1024 / _WRITE_PAUSE=0.01 / BAND_ROWS=64` were tuned against one MPT-II. The
   moment a second printer appears they are wrong, and the failure mode is the one RawBT
   documents: dropped bytes, tail of the receipt as vertical streaks.

2. **Selectable graphics command per profile.** Eleven opcodes vs my single hard-coded
   `GS v 0` (`protocol.py:CMD_RASTER_BITMAP`). Adding at least `ESC *` column mode and
   `GS v 0 + ESC J` covers most of the printers that "don't print images".

3. **A real hardware darkness/density command.** `darkness` on the printer record, sent to the
   printer, distinct from my software contrast. Cheap to add, immediately visible on paper.

4. **`bytes_init` / `bytes_finish` — user-editable hex around every job.** RawBT lets any user
   paste ESC bytes without a code change (`start bytes`, `finish bytes`, `You may add ESC
   commands`). I already have `commands.start_print` / `end_print` in the profile JSON, but they
   are only editable by hand-writing JSON — not exposed in the web UI's "Describe one" form.

5. **`max_dots` vs `dots_per_line` + `margin_left` / `margin_right` in dots.** Lets a 58 mm
   printer be driven at 320 dots centred, or a label offset to match a die-cut. My renderer's
   margins are typographic, so they move with the theme; a *device* margin should not.

6. **Eight cut opcodes and a cut position.** I emit only `GS V 0` / `GS V 1`
   (`protocol.py:CMD_CUT_FULL/PARTIAL`). Printers that want `ESC i`, `ESC m` or `ESC d n` get
   nothing. `cut_pos` also lets the cut land somewhere other than "3 line feeds later", and
   `Cut on the first page from the top` / `Cut paper between pages` are separate switches.

7. **Printer status decode as user-facing text.** `Thermal head high temperature`,
   `Motor high temperature`, `Paper less`, plus battery/voltage where the protocol has it.
   I have `get_status()` returning raw bytes and no decoder at all.

8. **Label/pocket-printer driver families (TSPL, ZPL, EPL, CPCL; PeriPage, Paperang, Cat).**
   Genuinely large scope, but it is the difference between "works with my one printer" and
   "works with the printer someone buys next". **[INFERENCE]** TSPL is the highest
   value-per-effort of these — it is text-based, well documented, and covers the whole cheap
   4×6 label market.

9. **Codepage / native-text printing.** RawBT bundles `iconv-lite.bundle.js` (376 KB) and ships
   codepage chart images for cp437/737/775/850/852/858/860/863/865/866/1251/1252/1253/1257 with
   four variants each (`res/drawable-nodpi-v4/cp*_{ab,ar,bb,br}.png`), plus `cp_to_page`,
   `cp_to_star`, `cp_to_page_pt210`, `CommandSelectCodepage`, and UTF-8 variants
   (`CommandUTFepson`, `CommandUTFstar`, `CommandUTFcitizen`, `CommandUTFpt210`). My app is
   **image-only** — every character is rasterised. That is a deliberate and mostly good choice
   (it is why RTL and 900 symbols work), but it means a plain receipt costs ~48× the bytes of
   the same receipt in native text, and prints correspondingly slower.

10. **`cut max empty space` — auto-trim whitespace on any job**, not just along-the-roll.

11. **A byte-level ESC/POS emulator + preview + `.prn` viewer.** `rawbt/sdk/emulator/escpos/
    EscPosEmulator` with ~60 `Command*` classes, `ParserPrn`, `PreviewTask`, `Debugger`,
    `ru/a402d/prnviewer/ViewActivity`, and the human-readable disassembly strings
    (`[!] ESC GS - Unknown`, `[-] GS ( J - undocumented, what do they do?`). This renders a
    *byte stream* back to a picture. My preview renders the *source document* to a picture —
    which is not the same guarantee. An emulator would catch a malformed command; my preview
    cannot.

12. **`Print Self-test page`, `Check logo preview`, `Long test`, `Short test`, `Terminal`
    (interactive hex/ASCII console with history), `Debug console`, `Share log`.** RawBT has a
    whole diagnostic surface. I have a tear-test strip and nothing else.

13. **Widths help: `CalcDotsActivity` / "From mm" calculator.** I already have a "From mm"
    button (`docs/printers.md`), so this is parity, not a gap.

Explicitly **not** worth copying: AIDL POS drivers, the Android print-service integration,
Play billing, `AutoPrint Folder` (inotify `Event CLOSE_WRITE` / `Event MOVE_TO` on a watched
directory — arguably nice, but the web API already covers it), the in-app browser.

---

## 5. Where my app is already better — do not regress these

1. **Dithering breadth and control.** Eleven kernels in `src/processing/image_dither.py`
   (`floyd-steinberg`, `false-floyd-steinberg`, `jarvis`, `stucki`, `burkes`, `sierra`,
   `sierra-two-row`, `sierra-lite`, `atkinson`, `ordered`, `none`) with a **per-image cutoff
   and amount** (`![alt](img "atkinson t=200 s=0.6")`). RawBT has ten *named presets* and, as
   far as the strings show, a fixed 127 threshold. My control surface is strictly finer.

2. **Banding is unconditional and reasoned.** `BAND_ROWS = 64` in `protocol.py` with the
   comment explaining exactly why, and `build_raster_bands` used by both `print_job.py:180` and
   `web/server.py:453`. RawBT's `Gsv0` is only *one option among eleven* and the user has to
   discover which. Mine is right by default. Make any new opcode selection *additive*, keep
   banded `GS v 0` as the default.

3. **escpos-printer-db schema for capability profiles.** `src/config/data/printer_profiles.json`
   follows the upstream schema, so profiles are portable to python-escpos and escpos-php.
   RawBT's model is entirely bespoke and exportable nowhere. Do not drift the schema when
   adding `margin_left` / `graphics_command` / `darkness` — put local extensions in a clearly
   marked block the way `commands` already is.

4. **Graceful capability degradation.** `PrinterProtocol.build_qr_command` returns `b""` when
   the profile lacks `qrCode`, and the content is rasterised instead. RawBT's failure mode for
   a wrong option is a page of garbage plus a FAQ article.

5. **User profile overlay that survives updates.**
   `~/.local/share/thermal-printer/printer-profiles.json` merged over the shipped table
   (`printer_profile.py:load_profiles`), so a bundled entry can be corrected without editing
   source and nothing is lost on update.

6. **Right-to-left shaping, mixed scripts, 900-symbol picker, real tables with column widths
   and borders, calendars, labels on printed backgrounds, presets with `{{date}}`, to-dos,
   themes that style paper as well as screen.** RawBT has `DocumentTemplate` /
   `TEMPLATE_TOP_TEXT` / `TEMPLATE_BOTTOM_TEXT` / `TEMPLATE_PAPER_CUT` / `TEMPLATE_SIMPLE` and
   a logo — that is the entire authoring story. Mine is a different and much larger product.

7. **Calibrated tear-off gap, stored per profile, with a wizard.** `get_tear_gap_mm` /
   `set_tear_gap_mm` keyed by profile name, plus `save_immediate()` so a short-lived process
   cannot lose the calibration. RawBT has `skipLinesAfterJob` — a blind line count, not a
   measured millimetre distance.

8. **Blocking `O_RDWR` USB writes + `fsync` + a computed drain sleep**
   (`transport.py:UsbTransport.close`, `USB_DRAIN_BYTES_PER_SECOND = 12000`). RawBT makes the
   user tune `sleepAfter` by hand; mine computes it from bytes actually written.

9. **Preview is the print bitmap, at head width, with the print area outlined inside the paper
   width**, plus the `X-Trimmed: 1` header when an along-the-roll page overflowed. RawBT's
   preview is a rendering of a job, not a promise about the bytes.

10. **Writes serialised behind a lock across all tabs and panes.** RawBT is single-app,
    single-activity, so it never had to solve this.

---

## 6. Prioritised enhancements

Effort estimates assume the existing structure. **HW** marks anything that needs a real
printer to verify — a wrong opcode on a thermal printer produces garbage, not an exception.

### P1 — high value, low risk

**1. Per-profile flow-control block. (small)**
*What:* add `flow: { chunk_bytes, chunk_pause_ms, band_rows, drain_seconds }` to the profile
schema, defaulting to today's `1024 / 10 / 64 / computed`.
*Why:* these are the three constants that decide whether a second printer works at all, and
they are the exact three RawBT exposes (`lan_delayMS`, `sleepAfter`, band size). Today they are
invisible and un-fixable without editing source.
*Where:* `src/config/data/printer_profiles.json` (new `flow` block, marked as a local extension
alongside `commands`); accessors in `src/config/printer_profile.py` beside `get_command`;
consumed in `src/core/printer.py` (`_WRITE_CHUNK` / `_WRITE_PAUSE` → instance attrs read at
connect), `src/core/protocol.py:build_raster_bands` (`band_rows` already a parameter — just
pass it), `src/core/transport.py:UsbTransport.close`.
*HW:* only to tune; the defaults are already known-good.

**2. Hardware darkness/density command. (small)**
*What:* `GS ( L fn49` and/or the common `ESC 7 n1 n2 n3` / `DC2 # n` heat settings, gated on a
new `features.setDensity` flag, with a 0–8 level in the profile or in Settings.
*Why:* RawBT's `darkness` / `DRV_DARKNESS` is a real command; my `darkness` render option is
contrast on the bitmap. Burning hotter in firmware gives darker output *without* costing edge
sharpness or coverage, which is the single biggest quality lever on cheap 58 mm heads.
*Where:* new `PrinterProtocol.build_density_command()` in `src/core/protocol.py`; emitted from
`PrinterConnection.start_print()` in `src/core/printer.py`; flag in
`src/config/data/printer_profiles.json`; UI in the "Describe one" form in `web/static/app.js`
and the profile endpoints in `web/server.py` (`POST /api/printer-types`).
*HW:* **yes** — density opcodes vary by firmware and a wrong one prints stray characters.
Guard behind the feature flag, default off.

**3. Decode printer status into words. (small)**
*What:* parse the `GS r n` / `DLE EOT n` / ASB response bits into `paper out`, `cover open`,
`cutter error`, `head over-temperature`, `voltage error`, and show them in the UI.
*Why:* I already request status and throw the bytes away. RawBT turns them into
`Thermal head high temperature`, `Motor high temperature`, `Paper less` — which is the whole
difference between "it stopped" and "let it cool down". Zero risk: reading is passive.
*Where:* `PrinterProtocol` — new `decode_status(raw: bytes) -> dict` beside
`STATUS_RESPONSE_LENGTH` in `src/core/protocol.py`; called from
`PrinterConnection.get_status()` in `src/core/printer.py`; surfaced through `GET /api/state`
in `web/server.py` and the status pill in `web/static/app.js`.
*HW:* **yes** for confirming which status variant the MPT-II answers; harmless if it answers
nothing (`recv` already returns `b''` on timeout).

**4. Expose `start_print` / `end_print` / arbitrary init+finish hex in the web UI. (small)**
*What:* two hex fields in "Describe one", validated, written into the profile's `commands`
block.
*Why:* `bytes_init` / `bytes_finish` is how RawBT supports printers nobody has profiled. I have
the mechanism (`get_command`, `bytes.fromhex`) and only lack the form field — so this is
mostly free.
*Where:* `web/static/app.js` (the printer-type form), `web/server.py`
(`POST /api/printer-types` validation), `src/config/printer_profile.py:save_user_profile`.

**5. Full cut-command table + cut position. (small)**
*What:* `cut_type` in the profile choosing among `GS V 0`, `GS V 65 n`, `ESC i`, `ESC d 0`
(full) and `GS V 1`, `GS V 66 n`, `ESC m`, `ESC d 1` (partial), plus a `cut_feed_dots`
replacing the hard-coded three line feeds.
*Why:* RawBT ships all eight because all eight exist in the wild. My
`build_cut_command` covers two.
*Where:* `PrinterProtocol.build_cut_command` in `src/core/protocol.py`; `features` /
`commands` in `printer_profiles.json`; the form in `web/static/app.js`.
*HW:* **yes**, but only on a printer that actually has a cutter.

### P2 — medium value, medium effort

**6. Device margins and a print width narrower than the head. (medium)**
*What:* `media.print_area.{max_dots, dots_per_line, margin_left, margin_right}` in the profile;
the renderer composes at `dots_per_line` and the raster builder pads to `max_dots` with the
left margin.
*Why:* RawBT's `dots_per_line` / `max_dots` / `margin_left` / `margin_right` split. Fixes
"my print is offset 8 dots" and lets narrow media be centred, neither of which a typographic
margin can do because it moves with the theme.
*Where:* `src/config/printer_profile.py` (`get_printer_width` grows a sibling
`get_print_area()`); `src/core/protocol.py:build_raster_command` (pad rather than assume
image width == head width — note it currently does `image.size[0] // 8` with no check);
`src/processing/markdown_renderer.py` (canvas width comes from the print area, not the head).
*Risk:* touches the one invariant the whole raster path relies on. Add a hard assertion that
padded width is a whole number of bytes.

**7. Selectable graphics command, starting with `ESC *` and `GS v 0 + ESC J`. (medium)**
*What:* a `graphics_command` key in the profile with at minimum `gsv0` (default),
`gsv0_escj`, `esc_asterisk_33` (24-dot double-density), `esc_asterisk_1` (8-dot).
*Why:* RawBT ships eleven because `GS v 0` is not universal, particularly on older and
STAR-derived firmwares. `ESC *` column mode is the classic fallback for "images print as
garbage".
*Where:* new `src/core/graphics_commands.py` with one builder per opcode, each yielding bands
the way `build_raster_bands` does; `PrinterProtocol.build_raster_bands` dispatches on the
profile; `print_job.py:180` and `web/server.py:453` are the two call sites and should not need
to change if the generator signature holds.
*HW:* **yes**, and this is the item most likely to produce a page of noise while getting it
right. Keep `gsv0` the default and treat the rest as opt-in.

**8. Auto-trim empty space on every job. (small–medium)**
*What:* RawBT's `cut max empty space` — trim uniform white rows from the top and bottom of the
final bitmap before banding, with an option to keep N mm.
*Why:* saves paper on every single job; I currently only do this for along-the-roll.
*Where:* `src/core/print_job.py` just before `build_raster_bands`, so the preview and the print
agree; a `trim_blank` render option in `docs/api.md` and `web/static/app.js`.

**9. `Best contrast` and `Sketch` pre-filters. (small)**
*What:* an auto-levels/CLAHE pass and an edge-detect pass, offered alongside the dither modes.
*Why:* the two RawBT filters that have no counterpart in my eleven kernels. Both are
pure-Pillow/numpy, no hardware involvement, and both markedly improve photographs on a 1-bit
head.
*Where:* `src/processing/image_dither.py` (as pre-passes, not new kernels — they compose with
the existing cutoff/amount), exposed via `GET /api/dither` and the picker in `web/static/app.js`.

**10. A `.prn` / byte-stream previewer. (medium)**
*What:* feed a captured byte stream back through a minimal ESC/POS interpreter and render it.
*Why:* RawBT's `EscPosEmulator` + `ParserPrn` + `PRN Viewer` is its best debugging tool. My
preview proves the *document* is right; this would prove the *bytes* are right, which is what
actually goes wrong when a new opcode or profile is added. It also makes items 2, 5 and 7
testable without paper.
*Where:* new `src/processing/escpos_emulator.py`; a `POST /api/emulate` endpoint in
`web/server.py`; a debug pane in `web/static/app.js`. Start with only the commands I emit
(`ESC @`, `GS v 0`, `ESC J`, `GS V`, `GS ( k`, `GS k`, `LF`) — that is a day, not a month.

### P3 — large, only if the scope is wanted

**11. TSPL driver family. (large)**
*What:* a second command language behind a `driver` key on the profile, exactly as RawBT's
`PrinterDriverFactory` does — the renderer keeps producing a 1-bit bitmap, only the wrapper
changes (`SIZE`/`GAP`/`BITMAP`/`PRINT` instead of `GS v 0`).
*Why:* covers the entire cheap 4×6 shipping-label market, which is the most likely second
printer anyone attaches. Text-based and well documented, so the least risky of the four label
languages.
*Where:* `src/core/drivers/` (new package) with `EscPosDriver` (today's `protocol.py`, moved)
and `TsplDriver`; `printer_profile.py` gains `get_driver()`; `print_job.py` and
`web/server.py:453` dispatch through the driver rather than importing `PrinterProtocol`
directly. This refactor is the real cost, not TSPL itself.
*HW:* **yes**, and it needs a label printer, which I do not have.

**12. Native text / codepage path. (large)**
*What:* when a document is plain ASCII/Latin-1 and no styling is used, send `ESC t n` + bytes
instead of a raster.
*Why:* RawBT's whole text path. ~48× fewer bytes, correspondingly faster, and battery printers
last longer. **But** it forfeits fonts, RTL, symbols, tables and themes — everything my app is
actually for. **[INFERENCE]** Only worth it as a narrow fast path for the to-do list and
plain-text presets, if at all. I would rank this last and would not be sorry to skip it.

**13. Raw port-9100 listener. (medium)**
*What:* RawBT's `P910nd` transport / `LanShare on 9100`, i.e. accept raw ESC/POS on TCP 9100 and
forward it to the connected printer.
*Why:* lets any existing app on the LAN print through the studio. Genuinely useful, but the
HTTP API already covers every case I personally have, so it is a want rather than a need.
*Where:* a new listener thread in `web/server.py` reusing the existing print lock, so a network
job cannot interleave with a browser job.

---

## Appendix: strings worth keeping for later

- Cut opcodes: `fullCut1 - GS;V;0`, `fullCut2 - GS;V;41;0`, `fullCut3 - ESC;i`,
  `fullCut4 - ESC;d;0`, `partialCut1 - GS;V;1`, `partialCut2 - GS;V;42;0`,
  `partialCut3 - ESC;m`, `partialCut4 - ESC;d;1`
- Graphics opcodes: `GS v 0 - default`, `GS ( L - Epson modern`, `GS 8 L - Epson modern`,
  `GS * - Define downloaded bit image. Obsolete.`, `ESC * 39 - Epson 180x180 dpi`,
  `ESC * 73 - 48 dots printers`, `ESC * a - raster format`,
  `ESC X - STAR (24 dot) fine density bit image`, `ESC k - STAR (24 dot) fine density bit image`,
  `ESC GS S - starPRNT`
- Margin/width opcodes: `GS L - left margin:`, `GS W - print width:`
- Density opcodes: `GS(L fn49 - Set the reference standard dot density for graphics.`,
  `GS8L fn49 - …`, `[-]ESC RS d n - STAR. Set print density:`
- Codepage opcodes: `EPSON (ESC;t;#)`, `STAR (ESC;GS;t;#) , # - CP number`, `ESC GS t 128`,
  `ESC 9 0x01`, `Don't send ESC R`
- Status text: `Thermal head high temperature`, `Motor high temperature`, `Paper less`
- DPI choices offered: `203dpi (1mm - 8dots)`, `304dpi (1mm - 12dots)`
- Paperang command set: `PRT_SET_HEAT_DENSITY`, `PRT_GET_TEMP`, `PRT_GET_VOLTAGE`,
  `PRT_PAPER_FEED_SPEED`, `PRT_PRINT_DATA_COMPRESS`, framing `Paperang (0xA5..0x5A)`
