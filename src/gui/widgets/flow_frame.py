# flow layout container - lays children left to right and wraps to a new row
# when the available width runs out, instead of clipping them off the edge

from typing import List, Optional, Tuple
import customtkinter as ctk

from ...config.defaults import (
    FLOW_DEFAULT_HGAP,
    FLOW_DEFAULT_VGAP,
    FLOW_MIN_USABLE_WIDTH,
)


class FlowFrame(ctk.CTkFrame):
    """Container that arranges children in a horizontal flow.

    Children are placed left to right. When the next child would overflow the
    container's current width, it wraps onto a new row. The container reports
    its own height so a parent using pack(fill="x") allocates the right space.

    Use add() instead of packing children directly - the frame owns their
    geometry via place().
    """

    def __init__(
        self,
        master,
        hgap: int = FLOW_DEFAULT_HGAP,
        vgap: int = FLOW_DEFAULT_VGAP,
        **kwargs
    ):
        kwargs.setdefault("fg_color", "transparent")
        super().__init__(master, **kwargs)

        self._items: List[Tuple[ctk.CTkBaseClass, int]] = []
        self._trailing: List[Tuple[ctk.CTkBaseClass, int]] = []
        self._hgap = hgap
        self._vgap = vgap
        self._last_width: int = -1
        self._last_height: int = -1
        self._relayout_pending = False

        self.bind("<Configure>", self._on_configure)

    # -------------------------------------------------------------------------
    # public api
    # -------------------------------------------------------------------------
    def add(self, widget, gap: Optional[int] = None):
        """Register a child widget. Returns the widget for call chaining."""
        self._items.append((widget, self._hgap if gap is None else gap))
        widget.place(x=0, y=0)
        self._schedule_relayout()
        return widget

    def add_trailing(self, widget, gap: Optional[int] = None):
        """Register a child that hugs the right edge.

        Trailing items sit right-aligned on the last row while they fit. When
        the container is too narrow they drop onto their own row rather than
        being clipped, so they stay reachable at any width.
        """
        self._trailing.append((widget, self._hgap if gap is None else gap))
        widget.place(x=0, y=0)
        self._schedule_relayout()
        return widget

    def add_spacer(self, width: int):
        """Insert a fixed horizontal gap by widening the previous item's gap."""
        if self._items:
            widget, gap = self._items[-1]
            self._items[-1] = (widget, gap + width)
            self._schedule_relayout()

    def clear(self) -> None:
        for widget, _ in self._items + self._trailing:
            widget.place_forget()
        self._items.clear()
        self._trailing.clear()
        self._schedule_relayout()

    # -------------------------------------------------------------------------
    # layout
    # -------------------------------------------------------------------------
    def _on_configure(self, event) -> None:
        # only react to real width changes - height changes are our own doing
        if event.width != self._last_width:
            self._last_width = event.width
            self._relayout(event.width)

    def _schedule_relayout(self) -> None:
        # coalesce bursts of add() calls into a single layout pass
        if self._relayout_pending:
            return
        self._relayout_pending = True

        def run():
            self._relayout_pending = False
            self._relayout(self.winfo_width())

        self.after_idle(run)

    def _relayout(self, available: int) -> None:
        if not (self._items or self._trailing) or available <= FLOW_MIN_USABLE_WIDTH:
            return

        self.update_idletasks()

        x = 0
        y = 0
        row_height = 0

        for widget, gap in self._items:
            w = widget.winfo_reqwidth()
            h = widget.winfo_reqheight()

            # wrap when this item would overflow, but never wrap the first
            # item of a row (a single oversized widget just overhangs)
            if x > 0 and (x + w) > available:
                x = 0
                y += row_height + self._vgap
                row_height = 0

            widget.place(x=x, y=y)
            x += w + gap
            row_height = max(row_height, h)

        if self._trailing:
            widths = [widget.winfo_reqwidth() for widget, _ in self._trailing]
            gaps = [gap for _, gap in self._trailing[:-1]]
            block = sum(widths) + sum(gaps)

            # keep the block on the current row when it fits beside the
            # flowed items, otherwise give it a row of its own
            if x > 0 and (x + block) > available:
                y += row_height + self._vgap
                row_height = 0

            tx = max(0, available - block)
            for index, (widget, gap) in enumerate(self._trailing):
                widget.place(x=tx, y=y)
                tx += widths[index] + gap
                row_height = max(row_height, widget.winfo_reqheight())

        total_height = y + row_height
        if total_height != self._last_height:
            self._last_height = total_height
            self.configure(height=total_height)
