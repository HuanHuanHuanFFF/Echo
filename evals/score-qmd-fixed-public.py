import hashlib
import importlib.util
import json
import math
import pathlib
import statistics
import sys


scope, mode = sys.argv[1:3]
assert scope in {"langchain", "godot"}
assert mode in {"default", "no-rerank"}
comparison = pathlib.Path(sys.argv[3]).resolve()
public = pathlib.Path(sys.argv[4]).resolve()
qmd = pathlib.Path(sys.argv[5]).resolve()
sys.path.insert(0, str(public / "scoring-tools"))
import pyndeval
import pytrec_eval


def rows(file):
    with file.open(encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def sha(data):
    return hashlib.sha256(data).hexdigest()


manifest_file = comparison / "corpus-v1/manifest.json"
manifest_bytes = manifest_file.read_bytes()
manifest = json.loads(manifest_bytes)
preparation = json.loads((qmd / "public-preparation.json").read_text(encoding="utf-8"))
assert sha(manifest_bytes) == preparation["corpus_manifest_sha256"]
prepared = preparation["scopes"][scope]
query_file = public / "data" / f"freshstack-{scope}-queries.jsonl"
source_query_hash = manifest["scopes"][scope]["source_queries"]["sha256"]
assert sha(query_file.read_bytes()) == source_query_hash
questions = list(rows(query_file))
expected_order = [str(row["query_id"]) for row in questions]
expected_ids = sorted(expected_order)
assert len(expected_ids) == len(set(expected_ids))
assert len(expected_ids) == manifest["scopes"][scope]["questions"]

run_dir = qmd / "runs-public" / mode
run_file = run_dir / f"{scope}.jsonl"
freeze_file = run_dir / f"{scope}.freeze.json"
receipt_file = run_dir / f"{scope}.receipt.json"
receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
freeze = json.loads(freeze_file.read_text(encoding="utf-8"))
run_bytes = run_file.read_bytes()
assert receipt["status"] == "complete"
assert receipt["questions"] == len(expected_ids)
assert receipt["query_errors"] == sum(bool(row["native_error"]) for row in rows(run_file))
assert receipt["result_sha256"] == sha(run_bytes)
assert receipt["corpus_sha256"] == prepared["corpus_sha256"]
assert receipt["queries_sha256"] == prepared["queries_sha256"]
assert receipt["map_sha256"] == prepared["map_sha256"]
assert receipt["config_sha256"] == freeze["config_sha256"]
assert receipt["latency_ms"] == [row["latency_ms"] for row in rows(run_file)]

run_rows = list(rows(run_file))
assert [str(row["id"]) for row in run_rows] == expected_order
corpus_ids = {str(row["id"]) for row in rows(comparison / "corpus-v1" / f"{scope}-documents.jsonl")}
assert len(corpus_ids) == prepared["documents"]
run = {}
per_query = {}
for row in run_rows:
    ranking = row["rankings"]
    ids = [str(result["id"]) for result in ranking]
    assert len(ids) == len(set(ids))
    assert all(doc_id in corpus_ids for doc_id in ids)
    run[row["id"]] = {str(result["id"]): result["rank_score"] for result in ranking}
    per_query[row["id"]] = {
        "returned": len(ranking),
        "native_error": bool(row["native_error"]),
        "latency_ms": row["latency_ms"],
    }

qrels = {}
nuggets = {}
mapping = {}
for question in questions:
    qid = str(question["query_id"])
    mapping[qid] = []
    qrels[qid] = {}
    for nugget in question["nuggets"]:
        nid = str(nugget["_id"])
        mapping[qid].append(nid)
        relevance = {str(doc): 0 for doc in nugget["non_relevant_corpus_ids"]}
        relevance.update({str(doc): 1 for doc in nugget["relevant_corpus_ids"]})
        nuggets[nid] = relevance
        for doc, rel in relevance.items():
            qrels[qid][doc] = qrels[qid].get(doc, 0) + rel

evaluator = pytrec_eval.RelevanceEvaluator(
    qrels, {"ndcg_cut.10", "recall.10,50", "recip_rank"}
)
evaluated = evaluator.evaluate(run)
cut10 = {
    qid: dict(sorted(docs.items(), key=lambda item: item[1], reverse=True)[:10])
    for qid, docs in run.items()
}
rank10 = pytrec_eval.RelevanceEvaluator(qrels, {"recip_rank"}).evaluate(cut10)
raw = {
    qid: {
        name: evaluated.get(qid, {}).get(name, 0)
        for name in ("ndcg_cut_10", "recall_10", "recall_50", "recip_rank")
    }
    for qid in expected_ids
}
official_file = public / "reference/freshstack_metrics.py"
spec = importlib.util.spec_from_file_location("freshstack_official", official_file)
official = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(official)
# FreshStack alpha-nDCG skips queries when pyndeval returns no scores for an empty ranking.
# Exclude empty rankings from helper input; its denominator still includes all annotated queries, so failures score zero.
alpha_run = {qid: docs for qid, docs in run.items() if docs}
alpha = official.alpha_ndcg(nuggets, mapping, alpha_run, [10])
coverage = official.coverage(nuggets, mapping, run, [20])
recall = official.recall(qrels, run, [10, 50])
subtopic_qrels = [
    pyndeval.SubtopicQrel(qid, nid, doc, rel)
    for qid, nugget_ids in mapping.items()
    for nid in nugget_ids
    for doc, rel in nuggets[nid].items()
]
alpha_per_query = pyndeval.RelevanceEvaluator(
    subtopic_qrels, measures=["alpha-nDCG@10"]
).evaluate(
    [
        pyndeval.ScoredDoc(qid, doc, score)
        for qid, docs in run.items()
        for doc, score in sorted(docs.items(), key=lambda item: item[1], reverse=True)[:10]
    ]
)
for qid in expected_ids:
    top20 = set(
        doc
        for doc, _ in sorted(run[qid].items(), key=lambda item: item[1], reverse=True)[:20]
    )
    per_query[qid] = {
        **raw[qid],
        "alpha-nDCG@10": alpha_per_query.get(qid, {}).get("alpha-nDCG@10", 0),
        "Coverage@20": round(
            sum(
                bool(top20.intersection(doc for doc, rel in nuggets[nid].items() if rel > 0))
                for nid in mapping[qid]
            )
            / len(mapping[qid]),
            5,
        ),
        **per_query[qid],
    }
questions_n = len(expected_ids)
assert math.isclose(
    round(statistics.mean(per_query[qid]["alpha-nDCG@10"] for qid in expected_ids), 4),
    alpha["alpha-nDCG@10"],
    abs_tol=1e-10,
)
assert math.isclose(
    round(statistics.mean(per_query[qid]["Coverage@20"] for qid in expected_ids), 4),
    coverage["Coverage@20"],
    abs_tol=1e-10,
)
metrics = {
    "alpha_nDCG@10": alpha["alpha-nDCG@10"],
    "nDCG@10": statistics.mean(raw[qid]["ndcg_cut_10"] for qid in expected_ids),
    "Coverage@20": coverage["Coverage@20"],
    "Recall@10": statistics.mean(raw[qid]["recall_10"] for qid in expected_ids),
    "Recall@50": statistics.mean(raw[qid]["recall_50"] for qid in expected_ids),
    "official_recall@10": recall["Recall@10"],
    "official_recall@50": recall["Recall@50"],
    "MRR@10": statistics.mean(raw[qid]["recip_rank"] for qid in expected_ids),
    "Hit@10": sum(raw[qid]["recip_rank"] > 0 for qid in expected_ids) / questions_n,
    "query_errors": sum(item["native_error"] for item in per_query.values()),
    "mean_returned": statistics.mean(item["returned"] for item in per_query.values()),
    "mean_query_chars": statistics.mean(row["query_chars"] for row in run_rows),
    "latency_ms": {
        "mean": statistics.mean(row["latency_ms"] for row in run_rows),
        "p50": statistics.median(row["latency_ms"] for row in run_rows),
        "p95": sorted(row["latency_ms"] for row in run_rows)[math.ceil(0.95 * questions_n) - 1],
        "max": max(row["latency_ms"] for row in run_rows),
    },
}

score = {
    "schema": "echo-qmd-public-fixed-score-v1",
    "scope": scope,
    "mode": mode,
    "questions": questions_n,
    "documents": prepared["documents"],
    "corpus_manifest_sha256": preparation["corpus_manifest_sha256"],
    "corpus_sha256": prepared["corpus_sha256"],
    "queries_sha256": prepared["queries_sha256"],
    "result_sha256": receipt["result_sha256"],
    "official_scorer_sha256": sha(official_file.read_bytes()),
    "metrics": metrics,
    "per_question": per_query,
}
out = run_dir / f"{scope}.score.json"
out.write_text(json.dumps(score, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({k: v for k, v in score.items() if k != "per_question"}, ensure_ascii=False))
