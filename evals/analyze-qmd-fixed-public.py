import json
import pathlib
import random
import statistics
import sys

scope = sys.argv[1]
assert scope in {"langchain", "godot"}
comparison = pathlib.Path(sys.argv[2]).resolve()
public = pathlib.Path(sys.argv[3]).resolve()
qmd = pathlib.Path(sys.argv[4]).resolve()


def rows(file):
    with file.open(encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def read_json(file):
    return json.loads(file.read_text(encoding="utf-8"))


def paired(left, right, seed):
    ids = sorted(left)
    assert ids == sorted(right)
    delta = [left[qid] - right[qid] for qid in ids]
    rng = random.Random(seed)
    draws = []
    for _ in range(10000):
        draws.append(statistics.mean(delta[rng.randrange(len(delta))] for _ in delta))
    ordered = sorted(draws)
    return {
        "left_minus_right": statistics.mean(delta),
        "bootstrap_ci95": [ordered[249], ordered[9749]],
        "wins": sum(value > 1e-12 for value in delta),
        "losses": sum(value < -1e-12 for value in delta),
        "ties": sum(abs(value) <= 1e-12 for value in delta),
    }


preparation = read_json(qmd / "public-preparation.json")
questions = list(rows(comparison / "corpus-v1" / f"{scope}-queries.jsonl"))
question_ids = sorted(str(row["id"]) for row in questions)
gold_queries = {
    str(row["query_id"]): row
    for row in rows(public / "data" / f"freshstack-{scope}-queries.jsonl")
}
assert sorted(gold_queries) == question_ids
run_dir = qmd / "runs-public"
qmd_modes = {
    mode: read_json(run_dir / mode / f"{scope}.score.json")
    for mode in ("no-rerank", "default")
}
qmd_runs = {
    mode: {
        row["id"]: row
        for row in rows(run_dir / mode / f"{scope}.jsonl")
    }
    for mode in ("no-rerank", "default")
}
echo_per = read_json(
    comparison / "scores" / "echo" / f"{scope}-official-per-query.json"
)
echo_run = {
    row["id"]: row
    for row in rows(comparison / "runs" / "echo" / f"{scope}.jsonl")
}
assert sorted(qmd_modes["default"]["per_question"]) == question_ids
assert sorted(echo_per) == question_ids
assert sorted(echo_run) == question_ids

nuggets = {}
mapping = {}
for qid, question in gold_queries.items():
    mapping[qid] = []
    for nugget in question["nuggets"]:
        nid = str(nugget["_id"])
        mapping[qid].append(nid)
        relevant = set(str(doc) for doc in nugget["relevant_corpus_ids"])
        nuggets[nid] = relevant


def coverage20(rankings, qid):
    top = {str(row["id"]) for row in rankings[:20]}
    return statistics.mean(
        bool(top.intersection(nuggets[nid])) for nid in mapping[qid]
    )


echo_coverage20 = {
    qid: coverage20(
        sorted(echo_run[qid]["rankings"], key=lambda row: row["rank"]), qid
    )
    for qid in question_ids
}
qmd_per = {
    mode: result["per_question"] for mode, result in qmd_modes.items()
}
qmd_metric_names = {
    "alpha-nDCG@10": "alpha-nDCG@10",
    "nDCG@10": "ndcg_cut_10",
    "Coverage@20": "Coverage@20",
    "Recall@10": "recall_10",
    "Recall@50": "recall_50",
    "MRR@10": "recip_rank",
}
echo_metric_names = {
    "alpha-nDCG@10": "alpha-nDCG@10",
    "nDCG@10": "nDCG@10",
    "Coverage@20": None,
    "Recall@10": "Recall@10",
    "Recall@50": "Recall@50",
    "MRR@10": "MRR@10",
}

comparisons = {"rerank_vs_no_rerank": {}, "qmd_default_vs_echo": {}}
for metric, qmd_key in qmd_metric_names.items():
    comparisons["rerank_vs_no_rerank"][metric] = paired(
        {qid: qmd_per["default"][qid][qmd_key] for qid in question_ids},
        {qid: qmd_per["no-rerank"][qid][qmd_key] for qid in question_ids},
        20260926,
    )
    echo_key = echo_metric_names[metric]
    echo_values = (
        echo_coverage20
        if echo_key is None
        else {qid: echo_per[qid][echo_key] for qid in question_ids}
    )
    comparisons["qmd_default_vs_echo"][metric] = paired(
        {qid: qmd_per["default"][qid][qmd_key] for qid in question_ids},
        echo_values,
        20260926,
    )

diagnostics = {}
for mode in ("no-rerank", "default"):
    per = qmd_per[mode]
    rankings = qmd_runs[mode]
    diagnostics[mode] = {
        "query_errors": sum(per[qid]["native_error"] for qid in question_ids),
        "zero_results": sum(not rankings[qid]["rankings"] for qid in question_ids),
        "no_relevant_unit_in_top50": sum(per[qid]["recall_50"] == 0 for qid in question_ids),
        "relevant_unit_only_at_11_to_50": sum(
            per[qid]["recall_50"] > 0 and per[qid]["recip_rank"] == 0
            for qid in question_ids
        ),
        "rerank_changed_top10_order": None,
        "rerank_changed_top10_members": None,
    }
no_rerank_top10 = {
    qid: [row["id"] for row in qmd_runs["no-rerank"][qid]["rankings"][:10]]
    for qid in question_ids
}
default_top10 = {
    qid: [row["id"] for row in qmd_runs["default"][qid]["rankings"][:10]]
    for qid in question_ids
}
for mode in diagnostics:
    diagnostics[mode]["rerank_changed_top10_order"] = sum(
        no_rerank_top10[qid] != default_top10[qid] for qid in question_ids
    )
    diagnostics[mode]["rerank_changed_top10_members"] = sum(
        set(no_rerank_top10[qid]) != set(default_top10[qid]) for qid in question_ids
    )

echo_ids = {qid: set(row["id"] for row in echo_run[qid]["rankings"][:50]) for qid in question_ids}
qmd_ids = {
    mode: {
        qid: set(row["id"] for row in qmd_runs[mode][qid]["rankings"][:50])
        for qid in question_ids
    }
    for mode in ("no-rerank", "default")
}
diagnostics["candidate_pool_vs_echo"] = {
    mode: {
        "qmd_only_top50": sum(bool(qmd_ids[mode][qid] - echo_ids[qid]) for qid in question_ids),
        "echo_only_top50": sum(bool(echo_ids[qid] - qmd_ids[mode][qid]) for qid in question_ids),
        "same_top50_set": sum(qmd_ids[mode][qid] == echo_ids[qid] for qid in question_ids),
    }
    for mode in ("no-rerank", "default")
}

output = {
    "schema": "echo-qmd-public-fixed-analysis-v1",
    "scope": scope,
    "questions": len(question_ids),
    "corpus_manifest_sha256": preparation["corpus_manifest_sha256"],
    "bootstrap": {"unit": "query", "iterations": 10000, "seed": 20260926},
    "comparisons": comparisons,
    "diagnostics": diagnostics,
}
out = run_dir / f"{scope}.paired-analysis.json"
out.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
print(json.dumps(output, indent=2))
