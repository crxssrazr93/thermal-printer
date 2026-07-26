# markdown input frame
#
# Reuses BaseTextFrame wholesale - font controls, live preview, gallery, print -
# and swaps only the renderer, so markdown gains every feature the text tab has
# without a parallel implementation.

from .base_text_frame import BaseTextFrame
from ...config.defaults import DEFAULT_LINE_SPACING
from ...config.keys import SettingsKeys
from ...processing.image_processor import ImageProcessor
from ...processing.markdown_renderer import MarkdownRenderer


class MarkdownFrame(BaseTextFrame):
    # markdown source in, rendered receipt out

    _settings_section = "text"
    _save_dialog_title = "Save Markdown Template"
    _print_status_message = "Sending markdown to printer..."
    _preview_landscape = False
    _renderer_wrap = True
    _templates_dir = "gallery/markdown"

    def _init_renderer(self) -> None:
        self._renderer = MarkdownRenderer(
            font_family=self.font_selector.get(),
            font_size=self.font_size_var.get(),
            line_spacing=self._settings.get(
                self._get_settings_keys().LINE_SPACING, DEFAULT_LINE_SPACING
            ),
        )
        self._image_processor = ImageProcessor(
            brightness=1.0,
            contrast=self.darkness_var.get(),
            auto_resize=False,
        )
