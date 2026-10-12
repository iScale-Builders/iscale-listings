"""Back up, apply, cut over, or roll back the USPTO drawing-code repair.

This operates on a completed local stage built by
stage_uspto_drawing_reconciliation.py. Production mutations require both
--execute and the exact confirmation phrase. Backups are local SQLite files and
contain every pre-existing row that could be overwritten or removed, plus the
original matching function definitions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Iterable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from stage_uspto_drawing_reconciliation import (  # noqa: E402
    STAGE_COLUMNS,
    connect_state,
    get_meta,
    set_meta,
    stage_summary,
)


CONFIRMATION = "RECONCILE-USPTO-DRAWING-CODES"
NEW_TYPES = ("words and design", "stylized text")
BACKUP_COLUMNS = (
    "id",
    *STAGE_COLUMNS,
    "updated_at",
    "source_updated_at",
)


def log(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def serializable(value: object) -> object:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def connect_db():
    import psycopg2
    from backfill_direct import read_vault_creds

    dsn, _ = read_vault_creds()
    connection = psycopg2.connect(dsn, connect_timeout=25)
    connection.autocommit = False
    cursor = connection.cursor()
    cursor.execute("SET statement_timeout=0")
    connection.commit()
    return connection


def connect_backup(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS backup_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS preexisting_rows (
          id INTEGER PRIMARY KEY,
          jurisdiction TEXT NOT NULL,
          source TEXT NOT NULL,
          serial_number TEXT NOT NULL,
          registration_number TEXT,
          wordmark TEXT NOT NULL,
          wordmark_normalized TEXT NOT NULL,
          mark_drawing_type TEXT,
          status TEXT NOT NULL,
          status_code TEXT,
          filing_date TEXT,
          registration_date TEXT,
          owner_name TEXT,
          international_class TEXT,
          updated_at TEXT,
          source_updated_at TEXT
        );
        """
    )
    conn.commit()
    return conn


