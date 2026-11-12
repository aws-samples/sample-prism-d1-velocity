import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import page_model as pm  # noqa: E402

NOW = 1_763_000_000.0  # fixed clock for "ago"


def iso(seconds_ago):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW - seconds_ago))


def repo(name, last_run_ago=None, findings=0, review_id=None):
    path = f"/home/someone/src/{name}"
    found = [{"severity": "high" if i == 0 else "low", "file": f"src/f{i}.ts", "line": i + 1, "message": f"msg {i}\nsecond line",
              "branch": "main", "started_at": iso(100 + i)} for i in range(findings)]
    cw = {"hasResults": last_run_ago is not None, "lastRunAt": iso(last_run_ago) if last_run_ago is not None else None,
          "findings": found, "lastReviewId": review_id,
          "scans": [{"id": review_id, "started_at": iso(50), "branch": "feat/x"}] if review_id else [],
          "latestByBranch": [{"branch": "feat/x", "review": {"started_at": iso(50), "commit": "abcdef1234567890"}}] if review_id else []}
    row = {"name": name, "label": name, "path": path, "high": 1 if findings else 0, "medium": 0, "low": max(0, findings - 1),
           "lastRunAt": cw["lastRunAt"], "lastReviewId": review_id}
    return {"name": name, "label": name, "path": path, "codewatch": cw}, row


def payload(*repos):
    return {
        "schema": "prism.dashboard.v2", "generated_at": iso(0),
        "repos": [r for r, _ in repos],
        "overview": {"counts": {"repos": 40, "codewatch": len(repos)}, "codewatch": [row for _, row in repos],
                     "setup": [{"path": r["path"], "status": "ok"} for r, _ in repos]},
        "machine": {"setup": [{"id": "gitleaks", "label": "gitleaks available", "status": "missing", "detail": "not on PATH", "fix": "brew install gitleaks"}],
                    "codeburnSync": {"mode": "team"}},
        "summary": {"warnings": {"count": 1, "first": "gitleaks missing"}, "spend": {"currency": "USD"}},
        "usage": {"status": "ok", "currency": "USD", "today": {"cost": 1.5, "calls": 1, "sessions": 2},
                  "month": {"cost": 20, "calls": 10, "sessions": 5, "from": "2026-11-01", "to": "2026-11-12"},
                  "topModels": [{"name": "model-a", "cost": 3, "calls": 4}],
                  "topProjects": [{"name": "/home/someone/src/secret-project", "path": "/home/someone/src/secret-project", "cost": 2, "sessions": 1}],
                  "updatedAt": iso(60), "stale": False},
    }


class ReposTest(unittest.TestCase):
    def test_sort_by_last_commit_then_review_time(self):
        a, b, c, d = repo("a", 500), repo("b", 100), repo("c", 50), repo("d")
        p = payload(a, b, c, d)
        commits = {a[0]["path"]: {"at": iso(10), "sha": "aaa", "subject": "s"}, b[0]["path"]: None}
        names = [m["row"]["name"] for m in pm.machine_repos(p, commits)]
        # a: commit 10 s ago; c: review 50 s ago; b: git failed, review 100 s ago; d: nothing.
        self.assertEqual(names, ["a", "c", "b", "d"])

    def test_commit_lookup_cap_and_order(self):
        repos = [repo(f"r{i}", 1000 - i) for i in range(35)] + [repo("never")]
        paths = pm.commit_lookup_paths(payload(*repos))
        self.assertEqual(len(paths), pm.COMMIT_LOOKUP_MAX)
        self.assertTrue(paths[0].endswith("/r34"))  # newest review first
        self.assertFalse(any(p.endswith("/never") for p in paths))

    def test_findings_capped_with_more_line(self):
        model, _ = pm.build_model(payload(repo("big", 10, findings=25)), {}, "1.8.0", None)
        row = model["repos"][0]
        self.assertEqual(len(row["findings"]), pm.ROW_FINDINGS_MAX)
        self.assertIn("5 more findings not listed", row["more"])

    def test_parse_last_commit(self):
        self.assertEqual(pm.parse_last_commit("2026-11-12T10:00:00+00:00\0abc1234\0fix it\n"), {"at": "2026-11-12T10:00:00+00:00", "sha": "abc1234", "subject": "fix it"})
        self.assertIsNone(pm.parse_last_commit("not a date\0abc\0x"))
        self.assertIsNone(pm.parse_last_commit(""))


