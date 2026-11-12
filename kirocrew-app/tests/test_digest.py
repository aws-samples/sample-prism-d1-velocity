import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import digest  # noqa: E402

TODAY = "2026-11-12"


def finding(sev="high", file="src/a.ts", rule="SQL injection", branch="main", commit="abcdef1234567", message="bad thing"):
    return {"severity": sev, "category": "security", "rule": rule, "file": file, "line": 3,
            "message": message, "branch": branch, "commit": commit, "tool": "kiro", "started_at": "2026-11-12T08:00:00Z"}


def payload(findings=None, cost=1.0, machine=None, repo_setup="ok"):
    return {
        "schema": "prism.dashboard.v2",
        "repos": [{"name": "demo", "label": "demo", "path": "/somewhere/demo",
                   "codewatch": {"findings": findings or []}, "setup": {"status": repo_setup}}],
        "machine": {"setup": machine if machine is not None else [
            {"id": "gitleaks", "label": "gitleaks", "status": "ok"},
            {"id": "codeburn", "label": "codeburn", "status": "ok"}]},
        "usage": {"status": "ok", "currency": "USD", "today": {"cost": cost, "calls": 1, "sessions": 1}},
    }


def baseline(p, threshold=None):
    _, state = digest.evaluate(None, p, threshold, TODAY)
    return state


class EvaluateTest(unittest.TestCase):
    def test_first_run_saves_baseline_only(self):
        msg, state = digest.evaluate(None, payload([finding()]), None, TODAY)
        self.assertIsNone(msg)
        self.assertEqual(state["highs"], {"demo": ["main|src/a.ts|SQL injection"]})
        self.assertEqual(state["setup"]["machine:gitleaks"], "ok")

    def test_no_change_no_notification(self):
        p = payload([finding()])
        msg, _ = digest.evaluate(baseline(p), copy.deepcopy(p), None, TODAY)
        self.assertIsNone(msg)

    def test_new_high_finding(self):
        prev = baseline(payload([finding()]))
        cur = payload([finding(), finding(file="src/b.ts", rule="Command injection", commit="1234567890abc",
                                          message="line one\n`rm -rf ~` \x1b[31mred " + "x" * 300)])
        msg, state = digest.evaluate(prev, cur, None, TODAY)
        self.assertIn("demo: 1 new high finding (review of 1234567 on main)", msg)
        self.assertNotIn("\n`", msg)  # finding text stays on one line
        self.assertNotIn("\x1b", msg)
        first_line = [l for l in msg.splitlines() if l.startswith("- demo")][0]
        self.assertTrue(first_line.endswith("…"))
        self.assertNotIn("/somewhere", msg)  # repo names, not paths
        self.assertEqual(len(state["highs"]["demo"]), 2)

    def test_new_highs_on_two_branches_get_a_line_each(self):
        prev = baseline(payload([]))
        cur = payload([finding(branch="main", commit="aaaaaaa1"), finding(branch="dev", commit="bbbbbbb2")])
        msg, _ = digest.evaluate(prev, cur, None, TODAY)
        self.assertIn("demo: 1 new high finding (review of aaaaaaa on main)", msg)
        self.assertIn("demo: 1 new high finding (review of bbbbbbb on dev)", msg)

    def test_same_issue_on_a_later_commit_is_not_new(self):
        prev = baseline(payload([finding(commit="aaa")]))
        msg, _ = digest.evaluate(prev, payload([finding(commit="bbb")]), None, TODAY)
        self.assertIsNone(msg)

    def test_medium_finding_is_quiet(self):
        prev = baseline(payload([]))
        msg, _ = digest.evaluate(prev, payload([finding(sev="medium")]), None, TODAY)
        self.assertIsNone(msg)

    def test_repo_without_a_name_is_skipped(self):
        p = payload([finding()])
        p["repos"][0]["label"] = p["repos"][0]["name"] = ""
        msg, _ = digest.evaluate(baseline(p), p, None, TODAY)
        self.assertIsNone(msg)

    def test_spend_threshold_once_per_day(self):
        prev = baseline(payload(cost=1.0))
        msg, state = digest.evaluate(prev, payload(cost=12.5), 10.0, TODAY)
        self.assertIn("AI spend today is 12.50 USD, above your threshold of 10.00 USD", msg)
        self.assertEqual(state["spendAlertDate"], TODAY)
        again, _ = digest.evaluate(state, payload(cost=15.0), 10.0, TODAY)
        self.assertIsNone(again)
        nextday, _ = digest.evaluate(state, payload(cost=15.0), 10.0, "2026-11-13")
        self.assertIn("AI spend today", nextday)

    def test_spend_threshold_off_by_default(self):
        prev = baseline(payload(cost=1.0))
        msg, _ = digest.evaluate(prev, payload(cost=999.0), None, TODAY)
        self.assertIsNone(msg)
        self.assertIsNone(digest.spend_threshold({}))
        self.assertIsNone(digest.spend_threshold({"spendThreshold": 0}))
        self.assertIsNone(digest.spend_threshold({"spendThreshold": True}))
        self.assertEqual(digest.spend_threshold({"spendThreshold": 5}), 5.0)

    def test_setup_regression(self):
        prev = baseline(payload())
        cur = payload(machine=[{"id": "gitleaks", "label": "gitleaks", "status": "missing"},
                               {"id": "codeburn", "label": "codeburn", "status": "ok"}], repo_setup="warn")
        msg, _ = digest.evaluate(prev, cur, None, TODAY)
        self.assertIn("Setup: gitleaks went from ok to missing.", msg)
        self.assertIn("Setup: codewatch in demo went from ok to warn.", msg)

    def test_setup_not_ok_before_is_quiet(self):
        prev = baseline(payload(repo_setup="missing"))
        msg, _ = digest.evaluate(prev, payload(repo_setup="missing"), None, TODAY)
        self.assertIsNone(msg)


class StateFileTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_first_run_then_quiet(self):
        p = payload([finding()])
        self.assertEqual(digest.digest_once(self.dir, p), (None, True))
        self.assertEqual(digest.digest_once(self.dir, p), (None, False))

    def test_corrupt_state_rebuilds_baseline(self):
        (self.dir / digest.STATE_FILE).write_text("{not json", encoding="utf-8")
        msg, baseline_only = digest.digest_once(self.dir, payload([finding()]))
        self.assertIsNone(msg)
        self.assertTrue(baseline_only)
        state = json.loads((self.dir / digest.STATE_FILE).read_text(encoding="utf-8"))
        self.assertEqual(state["schema"], digest.STATE_SCHEMA)

    def test_wrong_shape_state_rebuilds_baseline(self):
        (self.dir / digest.STATE_FILE).write_text('{"schema": 1, "highs": []}', encoding="utf-8")
        self.assertEqual(digest.digest_once(self.dir, payload([finding()])), (None, True))

    def test_failed_delivery_keeps_old_state(self):
        digest.digest_once(self.dir, payload([]))
        def fail(_msg):
            raise RuntimeError("notify() failed")
        with self.assertRaises(RuntimeError):
            digest.digest_once(self.dir, payload([finding()]), deliver=fail)
        sent = []
        msg, _ = digest.digest_once(self.dir, payload([finding()]), deliver=sent.append)
        self.assertIn("1 new high finding", msg)
        self.assertEqual(sent, [msg])

    def test_last_run_and_notification_recorded(self):
        digest.digest_once(self.dir, payload([]))
        state = json.loads((self.dir / digest.STATE_FILE).read_text(encoding="utf-8"))
        self.assertTrue(state["lastRunAt"])
        self.assertIsNone(state["lastNotifiedAt"])
        msg, _ = digest.digest_once(self.dir, payload([finding()]), deliver=lambda m: None)
        state = json.loads((self.dir / digest.STATE_FILE).read_text(encoding="utf-8"))
        self.assertEqual(state["lastMessage"], msg)
        self.assertTrue(state["lastNotifiedAt"])
        digest.digest_once(self.dir, payload([finding()]))  # quiet run keeps the last notification
        self.assertEqual(json.loads((self.dir / digest.STATE_FILE).read_text(encoding="utf-8"))["lastMessage"], msg)

    def test_threshold_read_from_config(self):
        (self.dir / "config.json").write_text('{"spendThreshold": 2}', encoding="utf-8")
        digest.digest_once(self.dir, payload(cost=1.0))
        msg, _ = digest.digest_once(self.dir, payload(cost=3.0))
        self.assertIn("above your threshold of 2.00", msg)


if __name__ == "__main__":
    unittest.main()
