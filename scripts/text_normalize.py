"""
Canonical trademark text normalization, shared by every importer.

CRITICAL: normalize_text() must produce byte-identical output to
lib/trademark/normalize.ts. Both are tested against the same
tests/fixtures/normalization-vectors.json fixture. If you change one, change
the other and re-run the fixture in both languages.

Pure standard library (re + unicodedata) so importers can share it without
pulling in lxml or any importer-specific dependency.

Steps (applied in order):
 1. NFKD compatibility-decompose. Folds stylized glyphs POD sellers use as
    evasion - full-width, math-alphanumeric, ligatures - down to plain letters,
    and decomposes accents to base + combining mark. Done BEFORE lowercasing so
    case-mapping only ever runs on plain letters, keeping this byte-identical to
    the TS side (their case maps for exotic codepoints differ; for ASCII/Latin
    they agree).
 2. Lowercase.
 3. Drop Unicode "Mn" (nonspacing mark) characters. This FOLDS accents
    (cafe-with-accent -> cafe) instead of deleting the whole letter. The TS side
    strips the same set via /\\p{Mn}/gu.
 4. Fold the non-decomposing Latin letters NFKD cannot handle (see SPECIAL_FOLD).
 5. Strip apostrophes (' and U+2019)
 6. Hyphens to spaces
 7. Remove all non-alphanumeric except spaces
 8. Collapse whitespace
 9. Trim
"""

import re
import unicodedata

# Non-decomposing Latin letters NFD leaves intact. Ordered list; keep
# byte-identical to SPECIAL_FOLD in lib/trademark/normalize.ts. Values are
# ASCII and contain no keys, so order does not change the result, but the two
# implementations must stay in sync.
_SPECIAL_FOLD = (
    ("ß", "ss"),
    ("ø", "o"),
    ("æ", "ae"),
    ("œ", "oe"),
    ("ł", "l"),
    ("đ", "d"),
)

_APOSTROPHES = re.compile(r"['’]")
_NON_ALNUM = re.compile(r"[^a-z0-9\s]")
_WHITESPACE = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    # NFKD before lowercasing folds full-width / math / ligature glyphs to plain
    # letters (see module docstring) and keeps parity with the TS side.
    result = unicodedata.normalize("NFKD", text)
    result = result.lower()
    result = "".join(c for c in result if unicodedata.category(c) != "Mn")
    for src, dst in _SPECIAL_FOLD:
        result = result.replace(src, dst)
    result = _APOSTROPHES.sub("", result)
    result = result.replace("-", " ")
    result = _NON_ALNUM.sub(" ", result)
    result = _WHITESPACE.sub(" ", result)
    return result.strip()


def _run_parity_self_test() -> int:
    """Run normalize_text against the shared fixture. Returns process exit code."""
    import json
    import os

    vectors_path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "tests",
        "fixtures",
        "normalization-vectors.json",
    )
    if not os.path.exists(vectors_path):
        print(f"Vectors file not found at {vectors_path}")
        return 1

    with open(vectors_path, encoding="utf-8") as f:
        vectors = json.load(f)

    passed = 0
    failed = 0
    for v in vectors:
        result = normalize_text(v["input"])
        if result == v["expected"]:
            passed += 1
        else:
            failed += 1
            print(
                f"FAIL: normalize_text({v['input']!r}) = {result!r}, "
                f"expected {v['expected']!r}"
            )

    print(f"Normalization parity test: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_parity_self_test())
