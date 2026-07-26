# Thermal Print Studio

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.9%2B-yellow)](pyproject.toml)
[![Platform](https://img.shields.io/badge/platform-Linux-blue)](docs/platforms.md)

A print server with a browser front end for 58 mm ESC/POS thermal printers.
Install it once and it stays running, reachable at a fixed address from any tab
on the machine, from a phone on the same network, or as an installed web app
with its own window.

Write in a real editor, watch the exact bitmap the print head will receive, and
print it.

![Composing a page, with the print preview beside it](docs/images/compose.jpg)

## Install

```bash
git clone https://github.com/crxssrazr93/thermal-print-studio.git
cd thermal-print-studio
./install.sh
```

That installs the app for your user, registers a **systemd user service** and
starts it, so there is nothing to launch afterwards. It is simply there, at

**<http://127.0.0.1:8760>**

Chrome and Edge offer **Install** in the address bar, which gives it its own
window and icon. Network access, updating and removal are covered in
[docs/install.md](docs/install.md).

## What it does

- **Compose** in a rich editor or in raw markdown, with a preview that is the
  print bitmap rather than a CSS impression of one
- **Tables** you type into, with rows, columns, alignment, borders and column
  widths that are printed as you set them
- **Pictures** by button, paste or drop, screened with any of eleven methods
  and a cutoff and amount you control
- **Checklists**, highlight, underline, superscript, subscript, and a picker
  for nine hundred symbols
- **Right to left scripts** shaped and set from the right, mixed freely with
  English
- **Along the roll** printing, for banners and tickets that run down the paper
- **Labels** composed onto printed backgrounds, and **calendars** by month or
  week
- **Presets** that carry their own font, size and direction and fill in
  `{{date}}`, and a **to-do list** that prints
- **Four themes**, light and dark, each setting the paper as well as the
  screen, and all of them replaceable

## Documentation

| Document | What is in it |
|----------|---------------|
| [Install](docs/install.md) | Installing, the service, network access, updating, removing |
| [Using it](docs/usage.md) | The editor, tables, pictures, direction, languages, labels, calendars, presets |
| [Printers](docs/printers.md) | Transports, device profiles, the tear-off gap, capability profiles |
| [Themes](web/static/themes/README.md) | Writing your own theme, on screen and on paper |
| [Platforms](docs/platforms.md) | What runs where, and what a Windows or macOS contributor would need |
| [Development](docs/development.md) | Layout, running from a checkout, the HTTP API, the editor bundle |
| [Troubleshooting](docs/troubleshooting.md) | When it will not connect, print, or find a font |
| [Fork changes](docs/FORK-CHANGES.md) | What this fork changed, and why |
| [Credits](docs/CREDITS.md) | Whose work this builds on |

## Requirements

Python 3.9 or newer, Pillow, PyYAML and numpy. A Bluetooth adapter and BlueZ
for the Bluetooth transport; nothing extra for USB or CUPS. Linux is the tested
platform: see [docs/platforms.md](docs/platforms.md).

## Where things live

Presets, to-dos, uploaded pictures and your own themes are kept in
`~/.local/share/thermal-printer/`, and printer profiles in `config.yaml` beside
the code. Installing, updating and removing the app never touch either.

## Origins

This began as
[n3m0-22/thermal-printer](https://github.com/n3m0-22/thermal-printer), a
CustomTkinter desktop app for the Core Innovation CTP-500, which in turn built
on the community that reverse engineered that printer. It has since become a
different thing: a server and a web app, generalised to any 58 mm ESC/POS
printer through capability profiles in the
[escpos-printer-db](https://github.com/receipt-print-hq/escpos-printer-db)
schema, with USB and CUPS transports alongside Bluetooth. The desktop GUI has
been retired and everything it did lives in the web app.

Tested on a 58 mm MPT-II over Bluetooth RFCOMM and USB.

## Contributing

Issues and pull requests are welcome, particularly for printers other than the
one this was built against and for the platforms listed in
[docs/platforms.md](docs/platforms.md).

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) and [docs/CREDITS.md](docs/CREDITS.md).
