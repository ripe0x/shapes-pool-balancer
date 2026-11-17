#!/usr/bin/env python3
"""Check the emitted Solidity report and its existing shared reader, without signing or external services."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
READER = Path.home() / ".agents/guidance/asset-flow-kit/asset_gate.py"
spec = importlib.util.spec_from_file_location("asset_gate", READER)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class FlowReportingTests(unittest.TestCase):
    def setUp(self):
        self.report = json.loads((ROOT / "test/fixtures/flow-reporting.json").read_text())

    def check_report(self, report, metric="buckets.withdrawable", maximum=10**16):
        with tempfile.TemporaryDirectory(prefix="flow-reporting-") as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            (root / "source.txt").write_text("report fixture\n")
            subprocess.run(["git", "-C", directory, "add", "source.txt"], check=True)
            config = {"source_paths": ["source.txt"], "required_regimes": ["flow-reporting"],
                      "scorecard_dir": "scorecards", "drift_groups": [["flow-reporting"]],
                      "outcomes": [{"id": "R", "text": "report bound", "metric": metric, "max_wei": maximum}]}
            (root / "asset-flow.json").write_text(json.dumps(config))
            report = copy.deepcopy(report)
            report["source_hash"] = gate.src_hash(directory, config)
            report["reached"] = {"reported": 1}
            (root / "scorecards").mkdir()
            (root / "scorecards/flow-reporting.json").write_text(json.dumps(report))
            return gate.check(directory, "asset-flow.json", run=False)

    def test_unknown_is_null_and_not_a_numeric_metric(self):
        unknown = self.report["buckets"][0]
        self.assertEqual(unknown["held"], "200000000000000000")
        self.assertIsNone(unknown["need"])
        self.assertIsNone(unknown["above_need"])
        self.assertIsNone(unknown["bps"])
        self.assertNotIn("buckets.unknown", gate.metrics(self.report))
        self.assertNotIn("buckets.unknown", gate.weis(self.report))

    def test_known_backing_shortfall_and_withdrawable_amounts(self):
        amounts = gate.weis(self.report)
        self.assertEqual(amounts["buckets.backing"], 0)
        self.assertEqual(amounts["buckets.shortfall"], 0)
        self.assertEqual(amounts["buckets.withdrawable"], 10**16)
        self.assertEqual(amounts["buckets.known excess"], 10**16)

    def test_unknown_unbounded_bucket_does_not_break_known_outcome(self):
        incomplete, failures, *_ = self.check_report(self.report)
        self.assertEqual(incomplete, ["approval: hash absent or does not match the approved settings"])
        self.assertEqual(failures, [])

    def test_unknown_bound_is_incomplete_instead_of_zero_or_pass(self):
        incomplete, failures, *_ = self.check_report(self.report, "buckets.unknown", 0)
        self.assertTrue(any("metric buckets.unknown not found" in problem for problem in incomplete))
        self.assertEqual(failures, [])

    def test_known_outcome_still_fails_its_bound(self):
        _, failures, *_ = self.check_report(self.report, maximum=10**16 - 1)
        self.assertTrue(any("out of bounds" in problem for problem in failures))

    def test_inconsistent_null_excess_is_incomplete(self):
        for field, value in [("bps", 0), ("need", "0"), ("above_need", "0")]:
            with self.subTest(field=field):
                report = copy.deepcopy(self.report)
                report["buckets"][0][field] = value
                incomplete, *_ = self.check_report(report)
                self.assertTrue(any("inconsistent unknown need/excess" in problem for problem in incomplete))

    def test_legacy_numeric_reports_remain_readable(self):
        report = {"buckets": [{"name": "legacy", "need": None, "above_need": "100", "bps": 100}]}
        self.assertEqual(gate.weis(report), {"buckets.legacy": 100})
        self.assertEqual(gate.metrics(report), {"buckets.legacy": 100})


if __name__ == "__main__":
    unittest.main(verbosity=2)
