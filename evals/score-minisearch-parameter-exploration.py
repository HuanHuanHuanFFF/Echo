"""Score the frozen public 331-question parameter exploration with official metrics."""

import collections
import datetime
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import pathlib
import statistics
import sys


PUBLIC = pathlib.Path(sys.argv[1]).resolve()
OUT = pathlib.Path(sys.argv[2]).resolve()
assert (OUT / "freeze.json").exists()
assert (OUT / "run-receipt.json").exists()
sys.path.insert(0, str(PUBLIC / "scoring-tools"))
sys.path.insert(0, str(pathlib.Path(__file__).parent / "lib"))
import numpy as np
import pyndeval
import pytrec_eval


def read(path):
    return json.loads(path.read_text(encoding="utf8"))


def rows(path):
    with path.open(encoding="utf8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


freeze = read(OUT / "freeze.json")
receipt = read(OUT / "run-receipt.json")
assert receipt["status"] == "complete"
arms = list(freeze["arms"])
labels = ["dense"] + [f"{arm}-{mode}" for arm in arms for mode in ("bm25", "hybrid")]


def unique_rows(path, expected):
    data = list(rows(path))
    assert [row["id"] for row in data] == expected
    return data


def qasper_limits(label):
    if label == "dense-reference":
        return {"topk": 10, "max_chunks_per_source": 3, "budget": 16000}
    suffix = "-hybrid" if label.endswith("-hybrid") else "-bm25"
    arm = freeze["arms"][label[: -len(suffix)]]
    retrieval = arm.get("retrieval", {})
    return {
        "topk": retrieval.get("topk", 10),
        "max_chunks_per_source": retrieval.get("max_chunks_per_source", 3),
        "budget": retrieval.get("max_context_chars", 16000),
    }


def validate_ranking(row, corpus_ids, label):
    assert row["condition"] == label
    rankings = row["rankings"]
    assert len({item["id"] for item in rankings}) == len(rankings)
    assert set(item["id"] for item in rankings) <= corpus_ids
    for index, item in enumerate(rankings):
        assert item["rank"] == index + 1
        assert item["rank_score"] == len(rankings) - index
        assert math.isfinite(item["rrf_score"])
    return rankings


def build_qrels(scope, ids):
    if scope == "du":
        qrels = collections.defaultdict(dict)
        for row in rows(PUBLIC / "data/du-qrels.jsonl"):
            if row["qid"] in ids:
                qrels[row["qid"]][row["pid"]] = row["score"]
        return qrels, None, None
    query_file = PUBLIC / f"data/freshstack-{scope}-queries.jsonl"
    query_map = {row["query_id"]: row for row in rows(query_file)}
    qrels = collections.defaultdict(dict)
    nuggets = {}
    mapping = {}
    for query_id in ids:
        mapping[query_id] = []
        for nugget in query_map[query_id]["nuggets"]:
            nugget_id = nugget["_id"]
            mapping[query_id].append(nugget_id)
            values = {doc: 0 for doc in nugget["non_relevant_corpus_ids"]}
            values.update({doc: 1 for doc in nugget["relevant_corpus_ids"]})
            nuggets[nugget_id] = values
            for doc, relevance in values.items():
                qrels[query_id][doc] = qrels[query_id].get(doc, 0) + relevance
    return qrels, nuggets, mapping


def score_public_scope(scope):
    ids = freeze["public"]["source_freeze"]["cohorts"][scope]["ids"]
    corpus_file = PUBLIC / "data" / ("du-corpus.jsonl" if scope == "du" else f"freshstack-{scope}-corpus.jsonl")
    corpus_ids = {row.get("_id", row.get("id")) for row in rows(corpus_file)}
    qrels, nuggets, mapping = build_qrels(scope, ids)
    conditions = {}
    per_condition = {}
    for label in labels:
        data = unique_rows(OUT / "public" / f"{scope}-{label}.jsonl", ids)
        run = {}
        for row in data:
            ranking = validate_ranking(row, corpus_ids, label)
            run[row["id"]] = {item["id"]: item["rank_score"] for item in ranking}
        eval_result = pytrec_eval.RelevanceEvaluator(
            qrels, {"ndcg_cut.10", "recall.10,50"}
        ).evaluate(run)
        cut = {query_id: dict(list(run[query_id].items())[:10]) for query_id in ids}
        reciprocal = pytrec_eval.RelevanceEvaluator(qrels, {"recip_rank"}).evaluate(cut)
        values = {
            query_id: {
                "ndcg_cut_10": eval_result.get(query_id, {}).get("ndcg_cut_10", 0),
                "recall_10": eval_result.get(query_id, {}).get("recall_10", 0),
                "recall_50": eval_result.get(query_id, {}).get("recall_50", 0),
                "MRR@10": reciprocal.get(query_id, {}).get("recip_rank", 0),
                "Hit@10": int(any(qrels[query_id].get(doc, 0) > 0 for doc in cut[query_id])),
            }
            for query_id in ids
        }
        if scope != "du":
            subtopic_qrels = [
                pyndeval.SubtopicQrel(query_id, nugget, doc, relevance)
                for query_id in ids
                for nugget in mapping[query_id]
                for doc, relevance in nuggets[nugget].items()
            ]
            alpha = pyndeval.RelevanceEvaluator(subtopic_qrels, measures=["alpha-nDCG@10"]).evaluate(
                [pyndeval.ScoredDoc(query_id, doc, score) for query_id in ids for doc, score in cut[query_id].items()]
            )
            for query_id in ids:
                values[query_id]["alpha-nDCG@10"] = alpha.get(query_id, {}).get("alpha-nDCG@10", 0)
                selected = set(list(run[query_id])[:20])
                values[query_id]["Coverage@20"] = sum(
                    any(nuggets[nugget].get(doc, 0) > 0 for doc in selected)
                    for nugget in mapping[query_id]
                ) / len(mapping[query_id])
        metrics = {metric: statistics.mean(item[metric] for item in values.values()) for metric in values[ids[0]]}
        conditions[label] = {
            "questions": len(ids),
            "metrics": metrics,
            "hit10_count": sum(item["Hit@10"] for item in values.values()),
        }
        per_condition[label] = values
    primary_metric = "ndcg_cut_10" if scope == "du" else "alpha-nDCG@10"
    paired = {}
    if "default-hybrid" in per_condition:
        for label in labels:
            if label in ("dense", "default-hybrid"):
                continue
            delta = np.array([per_condition[label][q][primary_metric] - per_condition["default-hybrid"][q][primary_metric] for q in ids])
            paired[label] = {
                "metric": primary_metric,
                "delta": float(delta.mean()),
                "wins": int((delta > 1e-12).sum()),
                "losses": int((delta < -1e-12).sum()),
                "ties": int((abs(delta) <= 1e-12).sum()),
            }
    return {"conditions": conditions, "paired_vs_default_hybrid": paired}


def score_qasper():
    ids = freeze["public"]["source_freeze"]["cohorts"]["qasper"]["ids"]
    official = module("qasper_official", PUBLIC / "reference/qasper_evaluator.py")
    queries = {row["id"]: row for row in rows(PUBLIC / "prepared/qasper-queries.jsonl")}
    docs = {row["id"]: row for row in rows(PUBLIC / "prepared/qasper-docs.jsonl")}
    papers = {row["id"]: row for row in rows(PUBLIC / "data/qasper-dev.jsonl")}
    gold_all = official.get_answers_and_evidence(papers, False)
    gold = {query_id: gold_all[query_id] for query_id in ids}
    conditions = {}
    for label in labels:
        file_label = "dense-reference" if label == "dense" else label
        data = unique_rows(OUT / "public" / f"qasper-{file_label}.jsonl", ids)
        limits = qasper_limits(file_label)
        for row in data:
            assert row["condition"] == file_label
            assert row["request_chars"] + row["response_chars"] <= limits["budget"]
            assert len(row["result"]["results"]) <= limits["topk"]
            assert len(row["result"]["results"]) <= limits["max_chunks_per_source"]
            assert row["score"]["eligible"] in (True, False)
        eligible = [row for row in data if row["score"]["eligible"]]
        predictions = {}
        for row in data:
            doc = docs[queries[row["id"]]["paper_id"]]
            selected = set(row["score"]["selected_paragraphs"])
            evidence = [paragraph["text"] for paragraph in doc["paragraphs"] if paragraph["id"] in selected]
            predictions[row["id"]] = {"answer": "", "evidence": evidence}
            official_f1 = max(official.paragraph_f1_score(evidence, annotation["evidence"]) for annotation in gold[row["id"]])
            assert math.isclose(official_f1, row["score"]["official_formula_evidence_f1"], abs_tol=1e-12)
        official_result = official.evaluate(gold, predictions)
        assert official_result["Missing predictions"] == 0
        conditions[label] = {
            "questions": len(data),
            "eligible": len(eligible),
            "complete": sum(bool(row["score"]["strict_complete"]) for row in eligible),
            "complete_rate": statistics.mean(bool(row["score"]["strict_complete"]) for row in eligible),
            "strict_coverage": statistics.mean(row["score"]["strict_coverage"] for row in eligible),
            "official_evidence_f1_all": official_result["Evidence F1"],
            "mean_context_chars": statistics.mean(row["request_chars"] + row["response_chars"] for row in data),
            "budget_exclusion_questions": sum(row["result"]["excluded"]["budget"] > 0 for row in data),
        }
    paired = {}
    if "default-hybrid" in conditions:
        for label in labels:
            if label in ("dense", "default-hybrid"):
                continue
            paired[label] = {
                "complete_delta": conditions[label]["complete"] - conditions["default-hybrid"]["complete"],
                "strict_coverage_delta": conditions[label]["strict_coverage"] - conditions["default-hybrid"]["strict_coverage"],
                "evidence_f1_delta": conditions[label]["official_evidence_f1_all"] - conditions["default-hybrid"]["official_evidence_f1_all"],
            }
    return {"conditions": conditions, "paired_vs_default_hybrid": paired}


summary = {
    "status": "complete",
    "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "scope": "public 331-question fixed sample; no new embeddings",
    "arms": freeze["arms"],
    "results": {scope: score_public_scope(scope) for scope in ("langchain", "godot", "du")},
    "qasper": score_qasper(),
    "validation": {
        "public_root": str(PUBLIC),
        "run_receipt": sha(OUT / "run-receipt.json"),
        "scorer_sha256": sha(pathlib.Path(__file__)),
        "python": sys.version,
        "numpy": importlib.metadata.version("numpy"),
        "pytrec_eval": importlib.metadata.version("pytrec-eval-terrier"),
    },
}
(OUT / "public-score.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
qasper_preview = summary["qasper"]["conditions"].get("default-hybrid")
if qasper_preview is None:
    qasper_preview = summary["qasper"]["conditions"]
print(json.dumps({"status": summary["status"], "scopes": list(summary["results"]), "qasper": qasper_preview}, ensure_ascii=False))
