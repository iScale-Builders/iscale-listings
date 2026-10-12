"""Shared validation for official trademark source freshness dates."""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from pathlib import Path
import hashlib


def normalize_official_source_date(value: str, field_name: str = "source_updated_at") -> str:
    """Return a normalized ISO date/datetime or raise ValueError.

    The app uses this value as source freshness evidence, so placeholders,
    malformed dates, and future dates must not be accepted.
    """

    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")

    try:
        if len(normalized) == 10:
            parsed_date = date.fromisoformat(normalized)
            parsed = datetime.combine(parsed_date, time.min, tzinfo=UTC)
            output = normalized
        else:
            parse_candidate = normalized[:-1] + "+00:00" if normalized.endswith("Z") else normalized
            parsed = datetime.fromisoformat(parse_candidate)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            parsed = parsed.astimezone(UTC)
            output = parsed.isoformat(timespec="seconds").replace("+00:00", "Z")
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an ISO date or datetime") from exc

    if parsed > datetime.now(UTC):
        raise ValueError(f"{field_name} must not be in the future")
    return output


def require_existing_source_path(path: Path, label: str = "source path") -> Path:
    if not path.exists():
        raise ValueError(f"{label} not found: {path}")
    return path


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
