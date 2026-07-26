# centered dialog base class
# uses transient window with wm decorations for wayland compatibility
#
# wayland positioning workaround as compositors ignore window geometry hints by design
# the window must be shown first then positioned after a short delay
# the splash window type gives limited positioning control while maintaining native decorations
# modal grab must also be delayed until the window is fully visible

import tkinter as tk
from typing import Optional, Callable
import customtkinter as ctk


class CenteredDialog(ctk.CTkToplevel):
    # base class for centered dialogs
    # subclasses override _build_content() to add UI to self.content_frame

    MIN_WIDTH = 200
    MIN_HEIGHT = 150

    def __init__(
        self,
        master,
        title: str = "Dialog",
        width: int = 400,
        height: int = 300,
        resizable: bool = True,
        on_close: Optional[Callable] = None,
        **kwargs
    ):
        super().__init__(master, **kwargs)

        self._parent = master.winfo_toplevel()
        self._dialog_title = title
        self._dialog_width = width
        self._dialog_height = height
        self._on_close_callback = on_close

        # hide until positioned
        self.withdraw()

        # use transient for proper parent relationship and wayland compatibility
        self.transient(self._parent)

        # set window title (shown in WM title bar)
        self.title(self._dialog_title)

        # splash type helps with positioning on wayland
        try:
            self.attributes('-type', 'splash')
        except tk.TclError:
            pass

        # configure resizable behavior
        if resizable:
            self.minsize(self.MIN_WIDTH, self.MIN_HEIGHT)
        else:
            self.resizable(False, False)

        # handle WM close button
        self.protocol("WM_DELETE_WINDOW", self._handle_close)

        # the splash window type drops the WM titlebar, so Escape is the only
        # dismissal that cannot be clipped or covered
        self.bind("<Escape>", lambda _event: self._handle_close())

        # build UI structure
        self._build_dialog_frame()
        self._build_content_area()

        # let subclass build content
        self._build_content()

        # center and show
        self.after(10, self._center_and_show)

    def _build_dialog_frame(self) -> None:
        self._main_frame = ctk.CTkFrame(
            self,
            fg_color=("gray95", "gray14"),
            corner_radius=0
        )
        self._main_frame.pack(fill="both", expand=True)

    def _build_content_area(self) -> None:
        self.content_frame = ctk.CTkFrame(
            self._main_frame,
            fg_color="transparent"
        )
        self.content_frame.pack(fill="both", expand=True, padx=12, pady=12)

    def _build_content(self) -> None:
        # override to add content to self.content_frame
        pass

    def _fit_to_content(self) -> None:
        """Grow the dialog to whatever the built content actually needs.

        The width/height passed in are a starting hint, not a limit. Honouring
        them literally clips the bottom of a taller form, and since the splash
        window type gives no titlebar, clipping the action row leaves a dialog
        with no visible way to dismiss it.
        """
        self.update_idletasks()

        needed_width = self._main_frame.winfo_reqwidth()
        needed_height = self._main_frame.winfo_reqheight()

        # never outgrow the screen; the frame scrolls or clips before that
        max_width = int(self.winfo_screenwidth() * 0.9)
        max_height = int(self.winfo_screenheight() * 0.9)

        self._dialog_width = max(self._dialog_width, min(needed_width, max_width))
        self._dialog_height = max(self._dialog_height, min(needed_height, max_height))

    def _center_and_show(self) -> None:
        # update_idletasks required for accurate dimensions before centering
        self._parent.update_idletasks()
        self.update_idletasks()

        self._fit_to_content()

        parent_x = self._parent.winfo_x()
        parent_y = self._parent.winfo_y()
        parent_width = self._parent.winfo_width()
        parent_height = self._parent.winfo_height()

        x = parent_x + (parent_width - self._dialog_width) // 2
        y = parent_y + (parent_height - self._dialog_height) // 2

        # ensure dialog stays on screen
        screen_width = self.winfo_screenwidth()
        screen_height = self.winfo_screenheight()
        x = max(0, min(x, screen_width - self._dialog_width))
        y = max(0, min(y, screen_height - self._dialog_height))

        # store for delayed positioning
        self._target_x = x
        self._target_y = y

        # set size and show
        self.geometry(f"{self._dialog_width}x{self._dialog_height}")
        self.deiconify()
        self.update_idletasks()

        # set position after short delay as wayland compositor needs time
        self.after(50, self._apply_position)

    def _apply_position(self) -> None:
        self.geometry(f"+{self._target_x}+{self._target_y}")
        self.update_idletasks()
        # make modal after positioning
        self.after(10, self._make_modal)

    def _make_modal(self) -> None:
        try:
            # delay grab to avoid wayland compositor issues
            self.grab_set()
            self.focus_force()
        except tk.TclError:
            self.after(50, self._make_modal)

    def _handle_close(self) -> None:
        self._on_close()

    def _on_close(self) -> None:
        # override for cleanup before closing
        if self._on_close_callback:
            self._on_close_callback()
        self.destroy()

    def set_title(self, title: str) -> None:
        self._dialog_title = title
        self.title(title)

    def destroy(self) -> None:
        try:
            self.grab_release()
        except tk.TclError:
            pass
        super().destroy()
