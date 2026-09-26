"""Analyze full public cap6 results by opened 331-question sample vs remaining diagnostics."""
import argparse
import hashlib
import json
import pathlib
import statistics

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("public_root")
parser.add_argument("output_root")
parser.add_argument("--private-a-root", required=True)
parser.add_argument("--private-b-root", required=True)
args = parser.parse_args()
PUBLIC = pathlib.Path(args.public_root).resolve()
OUT = pathlib.Path(args.output_root).resolve()
SCORE = json.loads((OUT / "public-score.json").read_text(encoding="utf8"))
OLD_FREEZE = json.loads(
    (PUBLIC / "analysis/minisearch-without-coverage-2026-09-21-v1/freeze.json").read_text(
        encoding="utf8"
    )
)
OLD_IDS = {
    scope: set(map(str, value["ids"]))
    for scope, value in OLD_FREEZE["cohorts"].items()
}
ARMS = ["public-A", "public-B"]
SCOPES = ["langchain", "godot", "du", "qasper"]


def rows(path):
    with path.open(encoding="utf8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path):
    return json.loads(path.read_text(encoding="utf8"))


def group_stats(values_a, values_b, ids, metrics):
    result = {"questions": len(ids)}
    for metric in metrics:
        a = [values_a[q][metric] for q in ids]
        b = [values_b[q][metric] for q in ids]
        delta = [x - y for x, y in zip(a, b)]
        result[metric] = {
            "A": statistics.mean(a),
            "B": statistics.mean(b),
            "A_minus_B": statistics.mean(delta),
            "wins_A": sum(x > 1e-12 for x in delta),
            "losses_A": sum(x < -1e-12 for x in delta),
            "ties": sum(abs(x) <= 1e-12 for x in delta),
        }
    return result


def load_fixed(scope):
    values = {}
    for arm in ARMS:
        values[arm] = load_json(
            OUT / "scoring" / f"{scope}-{arm}-hybrid-per-question.json"
        )
    ids = list(values["public-A"])
    metric = "ndcg_cut_10" if scope == "du" else "alpha-nDCG@10"
    old = [q for q in ids if q in OLD_IDS[scope]]
    rest = [q for q in ids if q not in OLD_IDS[scope]]
    candidates = {}
    for row in rows(OUT / "public" / f"{scope}-candidates.jsonl"):
        qid = str(row["id"])
        a = row["public-A"]
        b = row["public-B"]

        def signature(lane):
            return tuple(
                (
                    str(x["id"]),
                    x["rank"],
                    x.get("bm25_rank"),
                    x.get("dense_rank"),
                    x.get("similarity"),
                )
                for x in lane
            )

        candidates[qid] = {
            "pool_equal": signature(a["bm25"]) == signature(b["bm25"])
            and signature(a["dense"]) == signature(b["dense"]),
            "a_top": [str(x["id"]) for x in a["hybrid"][:10]],
            "b_top": [str(x["id"]) for x in b["hybrid"][:10]],
        }
    disagreements = sum(
        candidates[q]["a_top"] != candidates[q]["b_top"] for q in ids
    )
    pool_equal = sum(candidates[q]["pool_equal"] for q in ids)
    deltas = sorted(
        (
            abs(values["public-A"][q][metric] - values["public-B"][q][metric]),
            q,
        )
        for q in ids
    )[::-1]
    representatives = []
    for absolute, q in deltas[:10]:
        representatives.append(
            {
                "id": q,
                "metric": metric,
                "absolute_delta": absolute,
                "A": values["public-A"][q][metric],
                "B": values["public-B"][q][metric],
                "A_top10": candidates[q]["a_top"],
                "B_top10": candidates[q]["b_top"],
            }
        )
    return {
        "population": len(ids),
        "opened_sample": len(old),
        "remaining_diagnostic": len(rest),
        "primary_metric": metric,
        "opened_sample_metrics": group_stats(
            values["public-A"], values["public-B"], old, [metric]
        ),
        "remaining_diagnostic_metrics": group_stats(
            values["public-A"], values["public-B"], rest, [metric]
        ),
        "candidate_pool_equal_questions": pool_equal,
        "candidate_pool_equal_rate": pool_equal / len(ids),
        "hybrid_top10_different_questions": disagreements,
        "hybrid_top10_different_rate": disagreements / len(ids),
        "representative_top_metric_differences": representatives,
        "limitation": "Candidate-pool equality and top-rank causes are available for fixed-unit corpora; QASPER final rows expose no full candidate IDs, so QASPER source_limit counts are reported without claiming pool availability.",
    }


def load_qasper():
    values = {}
    for arm in ARMS:
        values[arm] = load_json(
            OUT / "scoring" / f"qasper-{arm}-hybrid-per-question.json"
        )
    ids = list(values["public-A"])
    old = [q for q in ids if q in OLD_IDS["qasper"]]
    rest = [q for q in ids if q not in OLD_IDS["qasper"]]
    old_eligible = [q for q in old if values["public-A"][q]["eligible"]]
    rest_eligible = [q for q in rest if values["public-A"][q]["eligible"]]
    strict_metrics = ["strict_complete", "strict_coverage"]
    result = {
        "population": len(ids),
        "opened_sample": len(old),
        "remaining_diagnostic": len(rest),
        "strict_eligible_opened_sample": sum(
            values["public-A"][q]["eligible"] for q in old
        ),
        "strict_eligible_remaining_diagnostic": sum(
            values["public-A"][q]["eligible"] for q in rest
        ),
        "opened_sample_metrics": {
            "strict_eligible": group_stats(
                values["public-A"], values["public-B"], old_eligible, strict_metrics
            ),
            "official_evidence_f1_all": group_stats(
                values["public-A"], values["public-B"], old, ["official_evidence_f1"]
            ),
        },
        "remaining_diagnostic_metrics": {
            "strict_eligible": group_stats(
                values["public-A"], values["public-B"], rest_eligible, strict_metrics
            ),
            "official_evidence_f1_all": group_stats(
                values["public-A"], values["public-B"], rest, ["official_evidence_f1"]
            ),
        },
        "source_cap_exclusion_questions": {
            arm: SCORE["qasper"]["conditions"][f"{arm}-hybrid"][
                "source_cap_exclusion_questions"
            ]
            for arm in ARMS
        },
        "budget_exclusion_questions": {
            arm: SCORE["qasper"]["conditions"][f"{arm}-hybrid"][
                "budget_exclusion_questions"
            ]
            for arm in ARMS
        },
        "representative_f1_differences": [],
    }
    deltas = sorted(
        (
            abs(
                values["public-A"][q]["official_evidence_f1"]
                - values["public-B"][q]["official_evidence_f1"]
            ),
            q,
        )
        for q in ids
    )[::-1]
    for absolute, q in deltas[:10]:
        a, b = values["public-A"][q], values["public-B"][q]
        result["representative_f1_differences"].append(
            {
                "id": q,
                "paper_id": a["paper_id"],
                "category": a["category"],
                "absolute_delta": absolute,
                "A_f1": a["official_evidence_f1"],
                "B_f1": b["official_evidence_f1"],
                "A_complete": a["strict_complete"],
                "B_complete": b["strict_complete"],
                "A_selected_paragraphs": a["selected_paragraphs"],
                "B_selected_paragraphs": b["selected_paragraphs"],
            }
        )
    result["limitation"] = "QASPER source_limit_exclusion_questions is an observed packing count; without full candidate IDs it does not prove the missing gold was in-pool or cap-blocked."
    return result


private = {
    "A": {
        "root": str(pathlib.Path(args.private_a_root).resolve()),
        "freeze_sha256": "c4db57042f560c839662ea97c808b7ee06b55f504807e6fb54f484cff398e9c4",
        "run_receipt_sha256": "d1b6dd27587d1dc2f0f3851ad923387c0e55addd37d58894d0840b7ba85dd473",
        "private_score_sha256": "145f43b9b9750478ead4a3b66810ca1a180da3e1fa310b5bd117250f3164715f",
        "result": "default20-cap6 hybrid 190/196; 393/403; MRR@10 0.8557458698",
    },
    "B": {
        "root": str(pathlib.Path(args.private_b_root).resolve()),
        "freeze_sha256": "f754c8c29c54bc80f4d44d498a8a52e0495b034d69d8af7569bba615010f6769",
        "run_receipt_sha256": "50056d930a42a9ceffcec6554bcbfc6d76743432897731435d3cd0f64b28cf02",
        "private_score_sha256": "d036b3ce0a8975cb03d2aedab42cd41144db3f1ee002cf21637cfae52c9127f6",
        "result": "recall20-cap6 hybrid 191/196; 394/403; MRR@10 0.8674744898",
    },
}

for reference in private.values():
    root = pathlib.Path(reference["root"])
    assert sha(root / "freeze.json") == reference["freeze_sha256"]
    assert sha(root / "run-receipt.json") == reference["run_receipt_sha256"]
    assert sha(root / "private-score.json") == reference["private_score_sha256"]
for reference in private.values():
    reference["verified_sha256"] = True

analysis = {
    "status": "complete",
    "scope": "public full two-arm cap6; old 331 opened sample separated from remaining diagnostic questions",
    "source_freeze_sha256": sha(OUT / "freeze.json"),
    "score_sha256": sha(OUT / "public-score.json"),
    "old_sample_freeze_sha256": sha(
        PUBLIC / "analysis/minisearch-without-coverage-2026-09-21-v1/freeze.json"
    ),
    "fixed": {scope: load_fixed(scope) for scope in ["langchain", "godot", "du"]},
    "qasper": load_qasper(),
    "private_reference": private,
    "boundaries": [
        "Old 331 rows were already opened/tuned samples; they are not blind held-out evidence.",
        "Remaining 2976 questions are a full-cohort diagnostic slice, still evaluated on opened public data; no blind claim.",
        "QASPER source-cap counts are observed packing exclusions only; no candidate-pool claim is made.",
        "No product default, parameter arm, reranker, MMR, or new API call was added for diagnosis.",
    ],
}
target = OUT / "analysis"
target.mkdir(exist_ok=True)
(target / "public-full-analysis.json").write_text(
    json.dumps(analysis, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
)
print(json.dumps({"status": analysis["status"], "output": str(target / "public-full-analysis.json")}))
