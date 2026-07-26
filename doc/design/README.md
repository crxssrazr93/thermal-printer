# UI/UX design directions

Five visual directions for a full interface overhaul. These are **static mockups**,
nothing is wired up. They exist to pick a direction before any code is written.

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8777 --directory doc/design
```

Every mockup shows the same screen so they can be compared like for like:
connection state, section nav, markdown toolbar, editor beside a live receipt
preview, presets, and a status line. Each has its own light/dark toggle in the
header.

| # | Direction | Character | Type |
|---|-----------|-----------|------|
| 01 | Swiss Console | Hairline grid, monochrome, one blue accent. Dense and quiet, closest to a professional instrument. | Inter |
| 02 | Paper & Ink | E-ink warmth. The receipt is a physical object on a desk, torn edge included. | IBM Plex |
| 03 | Terminal | OLED black, monospace throughout, command line and tmux status bar. Keyboard-first. | JetBrains Mono |
| 04 | Neo-Brutalist | Hard borders, offset shadows, primary colour blocks. Loud and obviously tactile. | Space Grotesk |
| 05 | Monochrome Glass | Floating frosted panels with depth but no hue. Black and white chrome, one green LED for connection state. | Inter |

## Notes on the choices

Directions 01 to 04 are rated WCAG AAA by the style database. 05 (glassmorphism)
carries a contrast warning, so the panels use 0.78 opacity rather than the 0.1
that makes glass illegible in light mode.

05 was reworked from a purple/blue gradient to monochrome. The gradient version
read as generic rather than as this app, and it fought the brief of a black and
white interface with colour only where it carries meaning. Depth now comes from
blur, elevation and a neutral grey wash; the only colour left in the chrome is
the connection LED, which leaves the black-on-white receipt as the most
saturated thing on screen. Markup in the editor is cued by weight and opacity
instead of syntax colours.

All five were checked in both light and dark mode. Icons are inline SVG, never
emoji. Interactive elements carry `cursor: pointer`, focus rings are visible,
transitions sit in the 150 to 250ms range, and `prefers-reduced-motion` is
respected.

Direction 05 is the most natural fit for a browser or PWA build, and 01 or 03
translate most directly to the existing CustomTkinter desktop app.
