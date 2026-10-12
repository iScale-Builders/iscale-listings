"""USPTO mark-drawing-code classification used by bulk trademark imports.

The labels follow the current USPTO TMEP drawing-code definitions. Only codes
whose records contain searchable literal wording belong in text screening.
"""

from __future__ import annotations


MARK_DRAWING_TYPES = {
    "1": "typeset",
    "2": "design only",
    "3": "words and design",
    "4": "standard character",
    "5": "stylized text",
    "6": "non-visual",
}

SCREENABLE_MARK_TYPES = frozenset(
    {
        "typeset",
        "words and design",
        "standard character",
        "stylized text",
    }
)


def classify_mark_drawing_code(code: str | None) -> str:
    """Return the canonical label for a USPTO mark drawing code."""

    return MARK_DRAWING_TYPES.get((code or "").strip(), "unknown")


def is_screenable_mark_drawing_code(code: str | None) -> bool:
    """Return whether a USPTO record contains searchable literal wording."""

    return classify_mark_drawing_code(code) in SCREENABLE_MARK_TYPES
