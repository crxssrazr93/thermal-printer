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

## The print block

`print.font` and `print.size` set what the *paper* looks like, not the screen.
They apply when the theme is chosen, unless a font has been picked by hand, in
which case that choice is kept. The font must be a family installed on the
machine; the name comes from the font selector in Settings, and an unknown
name falls back silently rather than erroring.
