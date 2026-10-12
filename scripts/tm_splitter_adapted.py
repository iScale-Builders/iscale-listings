"""
Adapted from USPTO/TrademarkPublicData XML splitter.

Reads bulk USPTO trademark XML files, extracts text-based marks,
applies normalization, and inserts into Supabase PostgreSQL.

CRITICAL: normalize_text() must produce identical output to
lib/trademark/normalize.ts. Both are tested against the same
tests/fixtures/normalization-vectors.json.
"""

import sys
import os
from typing import Any, Optional

from text_normalize import normalize_text
from uspto_mark_types import SCREENABLE_MARK_TYPES, classify_mark_drawing_code


# USPTO status codes in the 600-899 ("application"/"registration") range that
# actually mean the mark is DEAD (abandoned / cancelled). The rest of 600-899 is
# live (pending or active registration). Source: USPTO "Information on Trademark
# Status Line" (cons181.htm). We only enumerate the *dead* codes and default the
# rest to LIVE so an unknown/ambiguous code over-flags (safe for screening)
# rather than hiding a possibly-live mark.
#   600-609  Abandoned (incomplete/express/failure-to-respond/after-appeal/
#            after-decision/after-publication/no-SOU/defective-SOU/after-petition/
#            defective-divided)
#   614      Abandoned - Petition to revive denied
#   618      Abandoned File - Backfile
#   622      Misassigned serial number (administrative dead record)
#   626      Registered - Backfile cancelled or expired
#   690      Notice of Allowance - Cancelled
#   710-714  Cancelled (Section 8 / 7(d) / court order §37 / §18 / §24)
#   716      Inadvertently issued registration number - Cancelled
#   763      Ex parte appeal - Refusal affirmed
#   764      Ex parte appeal dismissed as moot
#   766      Concurrent use proceeding terminated - Denied
#   779      Opposition sustained
DEAD_STATUS_CODES_600_899 = {
    600, 601, 602, 603, 604, 605, 606, 607, 608, 609,
    614, 618, 622, 626, 690,
    710, 711, 712, 713, 714, 716,
    763, 764, 766, 779,
}


def derive_status(status_code: str) -> str:
    """Map a USPTO numeric status code to LIVE / DEAD.

    Codes below 600 or at/above 900 are dead (IR transformation / expired /
    administrative). Within 600-899 a mark is live unless its code is a known
    abandoned/cancelled code (DEAD_STATUS_CODES_600_899)."""
    try:
        code = int(status_code)
    except (ValueError, TypeError):
        return "DEAD"
    if code < 600 or code >= 900:
        return "DEAD"
    if code in DEAD_STATUS_CODES_600_899:
        return "DEAD"
    return "LIVE"


def extract_trademark(case_file: Any) -> Optional[list[dict]]:
    """
    Extract trademark records from a case-file XML element.
    Returns one record per international class (multi-class filings
    produce multiple records).

    Field mapping based on jlroo/uspto patterns:
    - mark_identification -> wordmark
    - serial-number -> serial_number
    - registration-number -> registration_number
    - mark-drawing-code -> mark_drawing_type (mapped)
    - status-code -> status_code
    - case-file-header/filing-date -> filing_date
    - case-file-header/registration-date -> registration_date
    - case-file-owners/case-file-owner/party-name -> owner_name
    - classifications/classification/international-code -> international_class
    """
    header = case_file.find(".//case-file-header")
    if header is None:
        return None

    # Extract mark text
    mark_el = header.find("mark-identification")
    if mark_el is None or not mark_el.text or not mark_el.text.strip():
        return None

    wordmark = mark_el.text.strip()

    # Extract and map mark drawing type
    drawing_code_el = header.find("mark-drawing-code")
    drawing_code = drawing_code_el.text.strip() if drawing_code_el is not None and drawing_code_el.text else ""

    mark_drawing_type = classify_mark_drawing_code(drawing_code)

    # Include every drawing type with searchable literal wording. Design-only
    # and non-visual marks cannot be screened by exact text matching.
    if mark_drawing_type not in SCREENABLE_MARK_TYPES:
        return None

    # Extract serial number (direct child of case-file, NOT in header)
    serial_el = case_file.find("serial-number")
    if serial_el is None or not serial_el.text:
        return None
    serial_number = serial_el.text.strip()

    # Extract registration number (direct child of case-file, NOT in header)
    reg_el = case_file.find("registration-number")
    registration_number = reg_el.text.strip() if reg_el is not None and reg_el.text else None

    # Extract status
    status_code_el = header.find("status-code")
    status_code = status_code_el.text.strip() if status_code_el is not None and status_code_el.text else ""

    # Map status code to LIVE/DEAD (abandoned/cancelled codes in 600-899 are
    # DEAD even though they fall in the "live" numeric range — see derive_status).
    status = derive_status(status_code)

    # Extract dates (USPTO uses YYYYMMDD format, convert to YYYY-MM-DD for PostgreSQL)
    filing_date_el = header.find("filing-date")
    filing_date = None
    if filing_date_el is not None and filing_date_el.text:
        d = filing_date_el.text.strip()
        if len(d) == 8 and d.isdigit():
            filing_date = f"{d[:4]}-{d[4:6]}-{d[6:8]}"

    reg_date_el = header.find("registration-date")
    registration_date = None
    if reg_date_el is not None and reg_date_el.text:
        d = reg_date_el.text.strip()
        if len(d) == 8 and d.isdigit():
            registration_date = f"{d[:4]}-{d[4:6]}-{d[6:8]}"

    # Extract owner
    owner_el = case_file.find(".//case-file-owners/case-file-owner/party-name")
    owner_name = owner_el.text.strip() if owner_el is not None and owner_el.text else None

    # Extract ALL international classes (multi-class filings)
    classes = set()
    for class_el in case_file.findall(".//classifications/classification/international-code"):
        if class_el.text and class_el.text.strip():
            classes.add(class_el.text.strip().zfill(3))
    # Fallback: check header for single-class filings
    if not classes:
        class_el = case_file.find(".//case-file-header/international-code")
        if class_el is not None and class_el.text and class_el.text.strip():
            classes.add(class_el.text.strip().zfill(3))

    if not classes:
        return None

    # Normalize wordmark
    wordmark_normalized = normalize_text(wordmark)

    # Return one record per class
    base = {
        "jurisdiction": "US",
        "source": "uspto",
        "serial_number": serial_number,
        "registration_number": registration_number,
        "wordmark": wordmark,
        "wordmark_normalized": wordmark_normalized,
        "mark_drawing_type": mark_drawing_type,
        "status": status,
        "status_code": status_code,
        "filing_date": filing_date,
        "registration_date": registration_date,
        "owner_name": owner_name,
    }

    return [{**base, "international_class": c} for c in sorted(classes)]