class ModelTest(unittest.TestCase):
    def test_model_from_fixture_has_no_paths_and_one_line_text(self):
        r = repo("demo", 30, findings=2, review_id="abc-123-pre-push-review")
        model, targets = pm.build_model(payload(r), {r[0]["path"]: {"at": iso(3600), "sha": "deadbee", "subject": "s\u202e evil"}}, "1.8.0",
                                        {"lastRunAt": iso(120), "lastNotifiedAt": iso(120), "lastMessage": "PRISM daily digest\n- demo: 1 new"})
        blob = json.dumps(model)
        self.assertNotIn("/home/someone", blob)
        self.assertEqual(model["topProjects"][0]["name"], "secret-project")
        self.assertEqual([c["title"] for c in model["cards"]], ["AI spend today", "AI spend this month", "Setup warnings", "Sync mode"])
        self.assertEqual(model["cards"][0]["value"], "$1.50")
        row = model["repos"][0]
        self.assertEqual(row["commit"], {"sha": "deadbee", "at": iso(3600), "subject": "s evil"})  # bidi override removed
        self.assertEqual(row["reviewAt"], iso(30))
        self.assertEqual(row["findings"][0]["message"], "msg 0 second line")
        self.assertEqual(row["findings"][0]["location"], "src/f0.ts:1")
        self.assertTrue(row["hasReport"])
        self.assertEqual(row["badge"], {"text": "1 high", "tone": "error"})
        self.assertEqual(row["tone"], "error")  # the left border agrees with the badge
        self.assertEqual(row["hooks"], "hooks on")
        self.assertEqual(model["checklist"][0]["fix"], "brew install gitleaks")
        self.assertEqual(model["digest"], {"recorded": True, "lastRunAt": iso(120), "lastNotifiedAt": iso(120), "lastMessage": "PRISM daily digest\n- demo: 1 new"})
        self.assertEqual(targets[0]["path"], r[0]["path"])

    def test_findings_badge_and_hooks_text(self):
        def row(last=True, high=0, med=0, low=0):
            return {"lastRunAt": iso(5) if last else None, "high": high, "medium": med, "low": low}
        self.assertEqual(pm.findings_badge(row(high=2, med=1)), {"text": "2 high", "tone": "error"})
        self.assertEqual(pm.findings_badge(row(med=3, low=1)), {"text": "3 med", "tone": "warn"})
        self.assertEqual(pm.findings_badge(row(low=4)), {"text": "4 low", "tone": "none"})
        self.assertEqual(pm.findings_badge(row()), {"text": "clean", "tone": "ok"})
        self.assertEqual(pm.findings_badge(row(last=False, high=9)), {"text": "no review", "tone": "none"})
        self.assertEqual([pm.hooks_text(s) for s in ("ok", "missing", "warn", None)], ["hooks on", "hooks off", "hooks warn", "hooks unknown"])

    def test_usage_not_ok(self):
        p = payload(repo("x", 1))
        p["usage"] = {"status": "not-installed", "message": "codeburn is not installed"}
        model, _ = pm.build_model(p, {}, "", None)
        self.assertEqual(model["cards"][0], {"title": "AI spend", "value": "not-installed", "detail": "codeburn is not installed"})
        self.assertEqual(model["version"], "unknown")


