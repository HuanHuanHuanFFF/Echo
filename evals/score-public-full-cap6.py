"""Score the frozen public full cap6 two-arm replay with official metrics."""
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

FRESHSTACK_OFFICIAL = None
ARMS = ["public-A", "public-B"]
SCOPES = ["langchain", "godot", "du", "qasper"]
freeze = json.loads((OUT / "freeze.json").read_text(encoding="utf8"))
receipt = json.loads((OUT / "run-receipt.json").read_text(encoding="utf8"))
assert receipt["status"] == "complete"
assert receipt["arms"] == ARMS
assert receipt["questions"] == 3307
assert receipt["executions"] == 6614


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

def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def utf16_length(value):
    return len(value.encode("utf-16-le")) // 2


def unique_rows(path, expected):
    data = list(rows(path))
    assert [str(row["id"]) for row in data] == [str(item) for item in expected]
    return data


def ids_for(scope):
    return freeze["public"]["source_freeze"]["cohorts"][scope]["ids"]


def arm_label(arm):
    return arm + "-hybrid"


def validate_ranking(row, corpus_ids, label):
    assert row["condition"] == label
    ranking = row["rankings"]
    ids = [str(item["id"]) for item in ranking]
    assert len(set(ids)) == len(ids)
    assert set(ids) <= corpus_ids
    for index, item in enumerate(ranking):
        assert item["rank"] == index + 1
        assert item["rank_score"] == len(ranking) - index
        assert math.isfinite(item["rrf_score"])
    return ranking


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


def bootstrap(values, seed=20260922, iterations=10000):
    values = np.asarray(values, dtype=float)
    if len(values) == 0:
        return [None, None]
    rng = np.random.default_rng(seed)
    means = np.empty(iterations, dtype=float)
    for i in range(iterations):
        means[i] = values[rng.integers(0, len(values), len(values))].mean()
    return [float(x) for x in np.quantile(means, [0.025, 0.975])]


def cluster_bootstrap(sum_count, seed=20260922, iterations=10000):
    if not sum_count:
        return [None, None]
    sums = np.asarray([item[0] for item in sum_count], dtype=float)
    counts = np.asarray([item[1] for item in sum_count], dtype=float)
    rng = np.random.default_rng(seed)
    means = np.empty(iterations, dtype=float)
    for i in range(iterations):
        sample = rng.integers(0, len(sum_count), len(sum_count))
        total_count = counts[sample].sum()
        means[i] = sums[sample].sum() / total_count if total_count else 0.0
    return [float(x) for x in np.quantile(means, [0.025, 0.975])]


def paired_summary(a, b, metric, seed):
    ids = list(a)
    delta = np.asarray([a[q][metric] - b[q][metric] for q in ids], dtype=float)
    return {
        "metric": metric,
        "delta_A_minus_B": float(delta.mean()),
        "wins_A": int((delta > 1e-12).sum()),
        "losses_A": int((delta < -1e-12).sum()),
        "ties": int((abs(delta) <= 1e-12).sum()),
        "bootstrap95_A_minus_B": bootstrap(delta, seed),
        "questions": len(ids),
    }


