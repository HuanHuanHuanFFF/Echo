"""Strict run validation used before official score adapters build dictionaries."""
import math

def unique_rows(records, expected, id_field="id"):
    records = list(records)
    ids = [row[id_field] for row in records]
    assert len(ids) == len(set(ids)), "Duplicate result/query ID"
    assert len(ids) == len(expected) and set(ids) == set(expected), "Missing or unexpected query ID"
    return records

def fixed_run(records, expected, corpus_ids, rrf_k):
    records = unique_rows(records, expected)
    result = {}
    for row in records:
        assert row["rrf_k"] == rrf_k, "Wrong RRF condition"
        rankings = row["rankings"]
        ids = [x["id"] for x in rankings]
        assert len(ids) == len(set(ids)), "Duplicate ranked document ID"
        assert set(ids) <= corpus_ids, "Unknown ranked document ID"
        for i, item in enumerate(rankings):
            assert item["rank"] == i+1, "Non-sequential rank"
            assert item["rank_score"] == len(rankings)-i, "Rank export changed candidate order"
            assert math.isfinite(item["rrf_score"]), "Invalid RRF score"
        result[row["id"]] = {x["id"]: x["rank_score"] for x in rankings}
    return result