class IndexAndReportTest(unittest.TestCase):
    targets = [{"path": "/r/a", "name": "a", "commit": {"sha": "abc1234", "at": "", "subject": ""},
                "latest": {"id": "a1-pre-push-review", "branch": "feat/x", "commit": "abcdef1234567890"}},
               {"path": "/r/b", "name": "b", "commit": None, "latest": {"id": "../etc/passwd", "branch": None, "commit": None}}]

    def test_index_resolution_rejects_out_of_range_and_junk(self):
        self.assertIs(pm.target_for(self.targets, "1"), self.targets[1])
        for bad in ["2", "-1", "1.0", " 1", "1e2", "", None, 1, "9999999", "0x1"]:
            self.assertIsNone(pm.target_for(self.targets, bad), repr(bad))
        self.assertIsNone(pm.target_for([], "0"))

    def test_report_args_and_fallback(self):
        plan = pm.report_plan(self.targets[0], "/out/r.html")
        self.assertEqual(plan["primary"], ["codewatch", "report", "--repo", "/r/a", "--commit", "HEAD", "--format", "html", "--output", "/out/r.html"])
        self.assertEqual(plan["fallback"], ["codewatch", "report", "--repo", "/r/a", "--id", "a1-pre-push-review", "--format", "html", "--output", "/out/r.html"])
        self.assertIn("commit abc1234", plan["primaryNote"])
        self.assertIn("branch feat/x, commit abcdef123456", plan["fallbackNote"])
        # A review id that is not a result file name gets no fallback.
        self.assertIsNone(pm.report_plan(self.targets[1], "/out/r.html")["fallback"])

    def test_report_csp_is_inserted(self):
        self.assertIn(pm.REPORT_CSP, pm.with_report_csp("<html><head><title>x</title></head></html>").split("<title>")[0])
        self.assertTrue(pm.with_report_csp("<p>x</p>").startswith("<!DOCTYPE html><html><head><meta http-equiv"))
        # <header> is not <head>: no head means the document is wrapped, not patched inside the body.
        self.assertTrue(pm.with_report_csp("<header class=x>t</header>").startswith("<!DOCTYPE html><html><head><meta http-equiv"))
        self.assertNotIn("refresh", pm.with_report_csp('<html><head><META HTTP-EQUIV="Refresh" content="0;url=https://example.com"></head></html>'))

    def test_cleanup_reports_only_old_html(self):
        d = Path(tempfile.mkdtemp())
        old, new, other = d / "old.html", d / "new.html", d / "keep.txt"
        for f in (old, new, other):
            f.write_text("x", encoding="utf-8")
        past = time.time() - 2 * 24 * 3600
        os.utime(old, (past, past))
        os.utime(other, (past, past))
        self.assertEqual(pm.cleanup_reports(d), 1)
        self.assertFalse(old.exists())
        self.assertTrue(new.exists() and other.exists())
        self.assertEqual(pm.cleanup_reports(d / "missing"), 0)


class FilesTest(unittest.TestCase):
    def test_digest_state_read(self):
        d = Path(tempfile.mkdtemp())
        self.assertIsNone(pm.read_digest(d))
        self.assertEqual(pm.digest_view(None)["recorded"], False)
        (d / "digest-state.json").write_text("{broken", encoding="utf-8")
        self.assertIsNone(pm.read_digest(d))
        (d / "digest-state.json").write_text('{"schema": 1, "highs": {}, "setup": {}}', encoding="utf-8")
        # A v0.1 state file: recorded, but no run time.
        self.assertEqual(pm.digest_view(pm.read_digest(d)), {"recorded": True, "lastRunAt": "", "lastNotifiedAt": "", "lastMessage": ""})

    def test_usage_cached_today(self):
        home = Path(tempfile.mkdtemp())
        self.assertFalse(pm.usage_cached_today(home, "2026-11-12"))
        (home / ".prism" / "cache").mkdir(parents=True)
        f = home / ".prism" / "cache" / "usage.json"
        f.write_text(json.dumps({"schema": pm.USAGE_CACHE_SCHEMA, "day": "2026-11-11", "panel": {}}), encoding="utf-8")
        self.assertFalse(pm.usage_cached_today(home, "2026-11-12"))
        f.write_text(json.dumps({"schema": pm.USAGE_CACHE_SCHEMA, "day": "2026-11-12", "panel": {}}), encoding="utf-8")
        self.assertTrue(pm.usage_cached_today(home, "2026-11-12"))


if __name__ == "__main__":
    unittest.main()
