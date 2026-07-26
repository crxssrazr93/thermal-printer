# markdown renderer for thermal output
#
# Deliberately hand-rolled rather than markdown -> HTML -> raster. A 1-bit strip
# a few hundred dots wide has no use for most of HTML, and every rendering
# decision here is about what survives at 203 dpi: weight instead of colour,
# rules instead of margins, monospace instead of syntax highlighting.

import logging
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from ..config.defaults import DEFAULT_LINE_SPACING
from ..config.printer_profile import get_printer_width
from ..utils.font_manager import get_font_manager
from .math_renderer import render_math

logger = logging.getLogger(__name__)

# Heading sizes as multipliers of the body size. Thermal heads lose thin
# strokes, so headings are bold as well as larger.
HEADING_SCALE = {1: 1.6, 2: 1.35, 3: 1.15, 4: 1.0, 5: 1.0, 6: 1.0}

BULLETS = ["\u2022", "-", "*"]  # only glyphs the mono faces reliably carry

# How a page is set, as opposed to what it says. A theme supplies a partial
# override of this; anything it leaves out keeps the default, so a theme can be
# as light a touch as one different bullet.
DEFAULT_PRINT_STYLE = {
    "heading_case": "none",      # none | upper
    "heading_align": "left",     # left | center
    "heading_banner": False,     # set a level 1 heading white out of a black bar
    "heading_scale": 1.0,        # multiplier on top of HEADING_SCALE
    "rule_style": "solid",       # solid | double | dotted | none
    "rule_weight": 3,            # dots thick, for a level 1 heading rule
    "bullet": "\u2022",
    "table_rule": "dotted",      # dotted | solid | none
    "table_header_rule": 2,
    "quote_bar": 3,              # dots wide; 0 draws no bar
    "quote_italic": True,
    "block_gap": 6,              # blank dots between two paragraphs
    "margin": 6,                 # dots of white down each side of the page
    "margin_top": 6,
    "margin_bottom": 6,
    "rule_gap_above": 4,         # between heading text and its rule
    "heading_gap": 8,            # between that rule and whatever follows
    "list_indent": 14,           # the bullet, inset from the margin
    "list_gap": 8,               # around a list as a whole
    "list_item_gap": 3,          # between two items of one list
    "quote_gap": 10,             # around a quote
    "quote_pad": 12,             # the text, inset from the bar
    "table_gap": 12,             # around a table
    "table_scale": 0.9,          # cell size as a fraction of the body
    "table_cell_pad": 4,         # above and below the text in a cell
}

_INLINE_CODE = re.compile(r"`([^`]+)`")
# Emphasis must not fire mid-word. Markdown allows intraword "*", but on a
# printer the input is as often plain text as markup, and silently italicising
# the 3 in "2*3*4" or the middle of "some_var_name" corrupts what was typed.
# Requiring a non-word character on both sides keeps prose literal.
_BOLD = re.compile(r"(?<!\w)(?:\*\*|__)(.+?)(?:\*\*|__)(?!\w)")
_ITALIC = re.compile(r"(?<![\w\*_])(?:\*|_)([^\*_\s][^\*_]*?)(?:\*|_)(?![\w\*_])")
_STRIKE = re.compile(r"~~(.+?)~~")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_TABLE_DIRECTIVE = re.compile(r"<!--\s*table\s+(.*?)\s*-->")


def _parse_directive(body: str) -> dict:
    return dict(
        part.split("=", 1) for part in body.split() if "=" in part
    )


def _cell_alignment(cell: str) -> str:
    left, right = cell.startswith(":"), cell.endswith(":")
    if left and right:
        return "center"
    if right:
        return "right"
    return "left"


@dataclass
class Span:
    """A run of text sharing one style."""
    text: str
    bold: bool = False
    italic: bool = False
    mono: bool = False


@dataclass
class Block:
    kind: str                      # paragraph | heading | list | code | quote | rule | table | math
    spans: List[Span] = field(default_factory=list)
    level: int = 0                 # heading level, list depth
    ordered: bool = False
    index: int = 0                 # ordered list counter
    rows: List[List[str]] = field(default_factory=list)   # table only
    align: List[str] = field(default_factory=list)        # table only: left|center|right
    borders: str = ""                                     # table only: all|header|none
    lines: List[str] = field(default_factory=list)        # code only


