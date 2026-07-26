# Themes

A theme is data, not code: one CSS file plus an entry in a manifest. Nothing in
the app knows the built-in themes by name, so adding your own needs no changes
to `app.js` or `base.css`.

## Making one

Drop a CSS file and a `themes.json` into:

```
~/.local/share/thermal-printer/themes/
```

`themes.json` there uses the same shape as this folder's:

```json
{
  "themes": [
    {
      "id": "mine",
      "name": "Midnight",
      "stylesheet": "midnight.css",
      "swatch": ["#7C3AED", "#0B0B0F"],
      "print": { "font": "DejaVuSansMono", "size": 24 }
    }
  ]
}
```

User themes are merged after the built-ins, so reusing an `id` replaces the
built-in with yours.

## Writing the CSS

Scope everything to the root element and your id, so a theme can never leak
into the rest of the page:

```css
:root[data-theme="mine"]{
  --bg:#0B0B0F;
  --panel:#15151C;
  --ink:#EDEDF2;
  --accent:#7C3AED;
  --radius:12px;
}
:root[data-theme="mine"][data-mode="light"]{
  --bg:#FAFAFC;
  --panel:#FFFFFF;
  --ink:#0B0B0F;
}
```

Setting variables alone gets you a complete theme. Add ordinary rules after
them when the character needs more than colour, as theme 3 does for its offset
shadows and theme 4 does for its blur.

`[data-mode]` is `light` or `dark` and is independent of the theme, so define
both if you want the toggle to work.

## Variables

| Group | Names |
|-------|-------|
| Surfaces | `--bg` `--panel` `--panel-2` |
| Text | `--ink` `--muted` `--faint` |
| Lines | `--line` `--line-strong` |
| Accent | `--accent` `--accent-ink` |
| Status | `--ok` `--danger` |
| Shape | `--radius` `--radius-sm` `--radius-paper` `--border` |
| Depth | `--shadow` `--shadow-lift` `--panel-blur` `--press` |
| Type | `--font-ui` `--font-head` `--font-mono` |
| Spacing | `--gap` `--pad` |
| Editor | `--md-h-bg` `--md-strong-bg` `--md-quote-bg` `--md-quote-bar` `--md-table-bg` |

The editor variables tint the rendered editing mode. Only tint them, and only
with colour or an inset `box-shadow`, which is how the quote bar is drawn: the
rendered editor lays a decorated mirror behind the textarea, so anything that
changes size, padding or spacing moves the glyphs out from under the caret.

## The print block

`print` describes what the *paper* looks like, not the screen, so a theme
changes the receipt as well as the window.

```json
"print": {
  "font": "NotoSansMono Black",
  "size": 24,
  "line_spacing": 1.08,
  "style": {
    "heading_case": "upper",
    "heading_banner": true,
    "rule_weight": 4,
    "bullet": "\u25aa",
    "table_rule": "solid",
    "quote_bar": 6
  }
}
```

`font` and `size` apply when the theme is chosen, unless a font has been picked
by hand, in which case that choice is kept. The font must be a family installed
on the machine; the name comes from the font selector in Settings, and an
unknown name falls back silently rather than erroring. `style` always follows
the theme, including when printing a preset that carries its own font.

Every key in `style` is optional and falls back to the default, so a theme can
be as light a touch as one different bullet.

| Key | Values | What it does |
|-----|--------|--------------|
| `heading_case` | `none`, `upper` | sets headings in capitals |
| `heading_align` | `left`, `center` | centres headings on the strip |
| `heading_banner` | `true`, `false` | knocks a level 1 heading white out of a filled bar |
| `heading_scale` | number | multiplier on the heading sizes |
| `rule_style` | `solid`, `double`, `dotted`, `none` | the rule under a heading |
| `rule_weight` | dots | how thick that rule is when solid |
| `bullet` | any glyph | the marker on an unordered list |
| `table_rule` | `dotted`, `solid`, `none` | separators between table rows |
| `table_header_rule` | dots | thickness of the rule under a table header |
| `quote_bar` | dots | width of the bar beside a quote, 0 for none |
| `quote_italic` | `true`, `false` | sets quotes in italic |
| `block_gap` | dots | space after a paragraph |
| `margin` | dots | side margins on the strip |
| `margin_top` | dots | space above the first block |
| `margin_bottom` | dots | space below the last block, before the tear |
| `heading_gap` | dots | space above a heading |
| `rule_gap_above` | dots | space between a heading and its rule |
| `list_gap` | dots | space above a list |
| `list_indent` | dots | how far list text is set in from the margin |
| `list_item_gap` | dots | space between items in a list |
| `quote_gap` | dots | space above a quote |
| `quote_pad` | dots | space between the quote bar and its text |
| `table_gap` | dots | space above a table |
| `table_scale` | number | multiplier on the table's type size |
| `table_cell_pad` | dots | padding inside a table cell |
| `rtl_font` | family name | face used for right to left text, if the body face lacks it |
| `image_dither` | method id | how pictures are screened when they do not say |
| `image_threshold` | 0 to 255 | the cutoff: how much of a picture becomes ink |
| `image_strength` | 0 to 1 | how much of the dithering is applied |

The three image keys are only defaults. A picture that carries its own
settings in markdown's title slot overrides all of them.

Pick glyphs the font actually carries. A thermal head at 203 dpi also loses
hairlines, so anything meant to read as a rule wants at least two dots.
