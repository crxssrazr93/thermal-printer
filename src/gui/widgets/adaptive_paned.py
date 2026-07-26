# editor/preview splitter that follows the window shape
#
# A receipt preview is a tall narrow strip, so it belongs beside the editor
# rather than under it: side by side, both panes get the full window height and
# the preview stops stealing vertical space from the text. That only holds
# while the window is wide enough, so below a threshold the split falls back to
# stacked, which is the better shape for a narrow window.

import logging
from tkinter import HORIZONTAL, PanedWindow, TclError, VERTICAL

import customtkinter as ctk

from ...config.defaults import (
    EDITOR_SPLIT_RATIO_H,
    EDITOR_SPLIT_RATIO_V,
    SIDE_BY_SIDE_HYSTERESIS,
    SIDE_BY_SIDE_MIN_WIDTH,
)

logger = logging.getLogger(__name__)


class AdaptivePaned(PanedWindow):
    """Two-pane splitter that re-orients itself as the window is resized.

    Create the two child frames with this widget as their master, then hand
    them to `set_panes`. The sash is positioned automatically until the user
    drags it, after which their choice is left alone for that orientation.
    """

    def __init__(self, master, primary_minsize: int = 100,
                 secondary_minsize: int = 80, **kwargs):
        # the tk widget is not themed, so it needs a background matching the
        # current appearance mode or the sash gutter flashes white in dark mode
        background = "#3B3B3B" if ctk.get_appearance_mode() == "Dark" else "#DBDBDB"

        super().__init__(
            master,
            orient=HORIZONTAL,
            sashwidth=8,
            sashrelief="raised",
            bg=background,
            **kwargs
        )

        self._primary_minsize = primary_minsize
        self._secondary_minsize = secondary_minsize
        self._horizontal = True
        self._sash_placed = False
        self._user_moved_sash = False

        self.bind("<Configure>", self._on_configure)
        self.bind("<ButtonRelease-1>", self._on_sash_release)

    # -------------------------------------------------------------------------
    # setup
    # -------------------------------------------------------------------------
    def set_panes(self, primary, secondary) -> None:
        self.add(primary, minsize=self._primary_minsize)
        self.add(secondary, minsize=self._secondary_minsize)

    # -------------------------------------------------------------------------
    # behaviour
    # -------------------------------------------------------------------------
    def _on_sash_release(self, event=None) -> None:
        # a click anywhere else in the gutter is harmless; what matters is that
        # once the user expresses a preference we stop overriding it
        self._user_moved_sash = True

    def _on_configure(self, event=None) -> None:
        width = self.winfo_width()
        height = self.winfo_height()
        if width <= 1 or height <= 1 or len(self.panes()) < 2:
            return

        # widen the threshold when already stacked so the two transitions do
        # not sit on the same pixel
        threshold = (
            SIDE_BY_SIDE_MIN_WIDTH - SIDE_BY_SIDE_HYSTERESIS
            if self._horizontal else SIDE_BY_SIDE_MIN_WIDTH
        )
        wants_horizontal = width >= threshold

        if wants_horizontal != self._horizontal:
            self._horizontal = wants_horizontal
            self.configure(orient=HORIZONTAL if wants_horizontal else VERTICAL)
            # the old sash position means nothing in the new orientation
            self._user_moved_sash = False
            self._place_sash()
        elif not self._sash_placed:
            self._place_sash()

    def _place_sash(self) -> None:
        if self._user_moved_sash:
            return

        width = self.winfo_width()
        height = self.winfo_height()
        if width <= 1 or height <= 1:
            return

        try:
            if self._horizontal:
                self.sash_place(0, int(width * EDITOR_SPLIT_RATIO_H), 0)
            else:
                self.sash_place(0, 0, int(height * EDITOR_SPLIT_RATIO_V))
            self._sash_placed = True
        except TclError as error:
            logger.debug("Could not place sash: %s", error)
