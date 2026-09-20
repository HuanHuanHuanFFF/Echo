"""Recover a complete single-lane order from a frozen hybrid candidate union."""
def lane_ids(row, lane):
    assert lane in {"dense", "bm25"}
    expected = row["candidates"][lane]
    assert type(expected) is int and 0 <= expected <= 60, "Invalid lane count"
    ranked = [x for x in row["rankings"] if x.get(lane + "_rank") is not None]
    assert len(ranked) == expected, "Missing lane candidates"
    assert len({x["id"] for x in ranked}) == len(ranked), "Duplicate lane document"
    ranks = [x[lane + "_rank"] for x in ranked]
    assert all(type(x) is int for x in ranks), "Invalid lane rank type"
    assert sorted(ranks) == list(range(1, expected + 1)), "Non-contiguous lane ranks"
    return [x["id"] for x in sorted(ranked, key=lambda x: x[lane + "_rank"])]
