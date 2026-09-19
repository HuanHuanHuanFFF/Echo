import unittest
from public_score_validation import unique_rows, fixed_run

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

if __name__ == "__main__":
    unittest.main()
