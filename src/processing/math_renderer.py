# LaTeX math rendering
#
# Uses matplotlib's mathtext engine, which implements a large TeX math subset in
# pure Python - no TeX installation required. That tradeoff matters here: a real
# TeX toolchain is hundreds of megabytes and useless on a machine that only
# needs to print the occasional formula.
#
# matplotlib is optional. Without it the renderer reports unavailable and
# callers fall back to printing the raw source, which is still readable.

import io
import logging
from typing import Optional

from PIL import Image

logger = logging.getLogger(__name__)

_available: Optional[bool] = None
_MATH_DPI = 203          # match the print head so 1pt maps predictably
_MAX_WIDTH_RATIO = 0.95  # leave a little margin inside the paper


def is_available() -> bool:
    """True when matplotlib is importable, cached after the first check."""
    global _available
    if _available is None:
        try:
            import matplotlib  # noqa: F401
            _available = True
        except ImportError:
            _available = False
    return _available


def unavailable_reason() -> str:
    return (
        "LaTeX math needs matplotlib.\n\n"
        "Install it into the app's virtualenv:\n"
        "  .venv_print/bin/pip install matplotlib"
    )


def render_math(
    expression: str,
    font_size: int = 22,
    max_width: Optional[int] = None,
    bold: bool = False,
) -> Optional[Image.Image]:
    """Render a LaTeX math expression to a white-background image.

    Returns None when matplotlib is missing or the expression will not parse,
    so the caller can fall back to showing the source instead of failing.
    """
    if not is_available() or not expression.strip():
        return None

    try:
        import matplotlib
        matplotlib.use("Agg")
        from matplotlib import mathtext
        from matplotlib.font_manager import FontProperties
    except Exception as error:
        logger.warning("matplotlib unavailable at render time: %s", error)
        return None

    # mathtext wants the whole string wrapped in $...$
    body = expression.strip()
    if body.startswith("$") and body.endswith("$"):
        body = body.strip("$")
    if not body:
        return None

    try:
        parser = mathtext.MathTextParser("bitmap")
        properties = FontProperties(size=font_size,
                                    weight="bold" if bold else "normal")
        buffer = io.BytesIO()
        parser.to_png(buffer, f"${body}$", prop=properties, dpi=_MATH_DPI)
        buffer.seek(0)
        image = Image.open(buffer)
        image.load()
    except Exception as error:
        # invalid TeX is user input, not a crash
        logger.info("Could not render math %r: %s", expression, error)
        return None

    # mathtext emits RGBA with a transparent background; thermal output needs
    # white behind it or the alpha becomes solid black
    if image.mode in ("RGBA", "LA"):
        flattened = Image.new("RGB", image.size, "white")
        flattened.paste(image, mask=image.split()[-1])
        image = flattened
    else:
        image = image.convert("RGB")

    if max_width and image.width > max_width * _MAX_WIDTH_RATIO:
        target = int(max_width * _MAX_WIDTH_RATIO)
        ratio = target / image.width
        image = image.resize(
            (target, max(1, int(image.height * ratio))),
            Image.Resampling.LANCZOS
        )

    return image
