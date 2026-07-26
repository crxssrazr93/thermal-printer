# text input and formatting frame for text printing
#
# The renderer is the markdown one rather than the plain text renderer. Plain
# text is valid markdown and passes through unchanged, so a single tab covers
# both cases: type prose and it prints as typed, add "# " or "**bold**" and it
# renders. There is no mode to pick and nothing to switch between.


from .base_text_frame import BaseTextFrame
from ...config.defaults import DEFAULT_LINE_SPACING
from ...processing.image_processor import ImageProcessor
from ...processing.markdown_renderer import MarkdownRenderer


class TextFrame(BaseTextFrame):
    # frame for text printing with markdown formatting and horizontal alignment

    _settings_section = "text"
    _save_dialog_title = "Save Text Template"
    _print_status_message = "Sending text to printer..."
    _preview_landscape = False
    _renderer_wrap = True

    def _init_renderer(self) -> None:
        self._renderer = MarkdownRenderer(
            font_family=self.font_selector.get(),
            font_size=self.font_size_var.get(),
            line_spacing=self._settings.get(
                self._get_settings_keys().LINE_SPACING, DEFAULT_LINE_SPACING
            ),
        )
        # auto_resize off: the renderer already lays out to the paper width
        self._image_processor = ImageProcessor(
            brightness=1.0,
            contrast=self.darkness_var.get(),
            auto_resize=False,
        )
