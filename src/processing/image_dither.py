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

import numpy as np
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


def _shift(grey: Image.Image, threshold: int) -> Image.Image:
    """Move the whole picture towards paper or towards ink.

    Simply moving the comparison point is close to useless under error
    diffusion, which hands whatever it took off one pixel to the next and so
    conserves the average tone almost exactly. What a cutoff control is
    expected to do, and what it does under a plain threshold, is decide how
    much of the picture ends up dark. So the setting is applied to the tones
    themselves before any screening, which behaves the same way for every
    method here.
    """
    offset = 128 - threshold
    if not offset:
        return grey
    return grey.point(lambda value: max(0, min(255, value + offset)))


def _diffuse(grey: Image.Image, matrix, divisor: int, strength: float) -> Image.Image:
    """Error diffusion with a settable amount.

    The amount decides how much of each pixel's error is handed to its
    neighbours. At zero it is a plain threshold; at one it is the algorithm as
    published. Between the two the texture thins out, which on paper reads as
    a harder, more posterised picture.
    """
    pixels = np.asarray(grey, dtype=np.float32).copy()
    height, width = pixels.shape
    weights = [(dx, dy, weight / divisor * strength) for dx, dy, weight in matrix]

    for y in range(height):
        for x in range(width):
            old = pixels[y, x]
            new = 255.0 if old > 128.0 else 0.0
            pixels[y, x] = new
            error = old - new
            if not error:
                continue
            for dx, dy, weight in weights:
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height:
                    pixels[ny, nx] += error * weight

    return Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8)).convert("1")


def dither_image(image: Image.Image, mode: str = "floyd-steinberg",
                 threshold: int = 128, strength: float = 1.0) -> Image.Image:
    """Reduce an image to one bit using the named algorithm."""
    threshold = max(0, min(255, int(threshold)))
    strength = max(0.0, min(1.0, float(strength)))
    grey = _shift(image.convert("L"), threshold)

    if mode == "none" or strength == 0:
        return grey.point(lambda value: 255 if value > 128 else 0, "1")
    if mode == "ordered":
        return ImageProcessor(auto_resize=False)._ordered_dither(grey)

    matrix, divisor = DIFFUSION_MAPS.get(mode, DIFFUSION_MAPS["floyd-steinberg"])
    if strength == 1.0:
        # the fast path in ImageProcessor, which is this same arithmetic
        return ImageProcessor(auto_resize=False)._error_diffusion_dither(grey, matrix, divisor)
    return _diffuse(grey, matrix, divisor, strength)
