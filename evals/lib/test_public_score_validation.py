import unittest
from public_score_validation import unique_rows, fixed_run, validate_per_question

class RunValidationTest(unittest.TestCase):
    def test_duplicate_cannot_hide_complete_id_set(self):
        with self.assertRaisesRegex(AssertionError, "Duplicate"):
            unique_rows([{"id":"a"},{"id":"b"},{"id":"a"}], {"a","b"})
    def test_missing_rejected(self):
        with self.assertRaisesRegex(AssertionError, "Missing"):
            unique_rows([{"id":"a"}], {"a","b"})
    def test_rank_export_rejects_unknown_duplicate_and_reordering(self):
        row={"id":"q","rrf_k":30,"rankings":[{"id":"d","rank":1,"rank_score":1,"rrf_score":0.2}]}
        self.assertEqual(fixed_run([row],{"q"},{"d"},30),{"q":{"d":1}})
        with self.assertRaisesRegex(AssertionError,"Unknown"):
            fixed_run([row],{"q"},{"other"},30)
        row["rankings"]*=2
        with self.assertRaisesRegex(AssertionError,"Duplicate ranked"):
            fixed_run([row],{"q"},{"d"},30)
        row["rankings"]=row["rankings"][:1]
        row["rankings"][0]["rank_score"]=4
        with self.assertRaisesRegex(AssertionError,"order"):
            fixed_run([row],{"q"},{"d"},30)

    def test_per_question_ids_and_aggregate_are_bound(self):
        good={"a":{"ndcg_cut_10":1.0},"b":{"ndcg_cut_10":0.0}}
        validate_per_question(good,["a","b"],{"ndcg_cut_10":0.5},["ndcg_cut_10"])
        with self.assertRaisesRegex(AssertionError,"Per-question IDs"):
            validate_per_question({"a":good["a"]},["a","b"],{"ndcg_cut_10":0.5},["ndcg_cut_10"])
        with self.assertRaisesRegex(AssertionError,"Aggregate mismatch"):
            validate_per_question(good,["a","b"],{"ndcg_cut_10":0.8},["ndcg_cut_10"])
        with self.assertRaisesRegex(AssertionError,"Invalid per-question"):
            validate_per_question({"a":{"ndcg_cut_10":float("nan")}},["a"],{"ndcg_cut_10":0},["ndcg_cut_10"])


    def test_lane_projection_preserves_original_order_and_empty_lane(self):
        from public_lane_projection import lane_ids
        row={"candidates":{"dense":2,"bm25":0},"rankings":[{"id":"b","dense_rank":2,"bm25_rank":None},{"id":"a","dense_rank":1,"bm25_rank":None}]}
        self.assertEqual(lane_ids(row,"dense"),["a","b"])
        self.assertEqual(lane_ids(row,"bm25"),[])

    def test_lane_projection_rejects_gaps_duplicates_missing_and_boolean_rank(self):
        from public_lane_projection import lane_ids
        import copy
        row={"candidates":{"dense":2},"rankings":[{"id":"a","dense_rank":1},{"id":"b","dense_rank":2}]}
        bad=copy.deepcopy(row);bad["rankings"][1]["dense_rank"]=3
        with self.assertRaisesRegex(AssertionError,"Non-contiguous"):lane_ids(bad,"dense")
        bad=copy.deepcopy(row);bad["rankings"][1]["id"]="a"
        with self.assertRaisesRegex(AssertionError,"Duplicate"):lane_ids(bad,"dense")
        bad=copy.deepcopy(row);bad["rankings"].pop()
        with self.assertRaisesRegex(AssertionError,"Missing"):lane_ids(bad,"dense")
        bad=copy.deepcopy(row);bad["rankings"][0]["dense_rank"]=True
        with self.assertRaisesRegex(AssertionError,"type"):lane_ids(bad,"dense")

if __name__ == "__main__":
    unittest.main()
