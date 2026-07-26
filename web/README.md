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
- Four themes, each with light and dark, chosen from the switcher at the
  bottom right

## Where things live

| What | Where |
|------|-------|
| Presets and to-dos | `~/.local/share/thermal-printer/` |
| Printer settings and devices | shared with the desktop app's `config.yaml` |
| Front end | `web/static/` |
| Server | `web/server.py` |

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
