# Web UI

A browser front end for the same printer the desktop app drives. Run it, open
the page, and it stays available in a tab; the desktop app does not need to be
running.

```
./web/run-web.sh
```

Then open <http://127.0.0.1:8760>. Chrome offers "Install" from the address
bar, which gives it its own window and icon.

## Why a server rather than a pure web page

A browser cannot open an RFCOMM socket or write to `/dev/usb/lp0`, so anything
touching hardware has to stay in Python. Rendering stays there too, which is
the more useful half: the preview in the browser is the exact bitmap sent to
the print head, produced by the same `MarkdownRenderer` and `ImageProcessor`
the desktop app uses, rather than a CSS approximation that drifts from the
real output.

The server is stdlib only. This runs on the same machine as the printer, so a
web framework would add install friction for no benefit at this size.

## What it does

- **Compose** with the markdown toolbar and a live preview
- **To-dos** that persist, with a one-tap "Print list"
- **Presets**: save the current text, reopen it later, edit, print
- **Settings**: tear gap, font size, darkness, and device management
  (scan Bluetooth/USB/CUPS, save and remove devices)
- **Rendered and raw** editing: rendered paints the markdown as you type,
  raw shows the source. Both edit the same plain markdown
- Four themes, each with light and dark, chosen from the switcher at the
  bottom right, and each with its own printing font

## Where things live

| What | Where |
|------|-------|
| Presets, to-dos and images | `~/.local/share/thermal-printer/` |
| Printer settings and devices | shared with the desktop app's `config.yaml` |
| Front end | `web/static/` |
| Server | `web/server.py` |
| Built-in themes | `web/static/themes/` |
| Editor bundle | `web/static/vendor/tiptap.js`, built by `tools/build-editor-bundle.sh` |
| Your themes | `~/.local/share/thermal-printer/themes/` |

Presets and to-dos sit outside the repo so a `git checkout` cannot wipe them.
Printer configuration is deliberately shared, so a device saved in one app
appears in the other.

## Notes

Writes to the printer are serialised behind a lock. A thermal printer is a
single serial stream, so two overlapping jobs would interleave their bytes and
print garbage; the lock holds no matter how many tabs are open.

The service worker is network-first, not cache-first. Cache-first is the usual
advice but it hides every edit to the CSS or JS until the cache is cleared by
hand, which is the wrong trade for something served from localhost.

The server binds to `127.0.0.1` and has no authentication, so it is reachable
only from this machine. Set `THERMAL_WEB_HOST=0.0.0.0` to expose it to the
network, and understand that anyone who can reach it can print.

## Themes

A theme is a CSS file plus an entry in a manifest, never code. Nothing in the
front end knows the built-in themes by name: it asks the server for the list,
links each stylesheet, builds the switcher from it, and takes the printing font
from the same entry.

Drop your own into `~/.local/share/thermal-printer/themes/` alongside a
`themes.json` and it appears in the switcher on the next reload. Reusing a
built-in id replaces that theme with yours. `web/static/themes/README.md` has
the full shape, the variable list, and the rules for writing theme CSS that
cannot leak into the rest of the page.

Each theme also describes how its printed output is set: the font, the line
spacing, and a handful of typographic choices (headings in capitals or knocked
out of a filled bar, the weight and style of rules, the bullet glyph, how table
rows are separated, how quotes are marked). Switching theme therefore changes
the paper as much as the screen. Choosing a font by hand pins it, and from then
on theme changes leave the font alone while the rest of the setting still
follows the theme.

## Editor modes

Two editors over one document, and markdown is the document.

Toolbar buttons that can be on or off are toggles, and they light up when they
are on: Bold inside bold text removes it, H1 on a heading turns it back into a
paragraph. The ones with no off state, inserting a table, a rule or a picture,
never light up.

**Rendered** is a real editing surface, built on TipTap. A heading is a
heading, a quote has its bar, and a table is a table you type into. The toolbar
and the styling stay ours, so each theme still owns how the document looks.

**Raw** is the markdown itself, in a plain textarea, for when the source is
what you want to see. Switching converts, and either way markdown is what gets
previewed, printed and saved.

### Why a library

The first version of rendered mode was hand written, and tables were where that
stopped being tenable: a decorated textarea can paint markdown but it cannot
give you a cell to type in. TipTap brings a document model, undo, paste
handling, resizable columns and keyboard behaviour that would otherwise all
have to be rebuilt. It is headless, which matters here, since a themed editor
cannot be wearing another product's chrome.

The bundle is built once by `tools/build-editor-bundle.sh` and committed to
`web/static/vendor/`. Running the app needs no node, no npm and no build step;
the script exists so the vendored file is reproducible rather than mysterious.

### Tables

Put the caret in a table and its controls appear at the top of the pane: add or
remove a row or a column, align a column left, centre or right, cycle the
border treatment, or remove the table. Tab walks the cells. Drag a column
boundary to change its width.

Alignment rides in the separator row, which is markdown's own syntax for it, so
any other reader of the file gets it too, and the printer honours it. Border
treatment has no markdown syntax, so it is written as a directive comment above
the table and read back the same way.

Column widths are a view concern: markdown has nowhere to keep them, so a drag
changes what you see and never what prints. Row height follows the content for
the same reason.

### Pictures

The Image button uploads the file to the server, which stores it by content
hash under `~/.local/share/thermal-printer/images/` and hands back a reference
the document carries as ordinary markdown. At print time the renderer scales it
to the paper and screens it into dots, since a thermal head has one colour. An
image that cannot be loaded prints its alt text rather than leaving a hole.

Eleven screening methods are available. The diffusion kernels come from
dither-me-this, which states each one as offsets and factors over a common
divisor:

| Method | Suits |
|--------|-------|
| Threshold | line art, text, logos, anything already black and white |
| Ordered | an even, visibly patterned look |
| Sierra lite | fast and grainy |
| False Floyd-Steinberg | coarser and faster than the real one |
| Floyd-Steinberg | photographs, the usual default |
| Burkes | sharper than Floyd-Steinberg |
| Sierra two row | lighter than full Sierra |
| Sierra | smooth gradients |
| Jarvis-Judice-Ninke | smooth, with the error spread widest |
| Stucki | the finest detail, and the slowest |
| Atkinson | soft results, and the least ink on the paper |

Settings holds the default. A single picture can override it from the control
that appears when the picture is selected, and that choice travels in
markdown's own title slot, `![alt](path "atkinson")`, so it stays with the
document and any other reader simply ignores it.

## Direction

Normally a page is composed across the roll: 384 dots wide, as long as it
needs. **Along the roll** composes it the other way, on a strip as long as you
ask for and only as deep as the head is wide, then turns it a quarter turn so
the lines run down the paper. You get long lines and few of them, which suits a
banner, a label or a ticket. Anything deeper than the head is wide is trimmed
rather than scaled, since scaling would quietly change the size you chose.

## Languages

Arabic, Hebrew and the other right to left scripts print properly: the text is
shaped and joined, the line runs from the right, and a bullet or a quote bar
goes on the right where the line begins. A document can mix directions freely,
paragraph by paragraph, and the editor lays each one out the way it reads.

Most monospaced faces carry no Arabic at all, so a right to left run is set in
a face that does. The theme's `rtl_font` chooses which; it defaults to DejaVu
Sans Mono.

## Size

The font size in Settings and on the toolbar is the size of the *page*, not of
the selection: it sets the body size the whole receipt is composed at, and
headings scale from it. Emphasis within a document comes from the document,
through headings, bold, and the marks. Markdown has nowhere to record a size
for one run of text, and a receipt that changed size halfway through would not
survive being saved and reopened.
