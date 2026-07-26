# Development

## Running from a checkout

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
./web/run-web.sh          # or: python3 -m web.server
```

`THERMAL_WEB_HOST` and `THERMAL_WEB_PORT` change where it listens. Nothing is
built at start-up: the front end is static files, and the editor bundle is
committed.

## Layout

| Path | What is in it |
|------|---------------|
| `web/server.py` | The whole server: routing, the session, the API |
| `web/static/` | The front end: `app.js`, `base.css`, `index.html`, themes |
| `web/static/vendor/tiptap.js` | The editor bundle, built by `tools/build-editor-bundle.sh` |
| `src/processing/` | Renderers: markdown, calendar, label, text, maths, dithering |
| `src/core/` | Printer connection, transports, ESC/POS protocol, print jobs |
| `src/config/` | Settings, device profiles, capability profiles |
| `src/utils/` | Fonts, Bluetooth helpers, validators |
| `gallery/templates/` | Label backgrounds |
| `packaging/` | The systemd user unit |

## The editor bundle

TipTap is vendored as a single esbuild IIFE that puts the pieces on
`window.TipTap`. Rebuild it with:

```bash
tools/build-editor-bundle.sh
```

That needs node and npm, but only for the rebuild: running the app never does.
The bundle is committed so the app has no build step, and the script exists so
the committed file is reproducible rather than mysterious.

## The HTTP API

Everything the front end does goes through these. All bodies are JSON unless
noted; anything that returns a page returns a PNG.

| Method and path | What it does |
|-----------------|--------------|
| `GET /api/state` | Connection, profiles, head width, dpi, tear gap |
| `GET /api/fonts` | Font families available to the renderer |
| `GET /api/themes` | The theme manifest, built-in plus yours |
| `GET /api/dither` | The screening methods and their labels |
| `GET /api/symbols` | The glyph table, grouped |
| `GET /api/templates` | Label backgrounds and their sizes |
| `POST /api/preview` | `{text, options}` to a PNG; `X-Trimmed` says if it did not fit |
| `POST /api/print` | The same, to the printer |
| `POST /api/calendar` | A month or a week, previewed or printed |
| `POST /api/label` | Text composed onto a background, previewed or printed |
| `POST /api/images` | A data URL in, a stored reference out |
| `POST /api/tear-test` | Print a calibration strip at a given gap |
| `POST /api/connect`, `/api/disconnect` | Open or close the printer |
| `GET/POST/DELETE /api/presets`, `/api/todos` | The saved things |

## How a page becomes paper

1. The browser sends markdown and options.
2. `MarkdownRenderer` draws a 1-bit page at the head's width, applying the
   theme's print style: font, spacing, rules, bullets, table treatment.
3. Along the roll, the page is composed on a strip and turned a quarter turn.
4. `ImageProcessor` converts it to raster bytes, inverting polarity because a
   set bit means a fired dot.
5. `PrinterProtocol.build_raster_bands` cuts it into 64-row commands.
6. The transport writes them in full, in small pieces, behind a lock.

The preview is steps 1 to 3 with the polarity left alone, which is why it is
the print rather than a picture of one.

## Conventions

The code is commented for the reader who wants to know why, not what. Prose
comments over labels; a comment that restates the line below it is noise. If
something looks odd, the comment should say what made it odd.

Markdown is the document everywhere: the editor, presets, to-dos and the
printer all speak it. Anything markdown cannot express (border treatment,
column widths, a picture's screening) rides in a directive comment or in
markdown's title slot rather than in a side-car format.

## Tests

There is no suite yet. What exists is a set of things worth checking by hand
before a change ships: render every theme in both directions, print a page with
a table, a picture and a right to left line, and watch the preview height stay
put while a slider moves.
