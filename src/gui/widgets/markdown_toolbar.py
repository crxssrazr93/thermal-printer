# markdown formatting toolbar
#
# Buttons edit the source text rather than styling it. The renderer already
# reads markdown, so the toolbar's only job is typing the syntax correctly:
# wrapping a selection, prefixing whole lines, or dropping in a skeleton and
# leaving the placeholder selected so the next keystroke replaces it.

import logging
from typing import Callable, Optional

import customtkinter as ctk

from .flow_frame import FlowFrame

logger = logging.getLogger(__name__)

_SEL = "sel"


class MarkdownToolbar(FlowFrame):

    def __init__(self, master, textbox, on_change: Optional[Callable] = None, **kwargs):
        super().__init__(master, **kwargs)
        self._textbox = textbox
        self._on_change = on_change
        self._build()

    # -------------------------------------------------------------------------
    # ui
    # -------------------------------------------------------------------------
    def _build(self) -> None:
        font = ctk.CTkFont(size=13)
        mono = ctk.CTkFont(family="monospace", size=13, weight="bold")

        # (label, tooltip-ish width, action)
        groups = [
            [
                ("H1", 36, lambda: self._prefix_lines("# ")),
                ("H2", 36, lambda: self._prefix_lines("## ")),
                ("H3", 36, lambda: self._prefix_lines("### ")),
            ],
            [
                ("B", 34, lambda: self._wrap("**", "**", "bold")),
                ("I", 34, lambda: self._wrap("*", "*", "italic")),
                ("S", 34, lambda: self._wrap("~~", "~~", "strike")),
                ("</>", 42, lambda: self._wrap("`", "`", "code")),
            ],
            [
                ("List", 48, lambda: self._prefix_lines("- ")),
                ("1.", 38, lambda: self._prefix_lines("1. ", numbered=True)),
                ("Quote", 56, lambda: self._prefix_lines("> ")),
            ],
            [
                ("Link", 48, self._insert_link),
                ("Table", 56, self._insert_table),
                ("Code", 52, self._insert_code_block),
                ("Rule", 48, self._insert_rule),
                ("Math", 50, lambda: self._wrap("$", "$", "x^2")),
            ],
        ]

        for index, group in enumerate(groups):
            for label, width, action in group:
                self.add(ctk.CTkButton(
                    self, text=label, width=width, height=30,
                    font=mono if label in ("B", "I", "S", "</>") else font,
                    command=action
                ), gap=4)
            # a wider gap separates the groups without needing a divider widget
            if index < len(groups) - 1:
                self.add_spacer(12)

    # -------------------------------------------------------------------------
    # textbox helpers
    # -------------------------------------------------------------------------
    def _selection(self):
        """Return (start, end) of the selection, or None when there is none."""
        try:
            ranges = self._textbox.tag_ranges(_SEL)
        except Exception:
            return None
        if not ranges or len(ranges) < 2:
            return None
        return str(ranges[0]), str(ranges[1])

    def _select(self, start: str, end: str) -> None:
        try:
            self._textbox.tag_remove(_SEL, "1.0", "end")
            self._textbox.tag_add(_SEL, start, end)
            self._textbox.mark_set("insert", end)
            self._textbox.see(start)
        except Exception as error:
            logger.debug("Could not reselect after edit: %s", error)

    def _changed(self) -> None:
        self._textbox.focus_set()
        if self._on_change:
            self._on_change()

    # -------------------------------------------------------------------------
    # actions
    # -------------------------------------------------------------------------
    def _wrap(self, prefix: str, suffix: str, placeholder: str) -> None:
        """Wrap the selection, or insert the placeholder already wrapped."""
        selection = self._selection()

        if selection:
            start, end = selection
            body = self._textbox.get(start, end)
            self._textbox.delete(start, end)
            self._textbox.insert(start, f"{prefix}{body}{suffix}")
            self._select(start, f"{start}+{len(prefix) + len(body) + len(suffix)}c")
        else:
            cursor = self._textbox.index("insert")
            self._textbox.insert(cursor, f"{prefix}{placeholder}{suffix}")
            # leave the placeholder selected so typing replaces it
            body_start = f"{cursor}+{len(prefix)}c"
            self._select(body_start, f"{body_start}+{len(placeholder)}c")

        self._changed()

    def _prefix_lines(self, prefix: str, numbered: bool = False) -> None:
        """Add a line prefix to every line the selection touches.

        Toggles: a line that already carries the prefix has it stripped, so the
        same button turns a list back into plain lines.
        """
        selection = self._selection()
        if selection:
            first = int(str(selection[0]).split(".")[0])
            last = int(str(selection[1]).split(".")[0])
            # a selection ending at column 0 does not include that last line
            if str(selection[1]).split(".")[1] == "0" and last > first:
                last -= 1
        else:
            first = last = int(self._textbox.index("insert").split(".")[0])

        for offset, line_no in enumerate(range(first, last + 1)):
            line_start = f"{line_no}.0"
            line_end = f"{line_no}.end"
            body = self._textbox.get(line_start, line_end)

            applied = f"{offset + 1}. " if numbered else prefix

            if body.startswith(applied):
                self._textbox.delete(line_start, f"{line_start}+{len(applied)}c")
            else:
                stripped = self._strip_known_prefix(body)
                if stripped != body:
                    self._textbox.delete(
                        line_start, f"{line_start}+{len(body) - len(stripped)}c"
                    )
                self._textbox.insert(line_start, applied)

        self._changed()

    @staticmethod
    def _strip_known_prefix(line: str) -> str:
        """Drop an existing block marker so markers replace rather than stack."""
        import re
        return re.sub(r"^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)", "", line)

    def _insert_at_line_start(self, text: str) -> None:
        """Insert a block on its own line below the cursor."""
        cursor = self._textbox.index("insert")
        line_no = int(cursor.split(".")[0])
        current = self._textbox.get(f"{line_no}.0", f"{line_no}.end")

        # only open a new line when the current one has content on it
        anchor = f"{line_no}.end" if current.strip() else f"{line_no}.0"
        payload = f"\n{text}" if current.strip() else text

        self._textbox.insert(anchor, payload)
        self._changed()

    def _insert_link(self) -> None:
        selection = self._selection()
        if selection:
            start, end = selection
            body = self._textbox.get(start, end)
            self._textbox.delete(start, end)
            self._textbox.insert(start, f"[{body}](https://)")
            url_start = f"{start}+{len(body) + 3}c"
            self._select(url_start, f"{url_start}+8c")
        else:
            cursor = self._textbox.index("insert")
            self._textbox.insert(cursor, "[text](https://)")
            self._select(f"{cursor}+1c", f"{cursor}+5c")
        self._changed()

    def _insert_table(self) -> None:
        self._insert_at_line_start(
            "| Item | Qty |\n|---|---|\n| tea | 2 |\n| jam | 1 |"
        )

    def _insert_code_block(self) -> None:
        self._insert_at_line_start("```\ncode\n```")

    def _insert_rule(self) -> None:
        self._insert_at_line_start("---")
