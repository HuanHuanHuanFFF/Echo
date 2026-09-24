#!/usr/bin/env python3
"""Stream precomputed fixed units into native Khoj Entry rows.

The importer bypasses Khoj's content parser and embedding generation. It
accepts an explicit 1024-value embedding or looks up a document vector in a
read-only public vectors.sqlite cache using the frozen embedding-plan
fingerprint.

The input is deliberately read twice in apply mode. Pass one validates every
record, duplicate key, vector, and input SHA without retaining records. Pass
two inserts at most batch_size records at a time. This prevents a 100k-unit
fixed corpus from being materialized in memory and prevents late validation
errors from leaving a partially imported corpus.

Input JSONL fields:
  unit_id, source_id, file, optional heading, raw+compiled or text
  embedding, unless --vector-cache-db and --vector-cache-plan are supplied
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import struct
import sys
import uuid
from pathlib import Path
from typing import Any, Iterator


DEFAULT_DIMENSIONS = 1024
DEFAULT_MODEL_NAME = "default"
DEFAULT_USERNAME = "default"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate or stream-import parser-bypass units into Khoj Entry."
    )
    parser.add_argument("--input", required=True, help="Container path to UTF-8 JSONL fixed-unit input.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write rows. Without --apply the input is validated only and the database is not touched.",
    )
    parser.add_argument(
        "--username",
        default=os.getenv("KHOJ_COMPARISON_USERNAME", DEFAULT_USERNAME),
        help="KhojUser username to own the entries (default: default).",
    )
    parser.add_argument("--user-id", type=int, help="Use a numeric KhojUser primary key instead of --username.")
    parser.add_argument(
        "--model-name",
        default=os.getenv("KHOJ_COMPARISON_SEARCH_MODEL_NAME", DEFAULT_MODEL_NAME),
        help="SearchModelConfig.name (default: default).",
    )
    parser.add_argument(
        "--expected-dimensions",
        type=int,
        default=int(os.getenv("KHOJ_COMPARISON_EMBEDDING_DIMENSIONS", str(DEFAULT_DIMENSIONS))),
    )
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument(
        "--vector-cache-db",
        help="Read-only public vectors.sqlite used when records omit embedding.",
    )
    parser.add_argument(
        "--vector-cache-plan",
        help="Frozen embedding-plan.json paired with --vector-cache-db.",
    )
    parser.add_argument(
        "--receipt",
        help="Optional container path for a non-secret import receipt JSON. The parent directory must be writable.",
    )
    return parser.parse_args()


def required_string(record: dict[str, Any], key: str, line_no: int) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"line {line_no}: {key} must be a non-empty string")
    return value


def text_value(record: dict[str, Any], primary: str, fallback: str, line_no: int) -> str:
    value = record.get(primary)
    if value is None:
        value = record.get(fallback)
    if not isinstance(value, str) or not value:
        raise ValueError(f"line {line_no}: {primary} or {fallback} must be a non-empty string")
    return value


def parse_embedding(value: Any, line_no: int, expected_dimensions: int) -> list[float]:
    if not isinstance(value, list):
        raise ValueError(f"line {line_no}: embedding must be a JSON array")
    if len(value) != expected_dimensions:
        raise ValueError(
            f"line {line_no}: embedding has {len(value)} values; expected {expected_dimensions}"
        )
    vector: list[float] = []
    for index, item in enumerate(value):
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise ValueError(f"line {line_no}: embedding[{index}] is not numeric")
        number = float(item)
        if not math.isfinite(number):
            raise ValueError(f"line {line_no}: embedding[{index}] is not finite")
        vector.append(number)
    return vector


class VectorCache:
    """Read frozen document vectors without opening the cache for writes."""

    def __init__(self, database_path: Path, plan_path: Path, expected_dimensions: int):
        if not database_path.is_file():
            raise FileNotFoundError(f"Vector cache does not exist: {database_path}")
        if not plan_path.is_file():
            raise FileNotFoundError(f"Embedding plan does not exist: {plan_path}")

        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        self.fingerprint = plan.get("fingerprint")
        config = plan.get("config", {})
        if not isinstance(self.fingerprint, str) or not self.fingerprint:
            raise ValueError("Embedding plan has no fingerprint")
        if config.get("dimensions") != expected_dimensions:
            raise ValueError(
                f"Embedding plan dimensions {config.get('dimensions')!r} "
                f"do not match expected {expected_dimensions}"
            )

        uri = f"file:{database_path.as_posix()}?mode=ro"
        self.database = sqlite3.connect(uri, uri=True)
        self.expected_dimensions = expected_dimensions

    def get(self, text: str, line_no: int) -> list[float]:
        key_input = json.dumps(
            [self.fingerprint, "document", text],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        key = hashlib.sha256(key_input.encode("utf-8")).hexdigest()
        row = self.database.execute(
            "SELECT input, vector, vector_sha FROM entries "
            "WHERE key=? AND purpose='document'",
            (key,),
        ).fetchone()
        if row is None:
            raise ValueError(
                f"line {line_no}: frozen document vector is missing for cache key {key}"
            )
        if row[0] != text:
            raise ValueError(f"line {line_no}: vector cache input mismatch for key {key}")
        blob = bytes(row[1])
        expected_bytes = self.expected_dimensions * 4
        if len(blob) != expected_bytes:
            raise ValueError(
                f"line {line_no}: cached vector has {len(blob)} bytes; expected {expected_bytes}"
            )
        actual_sha = hashlib.sha256(blob).hexdigest()
        if actual_sha != row[2]:
            raise ValueError(f"line {line_no}: cached vector sha mismatch for key {key}")
        return list(struct.unpack(f"<{self.expected_dimensions}f", blob))

    def close(self) -> None:
        self.database.close()


def parse_corpus_id(record: dict[str, Any], source_id: str) -> uuid.UUID:
    supplied = record.get("corpus_id")
    if supplied is not None:
        try:
            return uuid.UUID(str(supplied))
        except (ValueError, AttributeError) as exc:
            raise ValueError(f"corpus_id must be a UUID: {supplied!r}") from exc
    return uuid.uuid5(uuid.NAMESPACE_URL, f"khoj-fixed-corpus:{source_id}")


def parse_record(
    value: Any,
    line_no: int,
    expected_dimensions: int,
    vector_cache: VectorCache | None,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"line {line_no}: each JSONL value must be an object")

    unit_id = required_string(value, "unit_id", line_no)
    source_id = required_string(value, "source_id", line_no)
    file_path = required_string(value, "file", line_no)
    heading = value.get("heading", "")
    if heading is None:
        heading = ""
    if not isinstance(heading, str):
        raise ValueError(f"line {line_no}: heading must be a string when present")
    if len(file_path) > 400:
        raise ValueError(f"line {line_no}: file exceeds Khoj's 400-character field")
    if len(heading) > 1000:
        raise ValueError(f"line {line_no}: heading exceeds Khoj's 1000-character field")

    raw = text_value(value, "raw", "text", line_no)
    compiled = text_value(value, "compiled", "text", line_no)
    if value.get("embedding") is None:
        if vector_cache is None:
            raise ValueError(
                f"line {line_no}: embedding is absent and no read-only vector cache was supplied"
            )
        vector = vector_cache.get(compiled, line_no)
    else:
        vector = parse_embedding(value["embedding"], line_no, expected_dimensions)

    corpus_id = parse_corpus_id(value, source_id)
    hashed_value = hashlib.md5(
        f"{source_id}\x00{unit_id}\x00{compiled}".encode("utf-8")
    ).hexdigest()
    file_name = value.get("file_name")
    if file_name is None:
        file_name = file_path.replace("\\", "/").rsplit("/", 1)[-1]
    if not isinstance(file_name, str) or len(file_name) > 400:
        raise ValueError(f"line {line_no}: file_name must be a string of at most 400 characters")

    return {
        "unit_id": unit_id,
        "source_id": source_id,
        "file_path": file_path,
        "file_name": file_name,
        "heading": heading,
        "raw": raw,
        "compiled": compiled,
        "embedding": vector,
        "corpus_id": corpus_id,
        "hashed_value": hashed_value,
        "line_no": line_no,
    }


def iter_records(
    path: Path,
    expected_dimensions: int,
    vector_cache: VectorCache | None,
    state: dict[str, Any],
) -> Iterator[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(f"Input JSONL does not exist: {path}")

    seen_unit_ids: set[str] = set()
    seen_hashes: set[str] = set()
    with path.open("rb") as raw_stream:
        for line_no, raw_line in enumerate(raw_stream, start=1):
            state["digest"].update(raw_line)
            line = raw_line.decode("utf-8")
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"line {line_no}: invalid JSON: {exc.msg}") from exc
            record = parse_record(value, line_no, expected_dimensions, vector_cache)
            if record["unit_id"] in seen_unit_ids:
                raise ValueError(f"line {line_no}: duplicate unit_id {record['unit_id']!r}")
            seen_unit_ids.add(record["unit_id"])
            if record["hashed_value"] in seen_hashes:
                raise ValueError(f"line {line_no}: duplicate source/unit/compiled hash")
            seen_hashes.add(record["hashed_value"])
            state["records"] += 1
            yield record


def stream_validation(
    input_path: Path,
    expected_dimensions: int,
    vector_cache: VectorCache | None,
) -> tuple[int, str]:
    state: dict[str, Any] = {"digest": hashlib.sha256(), "records": 0}
    for _ in iter_records(input_path, expected_dimensions, vector_cache, state):
        pass
    return state["records"], state["digest"].hexdigest()


def setup_django() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "khoj.app.settings")
    import django

    django.setup()


def write_receipt(
    receipt_path: Path,
    input_path: Path,
    input_sha256: str,
    records_validated: int,
    dimensions: int,
    model_name: str,
    inserted: int,
    skipped_existing: int,
    username: str,
    batch_size: int,
    vector_cache_db: str | None,
) -> None:
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "mode": "parser-bypass-native-entry",
        "input": str(input_path),
        "input_sha256": input_sha256,
        "records_validated": records_validated,
        "inserted": inserted,
        "skipped_existing": skipped_existing,
        "username": username,
        "batch_size": batch_size,
        "batch_size_limit": 500,
        "expected_dimensions": dimensions,
        "search_model_name": model_name,
        "vector_cache_db": vector_cache_db,
        "embedding_api_called": False,
        "line_spans_persisted": False,
        "streaming_batches": True,
    }
    receipt_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def insert_stream(
    input_path: Path,
    expected_dimensions: int,
    vector_cache: VectorCache | None,
    user: Any,
    search_model: Any,
    batch_size: int,
) -> tuple[int, int, int, str]:
    from django.db import transaction
    from khoj.database.models import Entry

    state: dict[str, Any] = {"digest": hashlib.sha256(), "records": 0}
    batch: list[dict[str, Any]] = []
    inserted = 0
    skipped_existing = 0

    def flush(records: list[dict[str, Any]]) -> None:
        nonlocal inserted, skipped_existing
        if not records:
            return
        hashes = [record["hashed_value"] for record in records]
        existing_hashes = set(
            Entry.objects.filter(
                user=user,
                file_type=Entry.EntryType.PLAINTEXT,
                hashed_value__in=hashes,
            ).values_list("hashed_value", flat=True)
        )
        to_insert = [record for record in records if record["hashed_value"] not in existing_hashes]
        entries = [
            Entry(
                user=user,
                embeddings=record["embedding"],
                raw=record["raw"],
                compiled=record["compiled"],
                heading=record["heading"],
                file_source=Entry.EntrySource.COMPUTER,
                file_type=Entry.EntryType.PLAINTEXT,
                file_path=record["file_path"],
                file_name=record["file_name"],
                hashed_value=record["hashed_value"],
                corpus_id=record["corpus_id"],
                search_model=search_model,
            )
            for record in to_insert
        ]
        with transaction.atomic():
            Entry.objects.bulk_create(entries, batch_size=batch_size)
        inserted += len(entries)
        skipped_existing += len(records) - len(entries)

    for record in iter_records(input_path, expected_dimensions, vector_cache, state):
        batch.append(record)
        if len(batch) >= batch_size:
            flush(batch)
            batch = []
    flush(batch)
    return state["records"], inserted, skipped_existing, state["digest"].hexdigest()


def main() -> int:
    args = parse_args()
    if args.expected_dimensions <= 0:
        raise ValueError("--expected-dimensions must be positive")
    if args.batch_size <= 0 or args.batch_size > 500:
        raise ValueError("--batch-size must be between 1 and 500")
    if bool(args.vector_cache_db) != bool(args.vector_cache_plan):
        raise ValueError("--vector-cache-db and --vector-cache-plan must be supplied together")

    input_path = Path(args.input)
    vector_cache = None
    try:
        if args.vector_cache_db:
            vector_cache = VectorCache(
                Path(args.vector_cache_db),
                Path(args.vector_cache_plan),
                args.expected_dimensions,
            )
        records_validated, input_sha256 = stream_validation(
            input_path,
            args.expected_dimensions,
            vector_cache,
        )

        if not args.apply:
            print(
                f"validated parser-bypass input: records={records_validated} "
                f"dimensions={args.expected_dimensions} sha256={input_sha256} "
                f"vector_cache={bool(args.vector_cache_db)} database_write=false streaming=true"
            )
            return 0

        setup_django()
        from khoj.database.models import KhojUser, SearchModelConfig

        if args.user_id is not None:
            user = KhojUser.objects.get(pk=args.user_id)
        else:
            user = KhojUser.objects.get(username=args.username)
        search_model = SearchModelConfig.objects.get(name=args.model_name)

        records_second, inserted, skipped_existing, second_sha256 = insert_stream(
            input_path,
            args.expected_dimensions,
            vector_cache,
            user,
            search_model,
            args.batch_size,
        )
        if records_second != records_validated or second_sha256 != input_sha256:
            raise ValueError("input changed between validation and insertion passes")

        if args.receipt:
            write_receipt(
                Path(args.receipt),
                input_path,
                input_sha256,
                records_validated,
                args.expected_dimensions,
                args.model_name,
                inserted,
                skipped_existing,
                user.username,
                args.batch_size,
                args.vector_cache_db,
            )
        print(
            f"imported parser-bypass entries: validated={records_validated} inserted={inserted} "
            f"skipped_existing={skipped_existing} dimensions={args.expected_dimensions} "
            f"vector_cache={bool(args.vector_cache_db)} embedding_api_called=false streaming=true"
        )
        return 0
    finally:
        if vector_cache is not None:
            vector_cache.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise
