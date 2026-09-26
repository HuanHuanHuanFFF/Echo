import hashlib
import json
import pathlib
import sqlite3
import sys

scope = sys.argv[1]
assert scope in {"langchain", "godot"}
qmd = pathlib.Path(sys.argv[2]).resolve()
prep = json.loads((qmd / "public-preparation.json").read_text(encoding="utf-8"))
row = prep["scopes"][scope]
db_file = qmd / "cache" / "qmd" / f"{row['index_name']}.sqlite"
map_file = qmd / "public-data" / f"{scope}-map.jsonl"
data_dir = qmd / "public-data" / scope


def sha(data):
    return hashlib.sha256(data).hexdigest()


mapping = {}
with map_file.open(encoding="utf-8") as stream:
    for line in stream:
        if line.strip():
            item = json.loads(line)
            assert item["file"] not in mapping
            mapping[item["file"]] = item
assert len(mapping) == row["documents"]
assert sha(map_file.read_bytes()) == row["map_sha256"]

db = sqlite3.connect(f"file:{db_file.as_posix()}?mode=ro", uri=True, timeout=30)
db.row_factory = sqlite3.Row
documents = db.execute(
        """
        SELECT d.path, d.hash, c.doc
        FROM documents d JOIN content c ON c.hash = d.hash
        WHERE d.collection = ? AND d.active = 1
        ORDER BY d.path
        """,
        (scope,),
    )
seen = set()
document_count = 0
for item in documents:
    document_count += 1
    rel = item["path"].replace("\\", "/")
    assert rel in mapping and rel not in seen
    seen.add(rel)
    source = mapping[rel]
    text = (data_dir / rel).read_bytes().decode("utf-8")
    assert sha(text.encode("utf-8")) == source["text_sha256"]
    assert item["doc"] == text, f"QMD changed official unit contents: {rel}"
assert document_count == row["documents"]
assert seen == set(mapping)

coverage = db.execute(
    """
    SELECT COUNT(*) AS unique_hashes,
           SUM(CASE WHEN v.actual_chunks IS NULL OR v.actual_chunks = 0 THEN 1 ELSE 0 END) AS missing,
           SUM(CASE WHEN v.actual_chunks IS NULL OR v.actual_chunks <> v.expected_chunks THEN 1 ELSE 0 END) AS partial,
           SUM(v.actual_chunks) AS total_vectors
    FROM content c
    LEFT JOIN (
      SELECT hash, COUNT(*) AS actual_chunks, MAX(total_chunks) AS expected_chunks
      FROM content_vectors GROUP BY hash
    ) v ON v.hash = c.hash
    """
).fetchone()
assert coverage["missing"] == 0 and coverage["partial"] == 0
vector_models = [
    tuple(item)
    for item in db.execute(
        "SELECT model, COUNT(*) FROM content_vectors GROUP BY model ORDER BY model"
    )
]
model = json.loads((qmd / "download-manifest.json").read_text(encoding="utf-8"))["embedding_model"]
assert vector_models == [(model, coverage["total_vectors"])]
db.close()
receipt = {
    "schema": "echo-qmd-public-fixed-index-audit-v1",
    "scope": scope,
    "documents": document_count,
    "exact_texts": len(seen),
    "unique_content_hashes": coverage["unique_hashes"],
    "vector_chunks": coverage["total_vectors"],
    "missing_vector_hashes": coverage["missing"],
    "partial_vector_hashes": coverage["partial"],
    "vector_models": vector_models,
    "embedding_model": model,
    "corpus_manifest_sha256": prep["corpus_manifest_sha256"],
    "map_sha256": row["map_sha256"],
}
out = qmd / "runs-public" / f"{scope}.index-audit.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(json.dumps(receipt))
