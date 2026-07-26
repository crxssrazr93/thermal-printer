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

from PIL import Image, ImageDraw

from ..config.defaults import DEFAULT_LINE_SPACING
from ..config.printer_profile import get_printer_width
from ..utils.font_manager import get_font_manager
from .math_renderer import render_math

logger = logging.getLogger(__name__)

# Heading sizes as multipliers of the body size. Thermal heads lose thin
# strokes, so headings are bold as well as larger.
HEADING_SCALE = {1: 1.6, 2: 1.35, 3: 1.15, 4: 1.0, 5: 1.0, 6: 1.0}

BULLETS = ["\u2022", "-", "*"]  # only glyphs the mono faces reliably carry

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
    ):
        self.width = width if width is not None else get_printer_width()
        self.font_family = font_family
        self.font_size = font_size
        self.line_spacing = line_spacing if line_spacing is not None else DEFAULT_LINE_SPACING
        self.margin = margin
        self._fm = get_font_manager()

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
    def _font(self, size: int, bold: bool = False, italic: bool = False, mono: bool = False):
        family = "DejaVu Sans Mono" if mono else self.font_family
        font = self._fm.load_font(family, size, bold=bold, italic=italic)
        if font is None and (bold or italic):
            # not every family ships every style - fall back to regular rather
            # than dropping the text entirely
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

            # table - a header row followed by a separator of dashes
            if "|" in stripped and i + 1 < len(lines) and re.fullmatch(
                r"\s*\|?[\s:|-]+\|?\s*", lines[i + 1]
            ) and "-" in lines[i + 1]:
                rows = []
                while i < len(lines) and "|" in lines[i]:
                    cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                    if not re.fullmatch(r"[\s:|-]+", lines[i].strip().strip("|")):
                        rows.append(cells)
                    i += 1
                blocks.append(Block(kind="table", rows=rows))
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
            r"(?P<code>`[^`]+`)|(?P<bold>(?<!\w)(?:\*\*|__).+?(?:\*\*|__)(?!\w))|"
            r"(?P<italic>(?<![\w\*_])[\*_][^\*_\s][^\*_]*?[\*_](?![\w\*_]))"
        )

        position = 0
        for match in pattern.finditer(text):
            if match.start() > position:
                spans.append(Span(text[position:match.start()]))
            if match.group("code"):
                spans.append(Span(match.group("code")[1:-1], mono=True))
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
        y = self.margin

        for block in blocks:
            y = self._draw_block(draw, image, block, y, body, width)
            if y > max_height - 100:
                break

        # trim to content
        return image.crop((0, 0, width, min(max_height, y + self.margin)))

    def _draw_block(self, draw, image, block: Block, y: int, left: int, width: int) -> int:
        right_margin = self.margin

        if block.kind == "rule":
            draw.rectangle([left, y + 4, width - right_margin, y + 5], fill="black")
            return y + 14

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
            return y + 8

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
            return y + rendered.height + 8

        if block.kind == "table":
            return self._draw_table(draw, block, y, left, width)

        if block.kind == "heading":
            size = max(10, int(self.font_size * HEADING_SCALE.get(block.level, 1.0)))
            lines = self._wrap_spans(block.spans, size, width - left - right_margin)
            for line in lines:
                y = self._draw_line(draw, line, y, left, size, force_bold=True)
            if block.level <= 2:
                # a heavier rule under a top-level heading, so the hierarchy is
                # legible on paper where there is no colour to carry it
                thickness = 3 if block.level == 1 else 1
                draw.rectangle(
                    [left, y + 2, width - right_margin, y + 2 + thickness], fill="black"
                )
                y += 8 + thickness
            return y + 4

        if block.kind == "quote":
            inner = left + 12
            top = y
            lines = self._wrap_spans(block.spans, self.font_size, width - inner - right_margin)
            for line in lines:
                y = self._draw_line(draw, line, y, inner, self.font_size, force_italic=True)
            draw.rectangle([left, top, left + 3, y], fill="black")
            return y + 6

        if block.kind == "list":
            marker = f"{block.index}." if block.ordered else BULLETS[min(block.level, 2)]
            indent = left + block.level * 16
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
            return y + 2

        lines = self._wrap_spans(block.spans, self.font_size, width - left - right_margin)
        for line in lines:
            y = self._draw_line(draw, line, y, left, self.font_size)
        return y + 6

    def _draw_line(self, draw, line, y: int, x_start: int, size: int,
                   force_bold: bool = False, force_italic: bool = False) -> int:
        x = x_start
        height = 0
        for span, word, font in line:
            if force_bold or force_italic:
                font = self._font(size, span.bold or force_bold,
                                  span.italic or force_italic, span.mono)
            if font is None:
                continue
            draw.text((x, y), word, font=font, fill="black")
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

        size = max(10, int(self.font_size * 0.8))
        font = self._font(size, mono=True)
        header_font = self._font(size, bold=True, mono=True)
        pitch = self._line_height(font)

        for row_index, row in enumerate(block.rows):
            x = left
            for cell in row[:columns]:
                cell_font = header_font if row_index == 0 else font
                # hard truncate: wrapping inside a cell on a narrow strip
                # produces unreadable ragged columns
                text = cell
                while text:
                    try:
                        if font.getlength(text) <= column_width - 4:
                            break
                    except (AttributeError, OSError):
                        break
                    text = text[:-1]
                draw.text((x, y), text, font=cell_font or font, fill="black")
                x += column_width
            y += pitch
            if row_index == 0:
                draw.rectangle([left, y, width - self.margin, y + 2], fill="black")
                y += 5
            elif row_index < len(block.rows) - 1:
                # dotted rather than solid between body rows: it separates the
                # rows without the page turning into a grid of black bars
                self._dotted_rule(draw, left, width - self.margin, y + 3)
                y += 8

        return y + 6

    @staticmethod
    def _dotted_rule(draw, x0: int, x1: int, y: int, dash: int = 3, gap: int = 4) -> None:
        x = x0
        while x < x1:
            draw.rectangle([x, y, min(x + dash, x1), y], fill="black")
            x += dash + gap
