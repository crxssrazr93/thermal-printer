# The HTTP API

The browser front end is a client of this API and has no private channel to the
server. Anything that can send JSON can do everything the app does: compose a
page, see the exact bitmap, print it, manage printers, keep presets.

- **Base URL** `http://127.0.0.1:8760`, unless `THERMAL_WEB_HOST` and
  `THERMAL_WEB_PORT` say otherwise.
- **Bodies** are JSON. Send `Content-Type: application/json`. A body that is
  absent or unparseable is read as `{}` rather than refused, so a missing field
  falls back to its default instead of failing.
- **Responses** are JSON, except the four endpoints that return a rendered
  page, which return `image/png`.
- **Errors** are `{"ok": false, "message": "..."}` or `{"error": "..."}`
  depending on the endpoint, with `400` for a bad request, `404` for something
  that is not there, and `500` with the exception text if a handler raises.
- **No caching.** Every response carries `Cache-Control: no-store`.

## Authentication

There is none. The server binds to `127.0.0.1`, so by default only this machine
can reach it. Whoever can reach it can print, spend paper, read presets and add
devices. Opening it to a network is a deliberate act, made in Settings or
through [`/api/network`](#post-apinetwork) below.

## One printer, one queue

Every write to the printer goes through a single lock, so overlapping print
requests are serialised rather than interleaved. A request that arrives while
another job is on the wire waits for it. There is no job id and no queue to
inspect: the response arrives when the paper has been sent.

---

# Printing and previewing

## `POST /api/preview`

Render markdown to the exact bitmap the print head would receive, with the
polarity put back so it reads as black ink on white paper.

```json
{ "text": "# Saturday\n\nMarket, then the workshop.", "options": {} }
```

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `text` | string | `""` | The document, in markdown |
| `options` | object | `{}` | See [render options](#render-options) |

**Returns** `image/png`, one channel, at the head's width.

The response also carries **`X-Trimmed: 1`** when the page was composed along
the roll and came out deeper than the head is wide, so some of it was cut off.
The picture cannot say that about itself, so the header does.

## `POST /api/print`

The same rendering, sent to the printer. Same body as `/api/preview`.

```json
{ "ok": true, "message": "Printed 421 rows" }
```

`400` with `"Not connected to a printer"` if no connection is open, or with the
transport's own error if the write failed.

After the page, the printer feeds the calibrated tear-off gap for the active
device, so the paper stops where it can be torn.

## Render options

Everything under `options`, used by `/api/preview` and `/api/print`.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `font` | string | `DejaVuSansMono` | A family from `GET /api/fonts`; an unknown one falls back silently |
| `size` | number | `24` | Type size in points |
| `line_spacing` | number | `1.1` | Multiple of the line height |
| `darkness` | number | `1.0` | Contrast applied before screening; above 1 burns darker |
| `orientation` | `portrait` \| `landscape` | `portrait` | Across the roll, or along it |
| `page_length` | number | `1200` | Along the roll only: how long the strip is, in dots. Not how much paper the job uses, since the blank end is trimmed |
| `trim_blank` | boolean | `true` | Cut the blank end off the page, so the job feeds only the paper it needs. Send `false` to keep the trailing space, for pre-printed stock where the position matters |
| `style` | object | the theme's | Typographic detail: margins, rules, bullets, table treatment. Send what `GET /api/themes` gives you under `print.style`, or your own |

Two things markdown cannot express ride in the document rather than in the
options, so they survive being saved:

- **Table borders and column widths**, in a directive comment above the table:
  `<!-- table borders=all widths=30,70 -->`. `borders` is `all`, `theme` or
  `none`; `widths` are percentages, one per column.
- **How a picture is screened**, in markdown's title slot:
  `![alt](/images/ab12.png "atkinson t=200 s=0.6")`, where the first word is a
  mode from `GET /api/dither`, `t` is the cutoff (0 to 255), `s` the amount
  (0 to 1) and `f` the preparation applied before screening, one of the
  `prefilters` from the same endpoint. `f=contrast` stretches a flat photograph
  onto the full range, `f=sketch` divides the picture by a blurred copy of
  itself, which keeps writing and drops uneven lighting, and `f=sharpen` pulls
  edges out before they are reduced to dots.

## `POST /api/calendar`

A month, or a week with room to write beside each day, drawn at the paper's
width rather than set from markdown.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `range` | `month` \| `week` | `month` | Which one |
| `year`, `month` | number | today's | Month range only |
| `date` | `YYYY-MM-DD` | today | Week range only: any day in the week |
| `size` | number | `14` | Type size |
| `print` | boolean | `false` | Print it instead of returning it |

**Returns** `image/png`, or `{"ok": ..., "message": ...}` when `print` is set.

## `POST /api/label`

Text composed onto a label background.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `template` | string | — | A `file` from `GET /api/templates`. Required |
| `areas` | array | `[]` | The text blocks, below |
| `darkness` | number | `1.5` | Contrast applied to the composed label |
| `print` | boolean | `false` | Print it instead of returning it |

Each area:

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `x`, `y` | number | `0` | Top left of the text, in the background's own pixels |
| `text` | string | `""` | What it says; `\n` starts a new line |
| `font_family` | string | `DejaVuSansMono` | Family name |
| `font_size` | number | `24` | Type size |
| `bold`, `italic` | boolean | `false` | Weight and slant |
| `alignment` | `left` \| `center` \| `right` | `left` | Within the block |

**Returns** `image/png` at the paper's width, or a print result. `400` if the
template is unknown or nothing was drawn.

## `POST /api/tear-test`

Print a short strip whose last line is where the tear should land, then feed
the gap being tried. Calibration is a physical question, so it is answered on
paper.

```json
{ "mm": 12 }
```

`mm` is clamped to the maximum the app allows. **Returns**
`{"ok": true, "message": "...", "mm": 12}`.

---

# The printer

## `GET /api/state`

Everything the front end needs to describe the current setup.

```json
{
  "connected": false,
  "activeProfile": "MPT-II Bluetooth",
  "profiles": [
    { "name": "MPT-II Bluetooth", "transport": "Bluetooth",
      "address": "04:7F:0E:11:17:B5", "capabilityProfile": "generic-58mm",
      "tearGapMm": 8 }
  ],
  "capabilityProfiles": { "generic-58mm": "Generic 58mm ESC/POS" },
  "width": 384,
  "dpi": 203,
  "tearGapMm": 8,
  "lastError": null
}
```

`width` is the head in dots, always a multiple of eight, since the raster
protocol packs eight dots to a byte.

## `POST /api/emulate`

Reads a byte stream back as paper: the picture it would print, and a listing of
every command in it.

| Field | Type | Meaning |
|-------|------|---------|
| `text` | string | Compose a page and read back what printing it would send |
| `options` | object | Render options for that page, as `/api/print` takes them |
| `feedDots` | number | Tear-off feed to include; omitted, the calibrated gap is used |
| `hex` | string | A capture to read instead. Spaces, commas and `0x` are ignored |
| `base64` | string | The same, base64 encoded. Up to 32 MB decoded |

```json
{ "ok": true, "bytes": 5589, "width": 384, "height": 196, "cuts": 0,
  "events": [
    { "at": 0, "command": "initialise", "detail": "", "bytes": 2 },
    { "at": 2, "command": "raster image", "detail": "384 x 64 dots", "bytes": 3080 }
  ],
  "truncated": false,
  "png": "data:image/png;base64,..." }
```

A page that comes out wrong was either composed wrong or sent wrong, and those
have different fixes. Reading the stream back separates them. A `.prn` capture
from another app can be read the same way, which is how to find out what that
app does differently. Commands the reader does not know are listed as
`unknown` with their bytes rather than skipped, since an unknown command is
usually the answer. The listing stops at four hundred entries and says so.

## `GET /api/status`

Asks the printer how it is, rather than reporting what the server knows.

```json
{ "connected": true, "answered": true, "ok": false,
  "flags": ["paper_out"], "messages": ["The paper has run out"] }
```

This one talks to the hardware and waits, and it takes the print lock, so it
is not something to poll: call it when a job fails, or when a person asks. Many
of these printers never answer, particularly over a one-way Bluetooth link, and
that is `answered: false` with `ok: null`, which is not the same as a fault.
`flags` are stable identifiers (`cover_open`, `paper_feed`, `paper_out`,
`paper_low`, `error`, `cutter_error`, `fatal_error`, `over_temperature`,
`voltage_error`); `messages` are the same thing in words.

## `GET /api/devices?transport=Bluetooth`

What the machine can see right now. `transport` is `Bluetooth`, `USB` or
`CUPS`; anything else is read as Bluetooth. Bluetooth lists paired devices,
USB globs the character devices, CUPS asks for the queues.

```json
{ "devices": [ { "label": "MPT-II (04:7F:0E:11:17:B5)", "value": "04:7F:0E:11:17:B5" } ] }
```

Scanning talks to the system, so this one can take a few seconds.

## `POST /api/connect`

```json
{ "profile": "MPT-II Bluetooth" }
```

Opens the connection to a saved device profile, closing any open one first.
**Returns** `{"ok": ..., "message": ..., "state": {...}}`, with `400` if the
profile is unknown or the port will not open.

## `POST /api/disconnect`

No body. **Returns** `{"ok": true, "state": {...}}`.

## `POST /api/profiles`

Create or update a device profile: how to reach one physical printer.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `name` | string | — | What it is called. Required, and made unique if taken |
| `transport` | `Bluetooth` \| `USB` \| `CUPS` | `Bluetooth` | How to reach it |
| `address` | string | `""` | MAC, device node or queue name |
| `capabilityProfile` | string | `""` | A `key` from `GET /api/printer-types` |
| `tearGapMm` | number | `0` | Calibrated tear-off gap |
| `originalName` | string | — | The entry being edited. Set it to change a saved device in place, including its name, rather than creating another beside it |

**Returns** `{"ok": true, "name": "...", "state": {...}}`. `400` if the name is
empty or the transport is not one of the three.

Omitting `tearGapMm` on an edit keeps whatever was calibrated: the gap was
measured against that printer's body and has no business being reset by a
change of name.

Profiles are kept in `config.yaml` beside the code, which holds your printer's
address and is deliberately not committed.

## `DELETE /api/profiles/<name>`

URL-encode the name. If the deleted profile was active, the first remaining one
takes over. **Returns** `{"ok": true, "state": {...}}`.

## `GET /api/network`

Where the server is listening, and whether that is a choice the app can make.

```json
{ "exposed": false, "host": "127.0.0.1", "port": 8760,
  "override": "", "addresses": ["192.168.2.115"] }
```

`addresses` is what this machine would be reached at, asked of the routing
table rather than of DNS. `override` is `THERMAL_WEB_HOST` when it is set,
which means the decision was made outside the app and cannot be changed here.
`rawPort` says whether raw printing is wanted, `rawPortOpen` whether the port
is actually listening, and `rawPortNumber` which port that is (9100, or
`THERMAL_RAW_PORT`).

## `POST /api/raw-port`

`{"enabled": true}` opens the raw printing port, `false` closes it.

```json
{ "ok": true, "enabled": true, "open": true, "port": 9100, "host": "127.0.0.1" }
```

Port 9100 is what every print system means by a network printer: send it
ESC/POS and it prints. With this on, CUPS on another machine, a till, or
anything that speaks the protocol can print through this app to a printer that
has no network of its own. Bytes are passed through untouched, under the same
lock the app's own jobs take, so the two cannot interleave on one socket. A job
is everything sent until the sender closes or goes quiet for five seconds, up
to 16 MB.

It follows `POST /api/network`: local only until the app itself is exposed.
There is no authentication on it, so anything that reaches it prints.
`{"ok": false}` with a message means the port was already taken.

## `POST /api/network`

```json
{ "exposed": true }
```

Open the server to the network, or close it again. The listening socket is
replaced rather than the process restarted, so an open printer connection and
anything in flight survive it; the response goes out on the old socket before
the new one comes up, and a client is typically reconnected within a
millisecond or two.

**Returns** `{"ok": true, "exposed": true, "host": "0.0.0.0", "port": 8760,
"addresses": [...], "message": "..."}`. `400` if `THERMAL_WEB_HOST` is set.

If the open socket cannot be bound, the server falls back to local only and
records that, rather than leaving nothing listening.

**There is still no password.** Exposed means anyone who can route to this
machine can print.

## `POST /api/tear-gap`

```json
{ "mm": 12 }
```

Saves the gap against the **active capability profile**, since the distance
from head to tear bar belongs to the printer's body. **Returns**
`{"ok": true, "state": {...}}`.

---

# Printer types

A capability profile says what a model can do. The schema is
[escpos-printer-db](https://github.com/receipt-print-hq/escpos-printer-db)'s, so
an entry means the same thing to python-escpos or escpos-php.

## `GET /api/printer-types`

```json
{ "types": [
  { "key": "generic-58mm", "name": "Generic 58mm ESC/POS", "vendor": "Generic",
    "dpi": 203, "widthDots": 384, "widthMm": 57.5,
    "features": { "bitImageRaster": true, "qrCode": true, "barcodeA": true,
                  "paperFullCut": false, "paperPartCut": false },
    "notes": "", "custom": false,
    "driver": "escpos",
    "graphics": "gsv0",
    "flow": { "chunk_bytes": 1024, "chunk_pause_ms": 10,
              "band_rows": 64, "drain_seconds": 0.0 },
    "cut": { "full": "gsv0", "partial": "gsv1", "feed_dots": 0 },
    "density": { "supported": false, "level": 0 },
    "commands": { "start_print": "", "end_print": "", "status_request": "" } }
],
  "driverOptions": [{ "id": "escpos", "label": "ESC/POS, receipt printers" }],
  "graphicsOptions": [{ "id": "gsv0", "label": "GS v 0, the raster command ..." }],
  "cutOptions": [{ "id": "gsv0", "label": "GS V 0, full cut, the common one" }],
  "flowDefaults": { "chunk_bytes": 1024, "chunk_pause_ms": 10,
                    "band_rows": 64, "drain_seconds": 0.0 } }
```

Shipped types first, then yours; `custom` says which is which, and only a
custom one can be deleted.

`features` is what the printer can do, in the escpos-printer-db schema.
Everything after it is how to talk to it, which that schema does not cover, so
those blocks are this project's own and are ignored by anything that reads the
schema alone. `graphicsOptions` and `cutOptions` are the values `graphics` and
`cut` accept, already labelled for a dropdown.

## `POST /api/printer-types`

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `name` | string | — | Display name. Required |
| `vendor` | string | `Custom` | Who makes it |
| `widthDots` | number | `384` | Head width, clamped to 64–2048 and rounded **down to a multiple of eight** |
| `dpi` | number | `203` | Clamped to 50–600 |
| `widthMm` | number | derived | Paper width; computed from dots and dpi if omitted |
| `features` | object | all false | `bitImageRaster`, `qrCode`, `barcodeA`, `paperFullCut`, `paperPartCut`; anything else is ignored |
| `key` | string | derived | Send it to edit an existing custom type in place; omitted, a key is made from the name |
| `driver` | `escpos` \| `tspl` | `escpos` | Which language the printer speaks. Receipt printers speak ESC/POS; the label printers sold beside them usually speak TSPL, and one sent ESC/POS prints a label of characters |
| `graphics` | string | `gsv0` | Which opcode carries a bitmap, from `graphicsOptions`. Column mode (`esc_star_*`) for firmwares that print `GS v 0` as characters |
| `flow` | object | see below | `chunk_bytes` (64–65536), `chunk_pause_ms` (0–500), `band_rows` (8–1024), `drain_seconds` (0–30) |
| `cut` | object | `gsv0` / `gsv1` / `0` | `full` and `partial` from `cutOptions`, and `feed_dots` (0–600) to push the last lines past the blade. Zero feeds three lines |
| `density` | object | off | `supported`, and `level` 0–8: how hard the head burns |
| `commands` | object | kept | `start_print`, `end_print` and `status_request`, each a hex string. Spaces, commas and `0x` are ignored; anything that is not hex is a `400`. A field that is not sent keeps what the type already had |

**Returns** `{"ok": true, "key": "custom-...", "state": {...}}`.

`flow` is the block that decides whether a long page prints or streaks. A
printer that drops the bottom half of everything is being fed faster than it
can burn: smaller writes and a longer pause between them. It was a constant
tuned against one machine before it was a profile field.

Anything the printer cannot do in firmware is drawn into the picture instead,
which is slower and softer but always prints. The head width is the one field
that has to be right.

Custom types live in `~/.local/share/thermal-printer/printer-profiles.json` and
are merged over the shipped table, so a bundled entry can be corrected by
reusing its key.

## `DELETE /api/printer-types/<key>`

Only removes one of yours. `404` otherwise.

---

# Labels

## `GET /api/templates`

The backgrounds on offer, with the sizes a caller needs in order to place text.

```json
{ "templates": [
  { "name": "CTP500_8BitToDo", "file": "CTP500_8BitToDo.png",
    "width": 384, "height": 804, "mine": false }
] }
```

`mine` marks a background you added, which is also the only kind that can be
deleted. Fetch the picture itself from `GET /templates/<file>`.

## `POST /api/templates`

Keep a picture as a background of its own.

| Field | Type | Meaning |
|-------|------|---------|
| `data` | string | A `data:image/...;base64,...` URL. Required, 8 MB limit |
| `name` | string | Used for the file name; slugged, and made unique |

The image is converted to PNG and kept at its own size: nothing is resized,
because text is placed in the background's own pixels and the printer's width
is applied once, at render time.

**Returns** `{"ok": true, "file": "...", "name": "...", "width": n, "height": n, "mine": true}`.

## `DELETE /api/templates/<file>.png`

Only removes one of yours. `404` for a shipped background.

## `GET /api/labels`, `POST /api/labels`, `DELETE /api/labels/<name>`

A saved label is a background plus the blocks placed on it, under a name.

```json
{ "name": "Shipping", "template": "my-label.png", "areas": [ ... ] }
```

`areas` are the same shape `/api/label` takes. Saving over a name replaces it.
Both `POST` and `DELETE` return the whole list back, sorted by name.

---

# Documents that persist

## `GET /api/presets`, `POST /api/presets`, `DELETE /api/presets/<id>`

A preset is a document you keep, with the settings it was designed against.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `id` | string | generated | Send it to update, omit it to create |
| `name` | string | — | Required |
| `description` | string | `""` | A line about it |
| `text` | string | `""` | The markdown |
| `options` | object | — | `font`, `size` and `darkness` are kept |

`{{date}}`, `{{time}}`, `{{datetime}}` and `{{weekday}}` in the text are filled
in **when it prints**, not when it is saved, so a stored preset stays a
template.

`POST` returns `{"ok": true, "preset": {...}, "presets": [...]}`.

## `GET /api/todos`, `POST /api/todos`, `PATCH /api/todos/<id>`, `DELETE /api/todos/<id>`, `POST /api/todos/clear-done`

A list that persists. `POST` takes `{"text": "..."}`. `PATCH` takes `done`
and/or `text`; sent without `done`, it toggles. `clear-done` takes no body.
All of them return the whole list back.

---

# Reference data

| Endpoint | What it returns |
|----------|-----------------|
| `GET /api/fonts` | `{"fonts": [...], "default": "DejaVuSansMono"}`, the families the renderer can load |
| `GET /api/themes` | The manifest, built-in plus yours: `id`, `name`, `href`, `swatch`, `print` |
| `GET /api/dither` | `{"modes": [{"id", "label"}], "default": "floyd-steinberg", "prefilters": [{"id", "label"}], "prefilter_default": "none"}` |
| `GET /api/symbols` | The glyph table, grouped: `{"groups": [{"name", "symbols": [{"char", "name", "use"}]}]}`. Sent whole, since it is small and never changes |

## `POST /api/images`

Take a data URL and keep it as a file, named by the hash of its contents, so
the same picture inserted twice costs one copy.

```json
{ "data": "data:image/png;base64,..." }
```

**Returns** `{"ok": true, "url": "/images/ab12cd34.png"}`, which is what goes in
the markdown. `400` if it is not an image or is over 8 MB. Fetch it back from
`GET /images/<name>`.

---

# Examples

Print a note:

```bash
curl -s localhost:8760/api/print \
  -H 'Content-Type: application/json' \
  -d '{"text": "# Back in five\n\nknock if urgent"}'
```

Save a preview to look at:

```bash
curl -s localhost:8760/api/preview \
  -H 'Content-Type: application/json' \
  -d '{"text": "# Saturday\n- [ ] film\n- [ ] framer", "options": {"size": 28}}' \
  -o preview.png
```

A banner down the roll, at a readable size:

```bash
curl -s localhost:8760/api/print \
  -H 'Content-Type: application/json' \
  -d '{"text": "# CLOSED", "options": {"orientation": "landscape", "page_length": 900, "size": 90}}'
```

Connect, then print, in two steps:

```bash
curl -s localhost:8760/api/connect -H 'Content-Type: application/json' \
     -d '{"profile": "MPT-II Bluetooth"}'
curl -s localhost:8760/api/print -H 'Content-Type: application/json' \
     -d '{"text": "hello"}'
```

Today's month, to a file:

```bash
curl -s localhost:8760/api/calendar -H 'Content-Type: application/json' \
     -d '{"range": "month"}' -o month.png
```
