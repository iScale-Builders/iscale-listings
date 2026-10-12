"""Refuse zip-slip when extracting USPTO/ST.66 members."""
from __future__ import annotations

from pathlib import Path
from zipfile import ZipFile


def extract_suffixed_members(archive: Path, dest: Path, suffix: str = ".xml") -> list[Path]:
    dest = dest.resolve()
    extracted: list[Path] = []
    with ZipFile(archive) as zf:
        for name in zf.namelist():
            if not name.lower().endswith(suffix):
                continue
            target = (dest / name).resolve()
            if not str(target).startswith(str(dest)):
                raise RuntimeError(f"Unsafe ZIP entry refused: {name}")
            zf.extract(name, dest)
            extracted.append(target)
    return extracted
