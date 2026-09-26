"""Official per-dataset metrics for the frozen three-product comparison."""
import collections
import hashlib
import importlib.util
import json
import math
import pathlib
import statistics
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1]).resolve()
PUBLIC = pathlib.Path(sys.argv[2]).resolve()
CONDITION = sys.argv[3]
sys.path.insert(0, str(PUBLIC / "scoring-tools"))


def sha(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def rows(path):
    with pathlib.Path(path).open(encoding="utf8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


freeze = json.loads((ROOT / "freeze.json").read_text(encoding="utf8"))
assert freeze["status"] == "frozen"
assert sha(ROOT / "corpus-v1/manifest.json") == freeze["corpus_manifest_sha256"]
manifest = json.loads((ROOT / "corpus-v1/manifest.json").read_text(encoding="utf8"))
for binding in freeze["scoring_inputs"].values():
    assert sha(binding["path"]) == binding["sha256"], "Official scoring input changed"
subprocess.run(
    [
        "node",
        str(pathlib.Path(__file__).with_name("verify-product-run.mjs")),
        str(ROOT),
        CONDITION,
        "qasper,langchain,godot,du",
    ],
    check=True,
)
import pyndeval
import pytrec_eval

fresh = load_module("product_freshstack", PUBLIC / "reference/freshstack_metrics.py")
qasper = load_module("product_qasper", PUBLIC / "reference/qasper_evaluator.py")
target = ROOT / "scores" / CONDITION
target.mkdir(parents=True, exist_ok=True)
summary = {"condition": CONDITION, "status": "official-public-scored", "datasets": {}}
max_return = freeze["conditions"][CONDITION]["fixed_return_limit"]


pending_outputs = []


def write_new(file, value):
    # Queue serialized output; later datasets must also validate before publish.
    pending_outputs.append((file, json.dumps(value, ensure_ascii=False, indent=2) + "\n"))


for scope in ["langchain", "godot", "du"]:
    info = manifest["scopes"][scope]
    for key in ["corpus", "queries", "source_queries"]:
        assert sha(info[key]["path"]) == info[key]["sha256"]
    queries = rows(info["queries"]["path"])
    ids = [str(row["id"]) for row in queries]
    corpus = {str(row["id"]) for row in rows(info["corpus"]["path"])}
    output = rows(ROOT / "runs" / CONDITION / f"{scope}.jsonl")
    assert [str(row["id"]) for row in output] == ids
    assert len(set(ids)) == len(ids) == info["questions"]
    qrels = collections.defaultdict(dict)
    nuggets, mapping = {}, {}
    if scope == "du":
        for row in rows(PUBLIC / "data/du-qrels.jsonl"):
            qrels[str(row["qid"])][str(row["pid"])] = row["score"]
    else:
        for row in rows(info["source_queries"]["path"]):
            query_id = str(row["query_id"])
            mapping[query_id] = []
            for nugget in row["nuggets"]:
                nugget_id = nugget["_id"]
                mapping[query_id].append(nugget_id)
                values = {doc: 0 for doc in nugget["non_relevant_corpus_ids"]}
                values.update({doc: 1 for doc in nugget["relevant_corpus_ids"]})
                nuggets[nugget_id] = values
                for doc, relevance in values.items():
                    qrels[query_id][doc] = qrels[query_id].get(doc, 0) + relevance
    run = {}
    for row in output:
        rankings = row["rankings"]
        seen = [str(item["id"]) for item in rankings]
        assert len(seen) == len(set(seen)) and set(seen) <= corpus
        assert [item["rank"] for item in rankings] == list(range(1, len(rankings) + 1))
        assert all(math.isfinite(item["score"]) for item in rankings)
        run[str(row["id"])] = {doc: len(seen) - rank for rank, doc in enumerate(seen)}
    evaluated = pytrec_eval.RelevanceEvaluator(qrels, {"ndcg_cut.10", "recall.10,50"}).evaluate(run)
    cut = {query: dict(list(run[query].items())[:10]) for query in ids}
    reciprocal = pytrec_eval.RelevanceEvaluator(qrels, {"recip_rank"}).evaluate(cut)
    per_query = {
        query: {
            "nDCG@10": evaluated.get(query, {}).get("ndcg_cut_10", 0),
            "Recall@10": evaluated.get(query, {}).get("recall_10", 0),
            "MRR@10": reciprocal.get(query, {}).get("recip_rank", 0),
            "Hit@10": int(any(qrels[query].get(doc, 0) > 0 for doc in cut[query])),
        }
        for query in ids
    }
    if max_return >= 50:
        for query in ids:
            per_query[query]["Recall@50"] = evaluated.get(query, {}).get("recall_50", 0)
    if scope != "du":
        alpha = pyndeval.RelevanceEvaluator([
            pyndeval.SubtopicQrel(query, nugget, doc, relevance)
            for query in ids for nugget in mapping[query]
            for doc, relevance in nuggets[nugget].items()
        ], measures=["alpha-nDCG@10"]).evaluate([
            pyndeval.ScoredDoc(query, doc, score)
            for query in ids for doc, score in cut[query].items()
        ])
        for query in ids:
            per_query[query]["alpha-nDCG@10"] = alpha.get(query, {}).get("alpha-nDCG@10", 0)
            chosen = set(list(run[query])[:10])
            per_query[query]["Coverage@10"] = sum(any(nuggets[nugget].get(doc, 0) > 0 for doc in chosen) for nugget in mapping[query]) / len(mapping[query])
        official = {**fresh.alpha_ndcg(nuggets, mapping, run, [10]), **fresh.coverage(nuggets, mapping, run, [10])}
        if max_return >= 20:
            official.update(fresh.coverage(nuggets, mapping, run, [20]))
        for metric in ["alpha-nDCG@10", "Coverage@10"]:
            assert math.isclose(round(statistics.mean(row[metric] for row in per_query.values()), 4), official[metric], abs_tol=1e-4)
    else:
        official = {}
    metrics = {metric: statistics.mean(row[metric] for row in per_query.values()) for metric in per_query[ids[0]]}
    summary["datasets"][scope] = {"questions": len(ids), "metrics": metrics, "official_rounded": official, "configured_return_limit": max_return, "return_count_min": min(map(len, run.values())), "return_count_max": max(map(len, run.values()))}
    write_new(target / f"{scope}-official-per-query.json", per_query)

papers = {row["id"]: row for row in rows(PUBLIC / "data/qasper-dev.jsonl")}
gold = qasper.get_answers_and_evidence(papers, False)
text_gold = qasper.get_answers_and_evidence(papers, True)
scored = rows(target / "qasper.jsonl")
assert len(scored) == len({row["id"] for row in scored}) == len(gold) == 1005
assert {row["id"] for row in scored} == set(gold)
predictions = {row["id"]: {"answer": "", "evidence": row["predicted_evidence"]} for row in scored}
official = qasper.evaluate(gold, predictions)
text_official = qasper.evaluate(text_gold, predictions)
per_query = {
    row["id"]: {
        "paper_id": row["paper_id"], "eligible": row["eligible"],
        "strict_complete": row["strict_complete"], "strict_coverage": row["strict_coverage"],
        "Evidence F1": max(qasper.paragraph_f1_score(row["predicted_evidence"], annotation["evidence"]) for annotation in gold[row["id"]]),
    } for row in scored
}
assert math.isclose(statistics.mean(row["Evidence F1"] for row in per_query.values()), official["Evidence F1"], abs_tol=1e-12)
assert official["Missing predictions"] == 0
summary["datasets"]["qasper"] = {"questions": 1005, "Evidence F1": official["Evidence F1"], "text_evidence_only_F1": text_official["Evidence F1"], "missing_predictions": 0}
write_new(target / "qasper-official-per-query.json", per_query)
write_new(target / "official-public-summary.json", summary)
assert len({file for file, _ in pending_outputs}) == len(pending_outputs)
assert all(not file.exists() for file, _ in pending_outputs), "Score output already exists"
for file, contents in pending_outputs:
    with file.open("x", encoding="utf8") as handle:
        handle.write(contents)
print(json.dumps({"status": summary["status"], "condition": CONDITION, "questions": 3307}))
