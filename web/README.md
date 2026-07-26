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
| Presets and to-dos | `~/.local/share/thermal-printer/` |
| Printer settings and devices | shared with the desktop app's `config.yaml` |
| Front end | `web/static/` |
| Server | `web/server.py` |
| Built-in themes | `web/static/themes/` |
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

Each theme also names the font its printed output uses, so switching theme
changes the paper as well as the screen. Choosing a font by hand pins it, and
from then on theme changes leave it alone.

## Editor modes

Rendered mode is a mirror element drawn behind the textarea, carrying the
decoration while the textarea carries transparent text and the caret. The thing
being edited stays plain markdown, so selection, undo, and every toolbar button
behave identically in both modes. It also means the decoration has to be
metric neutral: colour, weight and slant are fine, padding and font size are
not, because they would slide the glyphs out from under the caret.