def set_backup_meta(conn: sqlite3.Connection, key: str, value: object) -> None:
    conn.execute(
        "INSERT INTO backup_meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def get_backup_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM backup_meta WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row else None


def stage_signature(state: sqlite3.Connection) -> dict:
    summary = stage_summary(state)
    if not summary["stage_complete"]:
        raise RuntimeError("local USPTO stage is not complete")
    signature = {
        "annual_cutoff": summary["annual_cutoff"],
        "daily_through": summary["daily_through"],
        "record_count": summary["record_count"],
        "max_row_id": summary["max_row_id"],
        "records_by_type": summary["records_by_type"],
    }
    encoded = json.dumps(signature, sort_keys=True, separators=(",", ":")).encode()
    signature["sha256"] = hashlib.sha256(encoded).hexdigest()
    return signature


def save_backup_rows(conn: sqlite3.Connection, rows: Iterable[tuple]) -> int:
    placeholders = ",".join("?" for _ in BACKUP_COLUMNS)
    sql = (
        f"INSERT OR IGNORE INTO preexisting_rows ({','.join(BACKUP_COLUMNS)}) "
        f"VALUES ({placeholders})"
    )
    payload = [tuple(serializable(value) for value in row) for row in rows]
    if payload:
        conn.executemany(sql, payload)
    return len(payload)


def assert_backup_matches_stage(state: sqlite3.Connection, backup: sqlite3.Connection) -> dict:
    signature = stage_signature(state)
    expected = get_backup_meta(backup, "stage_signature")
    if expected != signature["sha256"]:
        raise RuntimeError("backup does not match the completed local stage")
    if get_backup_meta(backup, "backup_complete") != "true":
        raise RuntimeError("backup is incomplete")
    return signature


def backup_production(state_path: Path, backup_path: Path, batch_size: int) -> dict:
    from psycopg2.extras import execute_values

    state = connect_state(state_path)
    backup = connect_backup(backup_path)
    db = connect_db()
    try:
        signature = stage_signature(state)
        existing_signature = get_backup_meta(backup, "stage_signature")
        if existing_signature and existing_signature != signature["sha256"]:
            raise RuntimeError("existing backup belongs to a different stage")
        set_backup_meta(backup, "stage_signature", signature["sha256"])
        set_backup_meta(backup, "stage_summary", json.dumps(signature, sort_keys=True))
        set_backup_meta(backup, "backup_complete", "false")
        backup.commit()

        cursor = db.cursor()
        cursor.execute(
            "SELECT count(*) FILTER (WHERE mark_drawing_type='text'), "
            "count(*) FILTER (WHERE mark_drawing_type = ANY(%s)) "
            "FROM public.trademarks WHERE jurisdiction='US'",
            (list(NEW_TYPES),),
        )
        legacy_text, initial_new_types = cursor.fetchone()
        set_backup_meta(backup, "initial_text_rows", int(legacy_text))
        set_backup_meta(backup, "initial_new_type_rows", int(initial_new_types))

        cursor.execute(
            f"SELECT {','.join(BACKUP_COLUMNS)} FROM public.trademarks "
            "WHERE jurisdiction='US' AND mark_drawing_type = ANY(%s)",
            (["text", *NEW_TYPES],),
        )
        save_backup_rows(backup, cursor.fetchall())

        cursor.execute(
            """
            SELECT proname, pg_get_function_identity_arguments(oid), pg_get_functiondef(oid)
            FROM pg_proc
            WHERE pronamespace='public'::regnamespace
              AND proname IN ('match_trademarks', 'match_trademarks_by_jurisdiction')
            ORDER BY proname, pg_get_function_identity_arguments(oid)
            """
        )
        functions = [
            {"name": row[0], "arguments": row[1], "definition": row[2]}
            for row in cursor.fetchall()
        ]
        set_backup_meta(backup, "function_definitions", json.dumps(functions))
        backup.commit()

        last_row_id = int(get_backup_meta(backup, "last_stage_row_id") or 0)
        while True:
            keys = state.execute(
                "SELECT row_id, serial_number, international_class "
                "FROM stage_records WHERE row_id>? ORDER BY row_id LIMIT ?",
                (last_row_id, batch_size),
            ).fetchall()
            if not keys:
                break
            values = [(row["serial_number"], row["international_class"]) for row in keys]
            query = (
                f"SELECT {','.join('t.' + column for column in BACKUP_COLUMNS)} "
                "FROM public.trademarks t "
                "JOIN (VALUES %s) AS k(serial_number, international_class) "
                "ON t.serial_number=k.serial_number "
                "AND t.international_class=k.international_class "
                "WHERE t.jurisdiction='US'"
            )
            matches = execute_values(cursor, query, values, template="(%s,%s)", fetch=True)
            save_backup_rows(backup, matches)
            last_row_id = int(keys[-1]["row_id"])
            set_backup_meta(backup, "last_stage_row_id", last_row_id)
            backup.commit()
            if last_row_id % (batch_size * 20) == 0:
                log(f"Backup scan reached stage row {last_row_id:,}")

        set_backup_meta(backup, "backup_complete", "true")
        set_backup_meta(backup, "completed_at", datetime.now(UTC).isoformat())
        backup.commit()
        saved = int(backup.execute("SELECT count(*) FROM preexisting_rows").fetchone()[0])
        return {
            "stage_signature": signature["sha256"],
            "stage_records": signature["record_count"],
            "preexisting_rows_saved": saved,
            "initial_text_rows": int(legacy_text),
            "initial_new_type_rows": int(initial_new_types),
            "function_overloads_saved": len(functions),
        }
    finally:
        db.close()
        backup.close()
        state.close()


def require_confirmation(execute: bool, confirmation: str | None) -> None:
    if not execute:
        raise RuntimeError("dry-run only; add --execute after reviewing the backup and stage")
    if confirmation != CONFIRMATION:
        raise RuntimeError(f"--confirm must exactly equal {CONFIRMATION}")


def reconciliation_marker(signature: dict) -> str:
    return f"USPTO drawing-code reconciliation {signature['sha256']}"


def analyze_trademarks(db) -> bool:
    try:
        db.autocommit = True
        cursor = db.cursor()
        cursor.execute("ANALYZE public.trademarks")
        return True
    except Exception as exc:
        log(f"WARNING: cutover committed but ANALYZE failed: {exc}")
        return False


def apply_stage(
    state_path: Path,
    backup_path: Path,
    batch_size: int,
    execute: bool,
    confirmation: str | None,
) -> dict:
    require_confirmation(execute, confirmation)
    from psycopg2.extras import execute_values

    state = connect_state(state_path)
    backup = connect_backup(backup_path)
    db = connect_db()
    started = time.time()
    try:
        signature = assert_backup_matches_stage(state, backup)
        operation = get_meta(state, "apply_stage_signature")
        if operation and operation != signature["sha256"]:
            raise RuntimeError("state database contains progress for a different apply operation")
        set_meta(state, "apply_stage_signature", signature["sha256"])
        state.commit()
        last_row_id = int(get_meta(state, "apply_last_row_id") or 0)
        update_columns = [
            column
            for column in STAGE_COLUMNS
            if column not in {"jurisdiction", "serial_number", "international_class"}
        ]
        assignments = ",".join(f"{column}=EXCLUDED.{column}" for column in update_columns)
        distinct = ",".join(f"trademarks.{column}" for column in update_columns)
        excluded = ",".join(f"EXCLUDED.{column}" for column in update_columns)
        sql = (
            f"INSERT INTO public.trademarks ({','.join(STAGE_COLUMNS)}) VALUES %s "
            "ON CONFLICT (jurisdiction, serial_number, international_class) DO UPDATE SET "
            f"{assignments}, updated_at=NOW() "
            f"WHERE ROW({distinct}) IS DISTINCT FROM ROW({excluded})"
        )
        applied = 0
        while True:
            rows = state.execute(
                f"SELECT row_id,{','.join(STAGE_COLUMNS)} FROM stage_records "
                "WHERE row_id>? ORDER BY row_id LIMIT ?",
                (last_row_id, batch_size),
            ).fetchall()
            if not rows:
                break
            values = [tuple(row[column] for column in STAGE_COLUMNS) for row in rows]
            cursor = db.cursor()
            execute_values(cursor, sql, values, page_size=batch_size)
            db.commit()
            last_row_id = int(rows[-1]["row_id"])
            applied += len(rows)
            set_meta(state, "apply_last_row_id", last_row_id)
            state.commit()
            if applied % (batch_size * 10) == 0:
                log(f"Applied {applied:,} rows this run; stage row {last_row_id:,}")
        set_meta(state, "apply_complete", "true")
        set_meta(state, "apply_completed_at", datetime.now(UTC).isoformat())
        state.commit()
        return {
            "stage_signature": signature["sha256"],
            "rows_processed_this_run": applied,
            "last_row_id": last_row_id,
            "duration_seconds": int(time.time() - started),
        }
    finally:
        db.close()
        backup.close()
        state.close()


def cutover(
    state_path: Path,
    backup_path: Path,
    migration_path: Path,
    execute: bool,
    confirmation: str | None,
) -> dict:
    require_confirmation(execute, confirmation)
    state = connect_state(state_path)
    backup = connect_backup(backup_path)
    db = connect_db()
    try:
        signature = assert_backup_matches_stage(state, backup)
        if get_meta(state, "apply_complete") != "true":
            raise RuntimeError("stage apply is not complete")
        marker = reconciliation_marker(signature)
        migration = migration_path.read_text(encoding="utf-8")
        if "DROP FUNCTION IF EXISTS public.match_trademarks(TEXT[], TEXT[])" not in migration:
            raise RuntimeError("cutover migration does not remove the legacy overload")

        cursor = db.cursor()
        cursor.execute(
            "SELECT live_mark_count FROM public.sync_metadata "
            "WHERE jurisdiction='US' AND error_message=%s "
            "ORDER BY created_at DESC LIMIT 1",
            (marker,),
        )
        committed = cursor.fetchone()
        if committed:
            db.commit()
            set_meta(state, "cutover_complete", "true")
            set_meta(state, "cutover_resumed_at", datetime.now(UTC).isoformat())
            state.commit()
            analyzed = analyze_trademarks(db)
            return {
                "already_committed": True,
                "live_us_rows": int(committed[0]),
                "migration": migration_path.name,
                "analyzed": analyzed,
            }
        cursor.execute(
            "SELECT count(*) FROM public.trademarks "
            "WHERE jurisdiction='US' AND mark_drawing_type = ANY(%s)",
            (list(NEW_TYPES),),
        )
        loaded_new_types = int(cursor.fetchone()[0])
        if loaded_new_types < int(signature["record_count"]):
            raise RuntimeError(
                f"database has {loaded_new_types} repaired rows; stage has {signature['record_count']}"
            )
        cursor.execute(
            "SELECT count(*) FROM public.trademarks "
            "WHERE jurisdiction='US' AND mark_drawing_type='text'"
        )
        current_text_rows = int(cursor.fetchone()[0])
        expected_text_rows = int(get_backup_meta(backup, "initial_text_rows") or -1)
        if current_text_rows != expected_text_rows:
            raise RuntimeError(
                f"legacy text population changed: backup={expected_text_rows}, current={current_text_rows}"
            )

        cursor.execute(
            "DELETE FROM public.trademarks "
            "WHERE jurisdiction='US' AND mark_drawing_type='text'"
        )
        deleted_text_rows = cursor.rowcount
        cursor.execute(migration)
        cursor.execute(
            "SELECT count(*) FROM public.trademarks WHERE jurisdiction='US' AND status='LIVE'"
        )
        live_count = int(cursor.fetchone()[0])
        cursor.execute(
            """
            INSERT INTO public.sync_metadata (
              sync_date, jurisdiction, source, source_updated_at,
              live_mark_count, marks_added, marks_updated, marks_status_changed,
              sync_duration_seconds, status, error_message
            ) VALUES (CURRENT_DATE, 'US', 'uspto', %s, %s, 0, 0, 0, 0,
                      'completed', %s)
            """,
            (
                signature["daily_through"],
                live_count,
                marker,
            ),
        )
        db.commit()

        set_meta(state, "cutover_complete", "true")
        set_meta(state, "cutover_completed_at", datetime.now(UTC).isoformat())
        state.commit()
        analyzed = analyze_trademarks(db)
        return {
            "already_committed": False,
            "loaded_new_type_rows": loaded_new_types,
            "deleted_legacy_text_rows": deleted_text_rows,
            "live_us_rows": live_count,
            "migration": migration_path.name,
            "analyzed": analyzed,
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
        backup.close()
        state.close()


def rollback(
    state_path: Path,
    backup_path: Path,
    batch_size: int,
    execute: bool,
    confirmation: str | None,
) -> dict:
    require_confirmation(execute, confirmation)
    from psycopg2.extras import execute_values

    state = connect_state(state_path)
    backup = connect_backup(backup_path)
    db = connect_db()
    try:
        signature = assert_backup_matches_stage(state, backup)
        functions = json.loads(get_backup_meta(backup, "function_definitions") or "[]")
        if not functions:
            raise RuntimeError("backup has no matching function definitions")
        cursor = db.cursor()
        cursor.execute(
            "DELETE FROM public.trademarks "
            "WHERE jurisdiction='US' AND mark_drawing_type = ANY(%s)",
            (list(NEW_TYPES),),
        )
        deleted_new_types = cursor.rowcount

        placeholders = ",".join("%s" for _ in BACKUP_COLUMNS)
        update_columns = [column for column in BACKUP_COLUMNS if column != "id"]
        assignments = ",".join(f"{column}=EXCLUDED.{column}" for column in update_columns)
        restore_sql = (
            f"INSERT INTO public.trademarks ({','.join(BACKUP_COLUMNS)}) VALUES %s "
            "ON CONFLICT (jurisdiction, serial_number, international_class) "
            f"DO UPDATE SET {assignments}"
        )
        restored = 0
        offset = 0
        while True:
            rows = backup.execute(
                f"SELECT {','.join(BACKUP_COLUMNS)} FROM preexisting_rows "
                "ORDER BY id LIMIT ? OFFSET ?",
                (batch_size, offset),
            ).fetchall()
            if not rows:
                break
            values = [tuple(row[column] for column in BACKUP_COLUMNS) for row in rows]
            execute_values(
                cursor,
                restore_sql,
                values,
                template=f"({placeholders})",
                page_size=batch_size,
            )
            restored += len(rows)
            offset += len(rows)

        for function in functions:
            cursor.execute(function["definition"])
        cursor.execute(
            "DELETE FROM public.sync_metadata "
            "WHERE jurisdiction='US' AND error_message=%s",
            (reconciliation_marker(signature),),
        )
        cursor.execute(
            "SELECT setval(pg_get_serial_sequence('public.trademarks','id'), "
            "GREATEST((SELECT max(id) FROM public.trademarks), 1), true)"
        )
        db.commit()
        set_meta(state, "apply_last_row_id", 0)
        set_meta(state, "apply_complete", "false")
        set_meta(state, "cutover_complete", "false")
        set_meta(state, "rollback_complete", "true")
        set_meta(state, "rollback_completed_at", datetime.now(UTC).isoformat())
        state.commit()
        return {
            "deleted_repaired_rows": deleted_new_types,
            "restored_preexisting_rows": restored,
            "restored_function_overloads": len(functions),
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
        backup.close()
        state.close()


def status(state_path: Path, backup_path: Path | None) -> dict:
    state = connect_state(state_path)
    try:
        result = stage_summary(state)
        result["apply_last_row_id"] = int(get_meta(state, "apply_last_row_id") or 0)
        result["apply_complete"] = get_meta(state, "apply_complete") == "true"
        result["cutover_complete"] = get_meta(state, "cutover_complete") == "true"
    finally:
        state.close()
    if backup_path:
        backup = connect_backup(backup_path)
        try:
            result["backup_complete"] = get_backup_meta(backup, "backup_complete") == "true"
            result["preexisting_rows_saved"] = int(
                backup.execute("SELECT count(*) FROM preexisting_rows").fetchone()[0]
            )
        finally:
            backup.close()
    return result


def mutation_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--state-db", type=Path, required=True)
    parser.add_argument("--backup-db", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    backup = subparsers.add_parser("backup", help="Export every row/functions needed to roll back")
    backup.add_argument("--state-db", type=Path, required=True)
    backup.add_argument("--backup-db", type=Path, required=True)
    backup.add_argument("--batch-size", type=int, default=2000)

    apply_parser = subparsers.add_parser("apply", help="Batch the staged records into production")
    mutation_arguments(apply_parser)
    apply_parser.add_argument("--batch-size", type=int, default=2000)

    cutover_parser = subparsers.add_parser("cutover", help="Remove bad rows and expose repaired types")
    mutation_arguments(cutover_parser)
    cutover_parser.add_argument(
        "--migration",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "supabase"
        / "migrations"
        / "009_remove_legacy_uspto_match_overload.sql",
    )

    rollback_parser = subparsers.add_parser("rollback", help="Restore the exact pre-operation state")
    mutation_arguments(rollback_parser)
    rollback_parser.add_argument("--batch-size", type=int, default=2000)

    status_parser = subparsers.add_parser("status", help="Print local operation state")
    status_parser.add_argument("--state-db", type=Path, required=True)
    status_parser.add_argument("--backup-db", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "backup":
        result = backup_production(args.state_db, args.backup_db, args.batch_size)
    elif args.command == "apply":
        result = apply_stage(
            args.state_db,
            args.backup_db,
            args.batch_size,
            args.execute,
            args.confirm,
        )
    elif args.command == "cutover":
        result = cutover(
            args.state_db,
            args.backup_db,
            args.migration,
            args.execute,
            args.confirm,
        )
    elif args.command == "rollback":
        result = rollback(
            args.state_db,
            args.backup_db,
            args.batch_size,
            args.execute,
            args.confirm,
        )
    else:
        result = status(args.state_db, args.backup_db)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