class MarkdownRenderer:
    """Renders a markdown subset to a 1-bit friendly greyscale image."""

    def __init__(
        self,
        width: Optional[int] = None,
        font_family: str = "DejaVu Sans Mono",
        font_size: int = 24,
        line_spacing: Optional[float] = None,
        margin: int = 6,
        style: Optional[dict] = None,
    ):
        self.width = width if width is not None else get_printer_width()
        self.font_family = font_family
        self.font_size = font_size
        self.line_spacing = line_spacing if line_spacing is not None else DEFAULT_LINE_SPACING
        self.style = {**DEFAULT_PRINT_STYLE, **(style or {})}
        self.margin = int(self.style["margin"]) if margin == 6 else margin
        self._fm = get_font_manager()
        self._italic_cache = {}

    # -------------------------------------------------------------------------
    # TextRenderer-compatible surface
    #
    # BaseTextFrame drives whichever renderer it holds, so matching that small
    # interface lets the markdown tab reuse the whole existing frame - font
    # controls, preview, gallery, print - instead of duplicating it.
    # -------------------------------------------------------------------------
    def update_font(self, font_family: str = None, font_size: int = None,
                    bold: bool = False, italic: bool = False) -> None:
        if font_family:
            self.font_family = font_family
        if font_size:
            self.font_size = int(font_size)

    def set_alignment(self, alignment: str) -> None:
        # markdown carries its own block structure; a global alignment would
        # fight it, so this is accepted and ignored
        pass

    def set_wrap(self, wrap: bool) -> None:
        pass

    # -------------------------------------------------------------------------
    # fonts
    # -------------------------------------------------------------------------
    ITALIC_FALLBACK = "DejaVuSansMono"   # ships an oblique, which many mono faces do not

    _ITALIC_STYLES = ("BoldItalic", "BoldOblique", "Italic", "Oblique")

    def _slanted_path(self, family: str, bold: bool):
        """A genuinely slanted face for this family, or None.

        The font manager matches style names loosely and will happily hand back
        the Bold file when asked for an Italic, so the file name is checked
        before the result is believed.
        """
        styles = self._ITALIC_STYLES if bold else self._ITALIC_STYLES[2:]
        for style in styles:
            path = self._fm.get_font_path(family, style, fallback=False)
            if path and re.search(r"italic|oblique", Path(path).name, re.I):
                return path
        return None

    def _font(self, size: int, bold: bool = False, italic: bool = False, mono: bool = False):
        family = "DejaVu Sans Mono" if mono else self.font_family

        if italic:
            key = (family, size, bold)
            if key not in self._italic_cache:
                # borrowing an oblique from another mono face keeps a quote
                # looking like a quote; substituting regular, which is what the
                # font manager does on its own, silently drops the distinction
                path = self._slanted_path(family, bold) or self._slanted_path(
                    self.ITALIC_FALLBACK, bold)
                try:
                    self._italic_cache[key] = ImageFont.truetype(path, size) if path else None
                except OSError:
                    self._italic_cache[key] = None
            slanted = self._italic_cache[key]
            if slanted is not None:
                return slanted

        font = self._fm.load_font(family, size, bold=bold, italic=italic)
        if font is None and (bold or italic):
            font = self._fm.load_font(family, size)
        return font

    def _line_height(self, font) -> int:
        try:
            ascent, descent = font.getmetrics()
            base = ascent + descent
        except (AttributeError, OSError):
            base = int(self.font_size * 1.2)
        return max(1, int(base * self.line_spacing))

    # -------------------------------------------------------------------------
    # parsing
    # -------------------------------------------------------------------------
    def parse(self, text: str) -> List[Block]:
        blocks: List[Block] = []
        lines = text.replace("\r\n", "\n").split("\n")
        i = 0
        ordered_counter = 0
        pending_directive: dict = {}

        while i < len(lines):
            raw = lines[i]
            stripped = raw.strip()

            # fenced code
            if stripped.startswith("```"):
                code: List[str] = []
                i += 1
                while i < len(lines) and not lines[i].strip().startswith("```"):
                    code.append(lines[i])
                    i += 1
                i += 1
                blocks.append(Block(kind="code", lines=code))
                continue

            if not stripped:
                i += 1
                ordered_counter = 0
                continue

            # display math - $$ ... $$ on its own lines
            if stripped.startswith("$$"):
                math_lines = [stripped[2:]]
                if not stripped.endswith("$$") or len(stripped) < 4:
                    i += 1
                    while i < len(lines) and not lines[i].strip().endswith("$$"):
                        math_lines.append(lines[i])
                        i += 1
                    if i < len(lines):
                        math_lines.append(lines[i].strip().rstrip("$"))
                else:
                    math_lines = [stripped[2:-2]]
                i += 1
                blocks.append(Block(kind="math", lines=[" ".join(math_lines).strip()]))
                continue

            # horizontal rule
            if re.fullmatch(r"(\s*[-*_]\s*){3,}", raw):
                blocks.append(Block(kind="rule"))
                i += 1
                continue

            # a directive is a comment carrying the choices markdown has no
            # syntax for, so a table can remember how it was set without the
            # document stopping being markdown
            directive = _TABLE_DIRECTIVE.match(stripped)
            if directive:
                pending_directive = _parse_directive(directive.group(1))
                i += 1
                continue

            # table - a header row followed by a separator of dashes
            if "|" in stripped and i + 1 < len(lines) and re.fullmatch(
                r"\s*\|?[\s:|-]+\|?\s*", lines[i + 1]
            ) and "-" in lines[i + 1]:
                rows = []
                align: List[str] = []
                while i < len(lines) and "|" in lines[i]:
                    body = lines[i].strip().strip("|")
                    cells = [c.strip() for c in body.split("|")]
                    if re.fullmatch(r"[\s:|-]+", body):
                        align = [_cell_alignment(c) for c in cells]
                    else:
                        rows.append(cells)
                    i += 1
                blocks.append(Block(
                    kind="table", rows=rows, align=align,
                    borders=pending_directive.get("borders", ""),
                ))
                pending_directive = {}
                continue

            # heading
            heading = re.match(r"(#{1,6})\s+(.*)", stripped)
            if heading:
                blocks.append(Block(
                    kind="heading",
                    level=len(heading.group(1)),
                    spans=self._parse_inline(heading.group(2)),
                ))
                i += 1
                continue

            # blockquote
            if stripped.startswith(">"):
                blocks.append(Block(
                    kind="quote",
                    spans=self._parse_inline(stripped.lstrip("> ").strip()),
                ))
                i += 1
                continue

            # lists
            indent = len(raw) - len(raw.lstrip(" "))
            bullet = re.match(r"[-*+]\s+(.*)", stripped)
            numbered = re.match(r"(\d+)[.)]\s+(.*)", stripped)

            if bullet:
                blocks.append(Block(
                    kind="list", level=indent // 2,
                    spans=self._parse_inline(bullet.group(1)),
                ))
                i += 1
                continue

            if numbered:
                ordered_counter += 1
                blocks.append(Block(
                    kind="list", level=indent // 2, ordered=True,
                    index=ordered_counter,
                    spans=self._parse_inline(numbered.group(2)),
                ))
                i += 1
                continue

            # paragraph - one block per typed line
            #
            # Markdown proper joins consecutive lines into one paragraph, but
            # that convention exists for source files that get re-flowed later.
            # Here the user is typing what a receipt should look like, so a
            # newline is a line break. Long lines still soft-wrap to the paper.
            blocks.append(Block(kind="paragraph", spans=self._parse_inline(stripped)))
            i += 1

        return blocks

    def _parse_inline(self, text: str) -> List[Span]:
        """Flatten inline markup into styled spans.

        Links become "text (url)" because a printed page cannot be clicked, and
        dropping the target would lose information the reader needs.
        """
        text = _IMAGE.sub(lambda m: f"[image: {m.group(1) or m.group(2)}]", text)
        text = _LINK.sub(lambda m: f"{m.group(1)} ({m.group(2)})", text)
        text = _STRIKE.sub(lambda m: "".join(c + "̶" for c in m.group(1)), text)

        spans: List[Span] = []
        pattern = re.compile(
            r"(?P<code>`[^`]+`)|(?P<both>(?<!\w)\*\*\*.+?\*\*\*(?!\w))|"
            r"(?P<bold>(?<!\w)(?:\*\*|__).+?(?:\*\*|__)(?!\w))|"
            r"(?P<italic>(?<![\w\*_])[\*_][^\*_\s][^\*_]*?[\*_](?![\w\*_]))"
        )

        position = 0
        for match in pattern.finditer(text):
            if match.start() > position:
                spans.append(Span(text[position:match.start()]))
            if match.group("code"):
                spans.append(Span(match.group("code")[1:-1], mono=True))
            elif match.group("both"):
                spans.append(Span(match.group("both")[3:-3], bold=True, italic=True))
            elif match.group("bold"):
                spans.append(Span(_BOLD.sub(r"\1", match.group("bold")), bold=True))
            else:
                spans.append(Span(_ITALIC.sub(r"\1", match.group("italic")), italic=True))
            position = match.end()

        if position < len(text):
            spans.append(Span(text[position:]))
        return spans or [Span(text)]

    # -------------------------------------------------------------------------
    # layout
    # -------------------------------------------------------------------------
    def _wrap_spans(self, spans: List[Span], font_size: int, available: int
                    ) -> List[List[Tuple[Span, str, object]]]:
        """Greedy word wrap that keeps per-word styling."""
        lines: List[List[Tuple[Span, str, object]]] = [[]]
        x = 0

        for span in spans:
            font = self._font(font_size, span.bold, span.italic, span.mono)
            if font is None:
                continue
            for word in re.findall(r"\s+|\S+", span.text) or []:
                if word.isspace() and not lines[-1]:
                    continue  # no leading space at the start of a wrapped line
                try:
                    word_width = font.getlength(word)
                except (AttributeError, OSError):
                    word_width = font_size * len(word) * 0.6

                if x + word_width > available and lines[-1]:
                    lines.append([])
                    x = 0
                    word = word.lstrip()
                    if not word:
                        continue
                    try:
                        word_width = font.getlength(word)
                    except (AttributeError, OSError):
                        pass

                lines[-1].append((span, word, font))
                x += word_width

        return [line for line in lines if line] or [[]]

    def render(self, text: str, max_height: int = 20000) -> Image.Image:
        blocks = self.parse(text)
        width = self.width
        body = self.margin

        image = Image.new("RGB", (width, max_height), "white")
        draw = ImageDraw.Draw(image)
        y = int(self.style["margin_top"])

        previous = None
        for block in blocks:
            if previous is not None:
                y += self._gap(previous, block.kind)
            y = self._draw_block(draw, image, block, y, body, width)
            previous = block.kind
            if y > max_height - 100:
                break

        # trim to content
        return image.crop(
            (0, 0, width, min(max_height, y + int(self.style["margin_bottom"])))
        )

    def _gap(self, previous: str, kind: str) -> int:
        """White space between two blocks, taken from whichever rule is stronger."""
        style = self.style
        if previous == "heading":
            return int(style["heading_gap"])
        if "table" in (previous, kind):
            return int(style["table_gap"])
        if "quote" in (previous, kind):
            return int(style["quote_gap"])
        if previous == "list" and kind == "list":
            return int(style["list_item_gap"])
        if "list" in (previous, kind):
            return int(style["list_gap"])
        return int(style["block_gap"])

    def _draw_block(self, draw, image, block: Block, y: int, left: int, width: int) -> int:
        right_margin = self.margin

        if block.kind == "rule":
            draw.rectangle([left, y, width - right_margin, y + 1], fill="black")
            return y + 2

        if block.kind == "code":
            font = self._font(max(12, int(self.font_size * 0.8)), mono=True)
            pitch = self._line_height(font)
            box_top = y
            inner = left + 6
            for line in block.lines:
                draw.text((inner, y + 3), line, font=font, fill="black")
                y += pitch
            # a left bar reads as "code" without needing a background fill,
            # which would waste an enormous amount of thermal ink
            draw.rectangle([left, box_top, left + 2, y + 2], fill="black")
            return y + 2

        if block.kind == "math":
            expression = block.lines[0] if block.lines else ""
            rendered = render_math(
                expression,
                font_size=self.font_size,
                max_width=width - left - right_margin,
            )
            if rendered is None:
                # unparseable or matplotlib missing - the source is still
                # more useful to a reader than nothing at all
                font = self._font(max(12, int(self.font_size * 0.85)), mono=True)
                draw.text((left, y), expression, font=font, fill="black")
                return y + self._line_height(font) + 6

            x = left + max(0, (width - left - right_margin - rendered.width) // 2)
            image.paste(rendered, (x, y))
            return y + rendered.height

        if block.kind == "table":
            return self._draw_table(draw, block, y, left, width)

        if block.kind == "heading":
            return self._draw_heading(draw, block, y, left, width)

        if block.kind == "quote":
            bar = int(self.style["quote_bar"])
            inner = left + int(self.style["quote_pad"])
            top = y
            lines = self._wrap_spans(block.spans, self.font_size, width - inner - right_margin)
            for line in lines:
                y = self._draw_line(draw, line, y, inner, self.font_size,
                                    force_italic=bool(self.style["quote_italic"]))
            if bar:
                draw.rectangle([left, top, left + bar, y], fill="black")
            return y

        if block.kind == "list":
            marker = f"{block.index}." if block.ordered else self._bullet(block.level)
            indent = left + int(self.style["list_indent"]) + block.level * 16
            font = self._font(self.font_size)
            try:
                marker_width = int(font.getlength(marker + " "))
            except (AttributeError, OSError):
                marker_width = self.font_size
            draw.text((indent, y), marker, font=font, fill="black")
            lines = self._wrap_spans(
                block.spans, self.font_size, width - indent - marker_width - right_margin
            )
            for line in lines:
                y = self._draw_line(draw, line, y, indent + marker_width, self.font_size)
            return y

        lines = self._wrap_spans(block.spans, self.font_size, width - left - right_margin)
        for line in lines:
            y = self._draw_line(draw, line, y, left, self.font_size)
        return y

    # ---------------------------------------------------------------- style
    def _bullet(self, level: int) -> str:
        if level == 0:
            return str(self.style["bullet"]) or BULLETS[0]
        return BULLETS[min(level, 2)]

    @staticmethod
    def _line_width(line) -> int:
        total = 0
        for _span, word, font in line:
            try:
                total += font.getlength(word)
            except (AttributeError, OSError):
                total += len(word) * 8
        return int(total)

    def _draw_rule(self, draw, x0: int, x1: int, y: int, weight: int) -> int:
        """Draw the rule the theme asked for and return the height it used."""
        kind = self.style["rule_style"]
        if kind == "none":
            return 0
        if kind == "dotted":
            self._dotted_rule(draw, x0, x1, y)
            return 1
        if kind == "double":
            draw.rectangle([x0, y, x1, y], fill="black")
            draw.rectangle([x0, y + 3, x1, y + 3], fill="black")
            return 4
        draw.rectangle([x0, y, x1, y + weight - 1], fill="black")
        return weight

    def _draw_heading(self, draw, block: Block, y: int, left: int, width: int) -> int:
        right = width - self.margin
        scale = HEADING_SCALE.get(block.level, 1.0) * float(self.style["heading_scale"])
        size = max(10, int(self.font_size * scale))

        spans = block.spans
        if self.style["heading_case"] == "upper":
            spans = [Span(s.text.upper(), s.bold, s.italic, s.mono) for s in spans]

        banner = bool(self.style["heading_banner"]) and block.level == 1
        pad = 5 if banner else 0
        available = width - left - self.margin - 2 * pad
        lines = self._wrap_spans(spans, size, available)

        if banner:
            # a filled bar with the heading knocked out of it; the strongest
            # mark a one-bit page can make, and unmistakably one theme's voice
            height = sum(
                max((self._line_height(font) for _s, _w, font in line), default=size)
                for line in lines
            )
            draw.rectangle([left, y, right, y + height + 2 * pad], fill="black")
            text_y = y + pad
            for line in lines:
                x = left + pad
                if self.style["heading_align"] == "center":
                    x = left + max(pad, (right - left - self._line_width(line)) // 2)
                text_y = self._draw_line(draw, line, text_y, x, size,
                                         force_bold=True, fill="white")
            return y + height + 2 * pad + 8

        for line in lines:
            x = left
            if self.style["heading_align"] == "center":
                x = left + max(0, (right - left - self._line_width(line)) // 2)
            y = self._draw_line(draw, line, y, x, size, force_bold=True)

        if block.level <= 2:
            # a second level heading takes a hairline, so the two levels read
            # as a hierarchy rather than as two of the same thing
            weight = int(self.style["rule_weight"]) if block.level == 1 else 1
            above = int(self.style["rule_gap_above"])
            used = self._draw_rule(draw, left, right, y + above, weight)
            y += above + used
        return y

    def _draw_line(self, draw, line, y: int, x_start: int, size: int,
                   force_bold: bool = False, force_italic: bool = False,
                   fill: str = "black") -> int:
        x = x_start
        height = 0
        for span, word, font in line:
            if force_bold or force_italic:
                font = self._font(size, span.bold or force_bold,
                                  span.italic or force_italic, span.mono)
            if font is None:
                continue
            draw.text((x, y), word, font=font, fill=fill)
            try:
                x += font.getlength(word)
            except (AttributeError, OSError):
                x += size * len(word) * 0.6
            height = max(height, self._line_height(font))
        return y + (height or int(size * 1.2))

    def _draw_table(self, draw, block: Block, y: int, left: int, width: int) -> int:
        if not block.rows:
            return y

        columns = max(len(row) for row in block.rows)
        usable = width - left - self.margin
        column_width = usable // max(1, columns)
        right = width - self.margin

        size = max(10, int(self.font_size * float(self.style["table_scale"])))
        font = self._font(size, mono=True)
        header_font = self._font(size, bold=True, mono=True)
        pad = int(self.style["table_cell_pad"])
        pitch = self._line_height(font) + pad

        # "all" draws the full grid, "none" drops every rule, and anything else
        # is the theme's own treatment: a rule under the header and whatever it
        # asks for between body rows
        borders = block.borders or "theme"
        top = y

        for row_index, row in enumerate(block.rows):
            x = left
            for column, cell in enumerate(row[:columns]):
                # a cell is text like any other, so **bold** in one has to be
                # drawn bold rather than printed with its asterisks showing
                spans = self._parse_inline(cell)
                drawn = []
                used = 0
                for span in spans:
                    bold = span.bold or row_index == 0
                    span_font = self._font(size, bold, span.italic, mono=True) \
                        or (header_font if row_index == 0 else font)
                    # hard truncate: wrapping inside a cell on a narrow strip
                    # produces unreadable ragged columns
                    text = span.text
                    while text:
                        try:
                            if used + span_font.getlength(text) <= column_width - 2 * pad:
                                break
                        except (AttributeError, OSError):
                            break
                        text = text[:-1]
                    if not text:
                        continue
                    try:
                        span_width = span_font.getlength(text)
                    except (AttributeError, OSError):
                        span_width = size * len(text) * 0.6
                    drawn.append((text, span_font, span_width))
                    used += span_width

                alignment = block.align[column] if column < len(block.align) else "left"
                if alignment == "right":
                    cursor = x + column_width - pad - used
                elif alignment == "center":
                    cursor = x + (column_width - used) / 2
                else:
                    cursor = x + pad

                for text, span_font, span_width in drawn:
                    draw.text((cursor, y + pad), text, font=span_font, fill="black")
                    cursor += span_width
                x += column_width

            y += pitch + pad

            if borders == "none":
                continue
            if row_index == 0:
                weight = max(1, int(self.style["table_header_rule"]))
                draw.rectangle([left, y, right, y + weight - 1], fill="black")
                y += weight
            elif row_index < len(block.rows) - 1 or borders == "all":
                kind = "solid" if borders == "all" else self.style["table_rule"]
                if kind == "dotted":
                    self._dotted_rule(draw, left, right, y)
                    y += 1
                elif kind == "solid":
                    draw.rectangle([left, y, right, y], fill="black")
                    y += 1

        if borders == "all":
            # the outer frame and the column rules, drawn once the height of
            # the whole table is known
            draw.rectangle([left, top, right, y], outline="black", width=1)
            for column in range(1, columns):
                x = left + column * column_width
                draw.rectangle([x, top, x, y], fill="black")

        return y

    @staticmethod
    def _dotted_rule(draw, x0: int, x1: int, y: int, dash: int = 3, gap: int = 4) -> None:
        x = x0
        while x < x1:
            draw.rectangle([x, y, min(x + dash, x1), y], fill="black")
            x += dash + gap