def process_xml_file(
    xml_path: str,
    conn,
    batch_size: int = 1000,
) -> dict:
    """
    Process a USPTO bulk XML file and insert records into PostgreSQL.
    Uses a streaming parser for memory efficiency.

    Returns counts of processed, inserted, and skipped records.
    """
    import psycopg2.extras
    from lxml import etree

    cursor = conn.cursor()
    stats = {"processed": 0, "inserted": 0, "skipped": 0, "errors": 0}
    batch = []

    insert_sql = """
        INSERT INTO trademarks (
            jurisdiction, source, serial_number, registration_number, wordmark, wordmark_normalized,
            mark_drawing_type, status, status_code, filing_date, registration_date,
            owner_name, international_class, updated_at
        ) VALUES %s
        ON CONFLICT (jurisdiction, serial_number, international_class) DO UPDATE SET
            source = EXCLUDED.source,
            registration_number = EXCLUDED.registration_number,
            wordmark = EXCLUDED.wordmark,
            wordmark_normalized = EXCLUDED.wordmark_normalized,
            mark_drawing_type = EXCLUDED.mark_drawing_type,
            status = EXCLUDED.status,
            status_code = EXCLUDED.status_code,
            filing_date = EXCLUDED.filing_date,
            registration_date = EXCLUDED.registration_date,
            owner_name = EXCLUDED.owner_name,
            updated_at = NOW()
    """

    # Stream-parse the XML file
    context = etree.iterparse(xml_path, events=("end",), tag="case-file")

    for event, elem in context:
        stats["processed"] += 1

        try:
            records = extract_trademark(elem)
            if records is None:
                stats["skipped"] += 1
            else:
                for record in records:
                    batch.append((
                        record["jurisdiction"],
                        record["source"],
                        record["serial_number"],
                        record["registration_number"],
                        record["wordmark"],
                        record["wordmark_normalized"],
                        record["mark_drawing_type"],
                        record["status"],
                        record["status_code"],
                        record["filing_date"],
                        record["registration_date"],
                        record["owner_name"],
                        record["international_class"],
                    ))

                if len(batch) >= batch_size:
                    # Use execute_values for fast batch insert
                    template = "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())"
                    psycopg2.extras.execute_values(
                        cursor, insert_sql, batch, template=template, page_size=batch_size
                    )
                    conn.commit()
                    stats["inserted"] += len(batch)
                    batch = []

                    if stats["inserted"] % 10000 == 0:
                        print(f"  Inserted {stats['inserted']} records...")

        except Exception as e:
            stats["errors"] += 1
            if stats["errors"] <= 10:
                print(f"  Error processing record: {e}", file=sys.stderr)

        # Clear element to free memory
        elem.clear()
        while elem.getprevious() is not None:
            del elem.getparent()[0]

    # Insert remaining batch
    if batch:
        template = "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())"
        import psycopg2.extras
        psycopg2.extras.execute_values(
            cursor, insert_sql, batch, template=template, page_size=batch_size
        )
        conn.commit()
        stats["inserted"] += len(batch)

    cursor.close()
    return stats


if __name__ == "__main__":
    # Quick test of normalization parity
    import json

    vectors_path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "tests",
        "fixtures",
        "normalization-vectors.json",
    )

    if os.path.exists(vectors_path):
        with open(vectors_path) as f:
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
    else:
        print(f"Vectors file not found at {vectors_path}")
