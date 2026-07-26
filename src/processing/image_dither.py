# turning grey into ink or nothing
#
# A thermal head has one colour, so every tone in a picture has to be resolved
# into a dot or no dot before it can be printed. Which algorithm does that is a
# matter of taste and of subject: a hard threshold is right for line art and
# ruinous for a face, error diffusion is the opposite, and Atkinson sits in
# between while leaving noticeably less ink on the paper.
#
# ImageProcessor already implements all of them for the desktop app's image
# tab; this is the thin seam that lets the markdown renderer use the same code
# rather than owning a second copy of it.

from PIL import Image

from ..config.defaults import DITHER_MODES
from .image_processor import ImageProcessor

# what each one is good for, shown in the picker rather than kept as folklore
DITHER_LABELS = {
    "none": "Threshold (line art, text, logos)",
    "floyd-steinberg": "Floyd-Steinberg (photographs)",
    "ordered": "Ordered (even, visibly patterned)",
    "atkinson": "Atkinson (soft, uses less ink)",
    "burkes": "Burkes (sharper than Floyd-Steinberg)",
    "sierra": "Sierra (smooth gradients)",
    "stucki": "Stucki (finest detail, slowest)",
}


def dither_image(image: Image.Image, mode: str = "floyd-steinberg") -> Image.Image:
    """Reduce an image to one bit using the named algorithm."""
    if mode not in DITHER_MODES:
        mode = "floyd-steinberg"
    processor = ImageProcessor(auto_resize=False, dither_mode=mode)
    return processor._apply_dithering(image.convert("L"))
