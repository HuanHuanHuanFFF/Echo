"""Read-only PostgreSQL to Weaviate completeness audit for pinned Dify."""
import hashlib
import json
import math
import os
import sys
import sqlite3
import struct
import urllib.parse
import psycopg2
import requests

dataset_id, kind = sys.argv[1:3]
fingerprint = sys.argv[3] if len(sys.argv) > 3 else None
cache_path = sys.argv[4] if len(sys.argv) > 4 else "/audit-cache/vectors.sqlite"
cache = sqlite3.connect("file:" + cache_path + "?mode=ro&immutable=1", uri=True) if fingerprint else None
contract_path = sys.argv[5] if len(sys.argv) > 5 else None
contract = {}
if contract_path:
    with open(contract_path, encoding="utf-8") as handle:
        for line in handle:
            item = json.loads(line)
            assert item["segment_id"] not in contract, "Duplicate contract segment"
            contract[item["segment_id"]] = item["text_sha256"]
matched_source_segments = 0
matched_model_vectors = 0
max_vector_delta = 0
assert kind in {"hierarchical", "fixed"}
connection = psycopg2.connect(
    host=os.environ["DB_HOST"], port=os.getenv("DB_PORT", "5432"),
    user=os.environ["DB_USERNAME"], password=os.environ["DB_PASSWORD"],
    dbname=os.environ["DB_DATABASE"],
)
connection.set_session(readonly=True, autocommit=False)
cursor = connection.cursor()
cursor.execute("SELECT index_struct FROM datasets WHERE id=%s", (dataset_id,))
row = cursor.fetchone()
assert row, "Dataset missing"
structure = json.loads(row[0])
collection = structure["vector_store"]["class_prefix"]
table = "child_chunks" if kind == "hierarchical" else "document_segments"
cursor.execute("SELECT COUNT(*) FROM documents WHERE dataset_id=%s AND indexing_status <> 'completed'", (dataset_id,))
assert cursor.fetchone()[0] == 0, "Some documents are not completed"
expected = {}
stream = connection.cursor(name="readonly_vector_audit")
stream.itersize = 500
columns = "id, index_node_id, content, document_id, enabled, status" if kind == "fixed" else "id, index_node_id, content, document_id, TRUE, 'completed'"
stream.execute("SELECT " + columns + " FROM " + table + " WHERE dataset_id=%s", (dataset_id,))
for segment_id, native_id, text, document_id, enabled, status in stream:
    assert enabled and status == "completed", "Unavailable source segment"
    if contract_path:
        assert contract.get(str(segment_id)) == hashlib.sha256(text.encode()).hexdigest(), "Native source differs from frozen segment map"
        matched_source_segments += 1
    assert native_id and native_id not in expected, "Duplicate or absent native vector identity"
    expected[native_id] = (hashlib.sha256(text.encode()).hexdigest(), str(document_id))
stream.close()
assert expected, "Empty expected vector set"
if contract_path:
    assert matched_source_segments == len(contract), "Missing frozen source segments"
session = requests.Session()
key = os.getenv("WEAVIATE_API_KEY", "")
if key:
    session.headers["Authorization"] = "Bearer " + key
base = os.environ["WEAVIATE_ENDPOINT"].rstrip("/")
seen = set()
problems = []
after = None
count = 0
while True:
    params = {"class": collection, "limit": 500, "include": "vector"}
    if after:
        params["after"] = after
    response = session.get(base + "/v1/objects", params=params, timeout=120)
    response.raise_for_status()
    objects = response.json().get("objects", [])
    if not objects:
        break
    for item in objects:
        props = item.get("properties", {})
        native_id = props.get("doc_id")
        issue = []
        if native_id not in expected:
            issue.append("unexpected-id")
        elif native_id in seen:
            issue.append("duplicate-id")
        else:
            sha, document_id = expected[native_id]
            if hashlib.sha256(props.get("text", "").encode()).hexdigest() != sha:
                issue.append("text-mismatch")
            if props.get("document_id") != document_id:
                issue.append("document-mismatch")
        vector = item.get("vector") or item.get("vectors", {}).get("default", [])
        if len(vector) != 1024 or not all(math.isfinite(x) for x in vector):
            issue.append("invalid-vector")
        elif abs(sum(x * x for x in vector) - 1) > 0.001:
            issue.append("nonunit-vector")
        if cache is not None:
            text = props.get("text", "")
            key = hashlib.sha256(json.dumps([fingerprint, text], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            cached = cache.execute("SELECT vector, vector_sha FROM vectors WHERE key=? AND input=?", (key, text)).fetchone()
            if not cached:
                issue.append("missing-bound-model-input")
            elif hashlib.sha256(cached[0]).hexdigest() != cached[1] or len(cached[0]) != 4096:
                issue.append("invalid-model-cache-vector")
            elif len(vector) == 1024:
                reference = struct.unpack("<1024f", cached[0])
                assert all(math.isfinite(x) for x in reference), "Invalid reference vector"
                assert abs(sum(x*x for x in reference)-1) < 0.001, "Nonunit reference vector"
                delta = max(abs(a-b) for a,b in zip(vector, reference))
                max_vector_delta = max(max_vector_delta, delta)
                if delta > 1e-6:
                    issue.append("differs-from-bound-model-vector")
                else:
                    matched_model_vectors += 1
        seen.add(native_id)
        count += 1
        if issue:
            problems.append({"native_id": native_id, "issues": issue})
    next_after = objects[-1]["id"]
    assert next_after != after, "Nonadvancing Weaviate cursor"
    after = next_after
connection.rollback()
connection.close()
missing = sorted(set(expected) - seen)
result = {
    "status": "verified" if not problems and not missing and count == len(expected) else "failed",
    "dataset_id": dataset_id, "kind": kind,
    "expected_vectors": len(expected), "actual_vectors": count,
    "missing": missing, "problems": problems,
    "dimensions": 1024, "text_sha256_matched": not problems,
    "source_segment_contract_matched": matched_source_segments,
    "model_cache_fingerprint": fingerprint, "matched_model_vectors": matched_model_vectors,
    "max_vector_delta": max_vector_delta,
}
print(json.dumps(result, separators=(",", ":")))
if result["status"] != "verified":
    sys.exit(1)
