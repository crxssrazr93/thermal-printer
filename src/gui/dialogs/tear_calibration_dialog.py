# tear-off calibration wizard
#
# Walks the gap up in whole millimetres, printing a sample at each step, until
# the user confirms the paper tears exactly on the printed tear line. The
# accepted value is saved against the active printer profile, since the
# head-to-tear-bar distance is a property of the printer body.

import logging
from typing import Optional

import customtkinter as ctk
from PIL import Image, ImageDraw

from .centered_dialog import CenteredDialog
from ...config.defaults import (
    MAX_TEAR_GAP_MM,
    TEAR_CALIBRATION_LINES,
    TEAR_CALIBRATION_START_MM,
    TEAR_CALIBRATION_STEP_MM,
)
from ...config.printer_profile import (
    get_printer_width,
    get_profile,
    get_profile_name,
    mm_to_dots,
    set_tear_gap_mm,
)
from ...core.protocol import PrinterProtocol
from ...processing.image_processor import ImageProcessor
from ...utils.font_manager import get_font_manager

logger = logging.getLogger(__name__)


class TearCalibrationDialog(CenteredDialog):

    MIN_WIDTH = 460
    MIN_HEIGHT = 340

    def __init__(self, master, printer, on_status=None, **kwargs):
        self._printer = printer
        self._on_status = on_status
        self._mm = float(TEAR_CALIBRATION_START_MM)
        self._accepted: Optional[float] = None

        super().__init__(
            master,
            title="Calibrate tear-off",
            width=480,
            height=360,
            **kwargs
        )

    # -------------------------------------------------------------------------
    # ui
    # -------------------------------------------------------------------------
    def _build_content(self) -> None:
        title_font = ctk.CTkFont(size=17, weight="bold")
        body_font = ctk.CTkFont(size=13)
        value_font = ctk.CTkFont(size=30, weight="bold")

        ctk.CTkLabel(
            self.content_frame,
            text="Tear-off calibration",
            font=title_font
        ).pack(anchor="w", pady=(0, 6))

        ctk.CTkLabel(
            self.content_frame,
            text=(
                "A sample prints at each gap. Tear it off against the bar.\n"
                "If it tears exactly on the printed line, accept it -\n"
                "otherwise step up 1mm and try again."
            ),
            font=body_font,
            justify="left"
        ).pack(anchor="w", pady=(0, 12))

        self.value_label = ctk.CTkLabel(
            self.content_frame, text="", font=value_font
        )
        self.value_label.pack(pady=(0, 2))

        self.detail_label = ctk.CTkLabel(
            self.content_frame, text="", font=body_font, text_color="gray"
        )
        self.detail_label.pack(pady=(0, 14))

        self.print_button = ctk.CTkButton(
            self.content_frame,
            text="Print sample",
            height=38,
            command=self._print_sample
        )
        self.print_button.pack(fill="x", pady=(0, 10))

        answer_row = ctk.CTkFrame(self.content_frame, fg_color="transparent")
        answer_row.pack(fill="x")

        self.yes_button = ctk.CTkButton(
            answer_row,
            text="Yes - tears on the line",
            height=38,
            fg_color=("green", "#00AA00"),
            hover_color=("darkgreen", "#008800"),
            state="disabled",
            command=self._accept
        )
        self.yes_button.pack(side="left", expand=True, fill="x", padx=(0, 6))

        self.no_button = ctk.CTkButton(
            answer_row,
            text="No - try next",
            height=38,
            state="disabled",
            command=self._next_step
        )
        self.no_button.pack(side="left", expand=True, fill="x", padx=(6, 0))

        self.status_label = ctk.CTkLabel(
            self.content_frame, text="", font=body_font, text_color="gray"
        )
        self.status_label.pack(anchor="w", pady=(12, 0))

        self._refresh()

    def _refresh(self) -> None:
        dots = mm_to_dots(self._mm)
        self.value_label.configure(text=f"{self._mm:g} mm")
        self.detail_label.configure(
            text=f"{dots} dots  ·  profile: {get_profile().get('name', get_profile_name())}"
        )

    def _set_status(self, message: str) -> None:
        self.status_label.configure(text=message)
        if self._on_status:
            self._on_status(message)

    # -------------------------------------------------------------------------
    # sample
    # -------------------------------------------------------------------------
    def _build_sample(self) -> Image.Image:
        """Four lines of body text plus the tear line.

        Fewer lines leaves too little to grip, which makes the tear itself
        unreliable and the result hard to judge.
        """
        width = get_printer_width()
        fm = get_font_manager()
        f_head = fm.load_font("DejaVu Sans Mono", 24, bold=True)
        f_body = fm.load_font("DejaVu Sans Mono", 24, bold=False)

        rows = [(f_head, f"TEAR TEST {self._mm:g}mm")]
        rows += [(f_body, f"line {i + 1}") for i in range(TEAR_CALIBRATION_LINES)]

        pitch = 30
        height = pitch * len(rows) + 16
        img = Image.new("RGB", (width, height), "white")
        draw = ImageDraw.Draw(img)

        y = 2
        for font, text in rows:
            draw.text((6, y), text, font=font, fill="black")
            y += pitch

        # the line the tear should land on
        draw.rectangle([0, y + 4, width - 1, y + 6], fill="black")
        return img

    def _print_sample(self) -> None:
        if not self._printer or not self._printer.is_connected:
            self._set_status("Not connected to a printer")
            return

        self.print_button.configure(state="disabled")
        try:
            image = ImageProcessor(
                printer_width=get_printer_width(), auto_resize=False
            ).process(self._build_sample())

            self._printer.initialize()
            self._printer.start_print()
            self._printer.send_image(
                PrinterProtocol.build_raster_command(image)
            )
            self._printer.send_raw(
                PrinterProtocol.build_feed_dots(mm_to_dots(self._mm))
            )
            self._printer.end_print()

            self.yes_button.configure(state="normal")
            self.no_button.configure(state="normal")
            self._set_status(f"Printed {self._mm:g}mm - tear it off and judge the line")
        except Exception as error:
            logger.warning("Tear calibration print failed: %s", error)
            self._set_status(f"Print failed: {error}")
        finally:
            self.print_button.configure(state="normal")

    # -------------------------------------------------------------------------
    # answers
    # -------------------------------------------------------------------------
    def _next_step(self) -> None:
        if self._mm + TEAR_CALIBRATION_STEP_MM > MAX_TEAR_GAP_MM:
            self._set_status(f"Reached the {MAX_TEAR_GAP_MM}mm limit")
            return

        self._mm += TEAR_CALIBRATION_STEP_MM
        self.yes_button.configure(state="disabled")
        self.no_button.configure(state="disabled")
        self._refresh()
        self._print_sample()

    def _accept(self) -> None:
        set_tear_gap_mm(self._mm)
        self._accepted = self._mm
        self._set_status(
            f"Saved {self._mm:g}mm for profile {get_profile_name()}"
        )
        self.after(600, self._close)

    @property
    def accepted_mm(self) -> Optional[float]:
        return self._accepted
