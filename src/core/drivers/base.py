# what every printer language has to answer
#
# Three questions, in the order a job asks them. A driver that can answer these
# can print a page, and nothing above this cares which language it speaks.

from typing import Iterator

from PIL import Image


class Driver:
    """A printer language, as far as printing a bitmap is concerned."""

    name = "driver"

    def prologue(self) -> bytes:
        """Whatever puts the printer in a state where a page can be sent."""
        return b""

    def bands(self, image: Image.Image) -> Iterator[bytes]:
        """The picture, as complete commands the printer can finish one by one.

        A band is a whole command rather than a slice of one, so a printer that
        cannot keep up stalls between commands instead of losing the middle of
        a page.
        """
        raise NotImplementedError

    def epilogue(self, feed_dots: int = 0) -> bytes:
        """The feed to the tear bar, the cut, and anything the profile adds."""
        return b""