def score_fixed_scope(scope):
    ids = ids_for(scope)
    corpus_file = PUBLIC / "data" / (
        "du-corpus.jsonl" if scope == "du" else f"freshstack-{scope}-corpus.jsonl"
    )
    corpus_ids = {
        str(row.get("_id", row.get("id"))) for row in rows(corpus_file)
    }
    qrels, nuggets, mapping = build_qrels(scope, ids)
    conditions = {}
    per_condition = {}
    diagnostic = {"rrf_formula_checked": 0, "rrf_formula_failures": 0}
    pool_rows = {str(row["id"]): row for row in rows(OUT / "public" / f"{scope}-candidates.jsonl")}
    assert list(pool_rows) == [str(x) for x in ids]
    for arm in ARMS:
        label = arm_label(arm)
        data = unique_rows(OUT / "public" / f"{scope}-{label}.jsonl", ids)
        run = {}
        for row in data:
            ranking = validate_ranking(row, corpus_ids, label)
            run[str(row["id"])] = {str(item["id"]): item["rank_score"] for item in ranking}
            pool = pool_rows[str(row["id"])]
            arm_pool = pool[arm]
            bm25 = {str(item["id"]): item for item in arm_pool["bm25"]}
            dense = {str(item["id"]): item for item in arm_pool["dense"]}
            expected = {}
            spec = freeze["arms"][arm]
            for doc_id in set(bm25) | set(dense):
                score = 0.0
                if doc_id in bm25:
                    score += spec["bm25_weight"] / (spec["rrf_k"] + bm25[doc_id]["rank"])
                if doc_id in dense:
                    score += spec["dense_weight"] / (spec["rrf_k"] + dense[doc_id]["rank"])
                expected[doc_id] = score
            actual = {str(item["id"]): item["rrf_score"] for item in arm_pool["hybrid"]}
            scored_ranking = [
                (str(item["id"]), item["rrf_score"]) for item in ranking
            ]
            pool_ranking = [
                (str(item["id"]), item["rrf_score"]) for item in arm_pool["hybrid"]
            ]
            assert scored_ranking == pool_ranking
            assert set(actual) == set(expected)
            for doc_id, value in actual.items():
                diagnostic["rrf_formula_checked"] += 1
                if not math.isclose(value, expected[doc_id], rel_tol=1e-12, abs_tol=1e-12):
                    diagnostic["rrf_formula_failures"] += 1
                    raise AssertionError((scope, arm, row["id"], doc_id, value, expected[doc_id]))
            assert len(arm_pool["bm25"]) <= 60
            assert len(arm_pool["dense"]) <= 60
            assert all(
                item["similarity"] is None or item["similarity"] >= 0.3
                for item in arm_pool["dense"]
            )
        evaluated = pytrec_eval.RelevanceEvaluator(
            qrels, {"ndcg_cut.10", "recall.10,50"}
        ).evaluate(run)
        cut = {query_id: dict(list(run[query_id].items())[:10]) for query_id in ids}
        reciprocal = pytrec_eval.RelevanceEvaluator(qrels, {"recip_rank"}).evaluate(cut)
        values = {
            query_id: {
                "ndcg_cut_10": evaluated.get(query_id, {}).get("ndcg_cut_10", 0),
                "recall_10": evaluated.get(query_id, {}).get("recall_10", 0),
                "recall_50": evaluated.get(query_id, {}).get("recall_50", 0),
                "MRR@10": reciprocal.get(query_id, {}).get("recip_rank", 0),
                "Hit@10": int(
                    any(qrels[query_id].get(doc, 0) > 0 for doc in cut[query_id])
                ),
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
            alpha = pyndeval.RelevanceEvaluator(
                subtopic_qrels, measures=["alpha-nDCG@10"]
            ).evaluate(
                [
                    pyndeval.ScoredDoc(query_id, doc, score)
                    for query_id in ids
                    for doc, score in cut[query_id].items()
                ]
            )
            for query_id in ids:
                values[query_id]["alpha-nDCG@10"] = alpha.get(query_id, {}).get(
                    "alpha-nDCG@10", 0
                )
                selected = set(list(run[query_id])[:20])
                values[query_id]["Coverage@20"] = sum(
                    any(nuggets[nugget].get(doc, 0) > 0 for doc in selected)
                    for nugget in mapping[query_id]
                ) / len(mapping[query_id])
        metrics = {
            metric: statistics.mean(item[metric] for item in values.values())
            for metric in values[ids[0]]
        }
        if scope != "du":
            global FRESHSTACK_OFFICIAL
            if FRESHSTACK_OFFICIAL is None:
                FRESHSTACK_OFFICIAL = module(
                    "freshstack_metrics",
                    PUBLIC / "reference/freshstack_metrics.py",
                )
            official_metrics = {
                **FRESHSTACK_OFFICIAL.ndcg(qrels, run, [10]),
                **FRESHSTACK_OFFICIAL.recall(qrels, run, [10, 50]),
                **FRESHSTACK_OFFICIAL.alpha_ndcg(nuggets, mapping, run, [10]),
                **FRESHSTACK_OFFICIAL.coverage(nuggets, mapping, run, [20]),
            }
            assert math.isclose(
                round(metrics["ndcg_cut_10"], 5),
                official_metrics["NDCG@10"],
                abs_tol=1e-5,
            )
            assert math.isclose(
                round(metrics["recall_10"], 4),
                official_metrics["Recall@10"],
                abs_tol=1e-4,
            )
            assert math.isclose(
                round(metrics["recall_50"], 4),
                official_metrics["Recall@50"],
                abs_tol=1e-4,
            )
            assert math.isclose(
                round(metrics["alpha-nDCG@10"], 4),
                official_metrics["alpha-nDCG@10"],
                abs_tol=1e-4,
            )
            assert math.isclose(
                round(metrics["Coverage@20"], 4),
                official_metrics["Coverage@20"],
                abs_tol=1e-4,
            )
            metrics.update(official_metrics)
            diagnostic["official_metrics_called"] = True
        else:
            metrics["nDCG@10"] = metrics["ndcg_cut_10"]
            metrics["Recall@10"] = metrics["recall_10"]
            metrics["Recall@50"] = metrics["recall_50"]
        conditions[label] = {
            "questions": len(ids),
            "metrics": metrics,
            "hit10_count": sum(item["Hit@10"] for item in values.values()),
        }
        per_condition[label] = values
        (OUT / "scoring" / f"{scope}-{label}-per-question.json").write_text(
            json.dumps(values, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
        )
    primary = "ndcg_cut_10" if scope == "du" else "alpha-nDCG@10"
    return {
        "questions": len(ids),
        "population": freeze["public"]["source_freeze"]["cohorts"][scope]["population"],
        "conditions": conditions,
        "paired_A_minus_B": paired_summary(
            per_condition["public-A-hybrid"],
            per_condition["public-B-hybrid"],
            primary,
            20260922 + len(scope),
        ),
        "diagnostic_audit": diagnostic,
        "primary_metric": primary,
    }


def score_qasper():
    scope = "qasper"
    ids = ids_for(scope)
    queries = {row["id"]: row for row in rows(PUBLIC / "prepared/qasper-queries.jsonl")}
    docs = {row["id"]: row for row in rows(PUBLIC / "prepared/qasper-docs.jsonl")}
    assert len(ids) == len(queries) == 1005
    assert sum(bool(row["eligible"]) for row in queries.values()) == 800
    assert sum(
        bool(row["annotations"]) and all(a["unanswerable"] for a in row["annotations"])
        for row in queries.values()
    ) == 60
    papers = {row["id"]: row for row in rows(PUBLIC / "data/qasper-dev.jsonl")}
    doc_bindings = {}
    for doc in docs.values():
        actual_sha = sha(pathlib.Path(doc["file"]))
        assert actual_sha == doc["sha256"]
        doc_bindings[doc["id"]] = {
            "file": doc["file"],
            "sha256": actual_sha,
        }
    doc_binding_sha = hashlib.sha256(
        compact_json(doc_bindings).encode("utf8")
    ).hexdigest()
    official = module("qasper_official", PUBLIC / "reference/qasper_evaluator.py")
    gold_all = official.get_answers_and_evidence(papers, False)
    text_gold = official.get_answers_and_evidence(papers, True)
    conditions = {}
    per_condition = {}
    for arm in ARMS:
        label = arm_label(arm)
        data = unique_rows(OUT / "public" / f"qasper-{label}.jsonl", ids)
        predictions = {}
        values = {}
        for row in data:
            assert row["condition"] == label
            query = queries[row["id"]]
            assert row["request"]["query"] == query["text"].strip()
            assert row["request"]["filters"]["source_ids"] == [query["source_id"]]
            limits = freeze["arms"][arm]["retrieval"]
            assert row["request_chars"] == utf16_length(
                compact_json(row["request"])
            )
            assert row["response_chars"] == utf16_length(
                compact_json(row["result"])
            )
            assert row["request_chars"] + row["response_chars"] <= limits["max_context_chars"]
            applied = row["result"]["applied"]
            assert applied["lexical_engine"] == "minisearch"
            assert applied["minisearch_k"] == 1.2
            assert applied["minisearch_b"] == 0.7
            assert applied["minisearch_d"] == 0.5
            assert applied["bm25_weight"] == freeze["arms"][arm]["bm25_weight"]
            assert applied["dense_weight"] == freeze["arms"][arm]["dense_weight"]
            assert applied["rrf_k"] == freeze["arms"][arm]["rrf_k"]
            assert row["result"]["selection"] == {
                "chunker": "markdown-structure-v1",
                "tokenizer": "icu-zh",
                "embedding": "qwen",
                "retrieval": "rrf10",
            }
            assert applied["topk"] == 10
            assert row["result"]["applied"]["max_chunks_per_source"] == 6
            assert row["result"]["applied"]["bm25_candidates"] == 60
            assert row["result"]["applied"]["dense_candidates"] == 60
            assert row["result"]["applied"]["title_weight"] == 2
            assert applied["min_dense_similarity"] == 0.3
            assert applied["max_chunks_per_source"] == 6
            assert applied["max_context_chars"] <= 20000
            assert len(row["result"]["results"]) <= 10
            for piece in row["result"]["results"]:
                assert piece["source_id"] == query["source_id"]
                for ranking in piece.get("rankings", []):
                    expected_rrf = 0.0
                    if ranking.get("bm25_rank") is not None:
                        expected_rrf += freeze["arms"][arm]["bm25_weight"] / (
                            freeze["arms"][arm]["rrf_k"] + ranking["bm25_rank"]
                        )
                    if ranking.get("dense_rank") is not None:
                        expected_rrf += freeze["arms"][arm]["dense_weight"] / (
                            freeze["arms"][arm]["rrf_k"] + ranking["dense_rank"]
                        )
                    assert math.isclose(
                        ranking["rrf_score"], expected_rrf, rel_tol=1e-12, abs_tol=1e-12
                    )
            assert row["score"]["eligible"] in (True, False)
            doc = docs[queries[row["id"]]["paper_id"]]
            selected = set(row["score"]["selected_paragraphs"])
            evidence = [
                paragraph["text"]
                for paragraph in doc["paragraphs"]
                if paragraph["id"] in selected
            ]
            predictions[row["id"]] = {"answer": "", "evidence": evidence}
            official_f1 = max(
                official.paragraph_f1_score(evidence, annotation["evidence"])
                for annotation in gold_all[row["id"]]
            )
            assert math.isclose(
                official_f1,
                row["score"]["official_formula_evidence_f1"],
                abs_tol=1e-12,
            )
            values[row["id"]] = {
                "eligible": bool(row["score"]["eligible"]),
                "category": row["score"]["category"],
                "strict_complete": bool(row["score"]["strict_complete"]),
                "strict_coverage": row["score"]["strict_coverage"],
                "official_evidence_f1": row["score"]["official_formula_evidence_f1"],
                "request_chars": row["request_chars"],
                "response_chars": row["response_chars"],
                "context_chars": row["request_chars"] + row["response_chars"],
                "excluded": row["result"]["excluded"],
                "selected_paragraphs": row["score"]["selected_paragraphs"],
                "paper_id": row["paper_id"],
            }
        official_result = official.evaluate(gold_all, predictions)
        text_result = official.evaluate(text_gold, predictions)
        eligible = [v for v in values.values() if v["eligible"]]
        conditions[label] = {
            "questions": len(data),
            "eligible": len(eligible),
            "complete": sum(v["strict_complete"] for v in eligible),
            "complete_rate": statistics.mean(v["strict_complete"] for v in eligible),
            "strict_coverage": statistics.mean(v["strict_coverage"] for v in eligible),
            "official_evidence_f1_all": official_result["Evidence F1"],
            "official_evidence_f1_text_evidence_only": text_result["Evidence F1"],
            "mean_context_chars": statistics.mean(v["context_chars"] for v in values.values()),
            "budget_exclusion_questions": sum(v["excluded"]["budget"] > 0 for v in values.values()),
            "source_cap_exclusion_questions": sum(v["excluded"]["source_limit"] > 0 for v in values.values()),
            "topk_exclusion_questions": sum(v["excluded"]["topk"] > 0 for v in values.values()),
            "official_missing_predictions": official_result["Missing predictions"],
        }
        per_condition[label] = values
        (OUT / "scoring" / f"qasper-{label}-per-question.json").write_text(
            json.dumps(values, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
        )
    def scalar_map(label, key, eligible=False):
        return {
            q: per_condition[label][q][key]
            for q in ids
            if (not eligible or per_condition[label][q]["eligible"])
        }
    eligible_ids = [
        q for q in ids if per_condition["public-A-hybrid"][q]["eligible"]
    ]
    cluster_ids = sorted({per_condition["public-A-hybrid"][q]["paper_id"] for q in ids})
    by_paper = {
        paper: [q for q in ids if per_condition["public-A-hybrid"][q]["paper_id"] == paper]
        for paper in cluster_ids
    }
    delta_complete = np.asarray(
        [
            float(per_condition["public-A-hybrid"][q]["strict_complete"])
            - float(per_condition["public-B-hybrid"][q]["strict_complete"])
            for q in eligible_ids
        ]
    )
    delta_f1 = np.asarray(
        [
            per_condition["public-A-hybrid"][q]["official_evidence_f1"]
            - per_condition["public-B-hybrid"][q]["official_evidence_f1"]
            for q in ids
        ]
    )
    delta_coverage = np.asarray(
        [
            per_condition["public-A-hybrid"][q]["strict_coverage"]
            - per_condition["public-B-hybrid"][q]["strict_coverage"]
            for q in eligible_ids
        ]
    )
    cluster_complete = []
    cluster_coverage = []
    cluster_f1 = []
    for paper in cluster_ids:
        paper_questions = by_paper[paper]
        eligible_paper = [q for q in paper_questions if q in eligible_ids]
        cluster_complete.append(
            (
                sum(
                    float(per_condition["public-A-hybrid"][q]["strict_complete"])
                    - float(per_condition["public-B-hybrid"][q]["strict_complete"])
                    for q in eligible_paper
                ),
                len(eligible_paper),
            )
        )
        cluster_coverage.append(
            (
                sum(
                    per_condition["public-A-hybrid"][q]["strict_coverage"]
                    - per_condition["public-B-hybrid"][q]["strict_coverage"]
                    for q in eligible_paper
                ),
                len(eligible_paper),
            )
        )
        cluster_f1.append(
            (
                sum(
                    per_condition["public-A-hybrid"][q]["official_evidence_f1"]
                    - per_condition["public-B-hybrid"][q]["official_evidence_f1"]
                    for q in paper_questions
                ),
                len(paper_questions),
            )
        )
    paired = {
        "strict_complete_eligible": {
            "questions": len(eligible_ids),
            "delta_A_minus_B": float(delta_complete.mean()),
            "wins_A": int((delta_complete > 1e-12).sum()),
            "losses_A": int((delta_complete < -1e-12).sum()),
            "ties": int((abs(delta_complete) <= 1e-12).sum()),
            "bootstrap95_paper_cluster_A_minus_B": cluster_bootstrap(cluster_complete, 20260923),
        },
        "strict_coverage_eligible": {
            "questions": len(eligible_ids),
            "delta_A_minus_B": float(delta_coverage.mean()),
            "wins_A": int((delta_coverage > 1e-12).sum()),
            "losses_A": int((delta_coverage < -1e-12).sum()),
            "ties": int((abs(delta_coverage) <= 1e-12).sum()),
            "bootstrap95_paper_cluster_A_minus_B": cluster_bootstrap(
                cluster_coverage, 20260924
            ),
        },
        "official_evidence_f1_all": {
            "questions": len(ids),
            "delta_A_minus_B": float(delta_f1.mean()),
            "wins_A": int((delta_f1 > 1e-12).sum()),
            "losses_A": int((delta_f1 < -1e-12).sum()),
            "ties": int((abs(delta_f1) <= 1e-12).sum()),
            "bootstrap95_paper_cluster_A_minus_B": cluster_bootstrap(cluster_f1, 20260925),
        },
    }
    return {
        "questions": 1005,
        "strict_text_eligible": 800,
        "all_annotation_unanswerable": 60,
        "paper_count": len(docs),
        "document_bindings_sha256": doc_binding_sha,
        "conditions": conditions,
        "paired_A_minus_B": paired,
        "primary_metric": "strict_complete among 800 eligible text questions",
    }


OUT.joinpath("scoring").mkdir(exist_ok=True)
fixed_results = {
    scope: score_fixed_scope(scope) for scope in ["langchain", "godot", "du"]
}
qasper_result = score_qasper()
input_bindings = {}
for scope in SCOPES:
    cohort = freeze["public"]["source_freeze"]["cohorts"][scope]
    for key in ["database", "query_file", "corpus_file", "docs_file"]:
        if key in cohort:
            input_bindings[f"{scope}:{key}"] = {
                "path": cohort[key],
                "sha256": sha(pathlib.Path(cohort[key])),
            }
input_bindings.update(
    {
        "du:qrels": {
            "path": str(PUBLIC / "data/du-qrels.jsonl"),
            "sha256": sha(PUBLIC / "data/du-qrels.jsonl"),
        },
        "qasper:raw_annotations": {
            "path": str(PUBLIC / "data/qasper-dev.jsonl"),
            "sha256": sha(PUBLIC / "data/qasper-dev.jsonl"),
        },
        "qasper:source_id_fixture": {
            "path": str(pathlib.Path(__file__).parent / "fixtures/qasper-v0.3-source-ids.json"),
            "sha256": sha(pathlib.Path(__file__).parent / "fixtures/qasper-v0.3-source-ids.json"),
        },
        "qasper:official_evaluator": {
            "path": str(PUBLIC / "reference/qasper_evaluator.py"),
            "sha256": sha(PUBLIC / "reference/qasper_evaluator.py"),
        },
        "freshstack:official_metrics": {
            "path": str(PUBLIC / "reference/freshstack_metrics.py"),
            "sha256": sha(PUBLIC / "reference/freshstack_metrics.py"),
        },
    }
)
summary = {
    "status": "complete",
    "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "scope": "public full 3307 questions; only two primary hybrid arms; no new embeddings",
    "arms": freeze["arms"],
    "results": fixed_results,
    "qasper": qasper_result,
    "input_bindings": input_bindings,
    "validation": {
        "public_root": str(PUBLIC),
        "freeze_sha256": sha(OUT / "freeze.json"),
        "run_receipt_sha256": sha(OUT / "run-receipt.json"),
        "scorer_sha256": sha(pathlib.Path(__file__)),
        "scorer": "official FreshStack metrics / pytrec_eval; official QASPER evaluator; Du C-MTEB dev protocol via pytrec_eval",
        "python": sys.version,
        "packages": {
            name: importlib.metadata.version(name)
            for name in ["pyndeval", "pytrec-eval-terrier", "numpy", "scipy"]
        },
        "qasper_official_scorer_sha256": sha(PUBLIC / "reference/qasper_evaluator.py"),
        "freshstack_official_metrics_sha256": sha(PUBLIC / "reference/freshstack_metrics.py"),
        "freshstack_official_metrics_executed": True,
        "du_protocol_reference": str(PUBLIC / "reference/c-mteb-retrieval-task-receipt.json"),
        "du_protocol_reference_sha256": sha(PUBLIC / "reference/c-mteb-retrieval-task-receipt.json"),
    },
}
(OUT / "public-score.json").write_text(
    json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
)
(OUT / "provenance.json").write_text(
    json.dumps(
        {
            "status": "complete",
            "freeze_sha256": summary["validation"]["freeze_sha256"],
            "run_receipt_sha256": summary["validation"]["run_receipt_sha256"],
            "scorer_sha256": summary["validation"]["scorer_sha256"],
            "runner_sha256": freeze["code"]["runner"],
            "shared_core_sha256": freeze["code"]["shared_core"],
            "dist_sha256": freeze["code"]["dist"],
            "input_bindings": input_bindings,
            "qasper_document_bindings_sha256": qasper_result["document_bindings_sha256"],
            "qasper_document_count": qasper_result["paper_count"],
            "official_freshstack_metrics_executed": True,
        },
        ensure_ascii=False,
        indent=2,
    )
    + "\n",
    encoding="utf8",
)
print(
    json.dumps(
        {
            "status": summary["status"],
            "scopes": list(summary["results"]),
            "qasper": summary["qasper"]["conditions"],
        },
        ensure_ascii=False,
    )
)
