# turning grey into ink or nothing
#
# A thermal head has one colour, so every tone in a picture has to be resolved
# into a dot or no dot before it can be printed. Which algorithm does that is a
# matter of taste and of subject: a hard threshold is right for line art and
# ruinous for a face, error diffusion is the opposite, and the diffusion
# kernels differ mainly in how far they push the error, and therefore in how
# much texture they leave behind and how much ink they lay down.
#
# ImageProcessor owns the error diffusion machinery for the desktop app's image
# tab. This module is the seam that lets the markdown renderer use it, and adds
# the kernels it did not carry. The extra maps are transcribed from
# dither-me-this (github.com/DitheringIdiot/dither-me-this), which states each
# one as offsets and factors over a common divisor; the same numbers appear in
# the original papers.

from typing import Dict, List, Tuple

from PIL import Image

from .image_processor import ImageProcessor

# (dx, dy, weight) over the divisor beside it
DIFFUSION_MAPS: Dict[str, Tuple[List[Tuple[int, int, int]], int]] = {
    "floyd-steinberg": ([
        (1, 0, 7),
        (-1, 1, 3), (0, 1, 5), (1, 1, 1),
    ], 16),
    "false-floyd-steinberg": ([
        (1, 0, 3),
        (0, 1, 3), (1, 1, 2),
    ], 8),
    "jarvis": ([
        (1, 0, 7), (2, 0, 5),
        (-2, 1, 3), (-1, 1, 5), (0, 1, 7), (1, 1, 5), (2, 1, 3),
        (-2, 2, 1), (-1, 2, 3), (0, 2, 5), (1, 2, 3), (2, 2, 1),
    ], 48),
    "stucki": ([
        (1, 0, 8), (2, 0, 4),
        (-2, 1, 2), (-1, 1, 4), (0, 1, 8), (1, 1, 4), (2, 1, 2),
        (-2, 2, 1), (-1, 2, 2), (0, 2, 4), (1, 2, 2), (2, 2, 1),
    ], 42),
    "burkes": ([
        (1, 0, 8), (2, 0, 4),
        (-2, 1, 2), (-1, 1, 4), (0, 1, 8), (1, 1, 4), (2, 1, 2),
    ], 32),
    "sierra": ([
        (1, 0, 5), (2, 0, 3),
        (-2, 1, 2), (-1, 1, 4), (0, 1, 5), (1, 1, 4), (2, 1, 2),
        (-1, 2, 2), (0, 2, 3), (1, 2, 2),
    ], 32),
    "sierra-two-row": ([
        (1, 0, 4), (2, 0, 3),
        (-2, 1, 1), (-1, 1, 2), (0, 1, 3), (1, 1, 2), (2, 1, 1),
    ], 16),
    "sierra-lite": ([
        (1, 0, 2),
        (-1, 1, 1), (0, 1, 1),
    ], 4),
    "atkinson": ([
        (1, 0, 1), (2, 0, 1),
        (-1, 1, 1), (0, 1, 1), (1, 1, 1),
        (0, 2, 1),
    ], 8),
}

# the order the picker offers them in: no diffusion, then coarse to fine
DITHER_MODES = [
    "none",
    "ordered",
    "sierra-lite",
    "false-floyd-steinberg",
    "floyd-steinberg",
    "burkes",
    "sierra-two-row",
    "sierra",
    "jarvis",
    "stucki",
    "atkinson",
]

# what each one is for, in the picker rather than kept as folklore
DITHER_LABELS = {
    "none": "Threshold (line art, text, logos)",
    "ordered": "Ordered (even, visibly patterned)",
    "sierra-lite": "Sierra lite (fast, grainy)",
    "false-floyd-steinberg": "False Floyd-Steinberg (coarser, faster)",
    "floyd-steinberg": "Floyd-Steinberg (photographs)",
    "burkes": "Burkes (sharper than Floyd-Steinberg)",
    "sierra-two-row": "Sierra two row (lighter than Sierra)",
    "sierra": "Sierra (smooth gradients)",
    "jarvis": "Jarvis-Judice-Ninke (smooth, wide spread)",
    "stucki": "Stucki (finest detail, slowest)",
    "atkinson": "Atkinson (soft, uses least ink)",
}


def dither_image(image: Image.Image, mode: str = "floyd-steinberg") -> Image.Image:
    """Reduce an image to one bit using the named algorithm."""
    grey = image.convert("L")
    processor = ImageProcessor(auto_resize=False)

    if mode == "none":
        return grey.point(lambda value: 255 if value > 127 else 0, "1")
    if mode == "ordered":
        return processor._ordered_dither(grey)

    matrix, divisor = DIFFUSION_MAPS.get(mode, DIFFUSION_MAPS["floyd-steinberg"])
    return processor._error_diffusion_dither(grey, matrix, divisor)
