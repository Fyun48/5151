"""Exercise collection gates without SSH, a production database, or network."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("evidence", ROOT / "write-rakuya-diagnostic-evidence.py")
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)
SOURCE = "a" * 40
SCRIPT_HASH = "b" * 64
IMAGE = "ghcr.io/fyun48/5151@sha256:" + "c" * 64


class AuthorizationTests(unittest.TestCase):
    def authorize(self, **overrides):
        workflow = (ROOT.parent / "workflows" / "production-rakuya-diagnostic.yml").read_text()
        gate = textwrap.dedent(workflow.split("        run: |\n", 1)[1].split("\n      - name:", 1)[0])
        env = dict(os.environ, GITHUB_REPOSITORY="Fyun48/5151", GITHUB_EVENT_NAME="workflow_dispatch",
                   GITHUB_REF="refs/heads/master", GITHUB_ACTOR="Fyun48", GITHUB_TRIGGERING_ACTOR="Fyun48",
                   ALLOWED_ACTOR="Fyun48", CONFIRMATION="DIAGNOSE-RAKUYA", SOURCE_SHA=SOURCE)
        env.update(overrides)
        return subprocess.run(["bash", "-c", gate], env=env, capture_output=True, timeout=5).returncode

    def test_owner_and_existing_cursor_actor_pairs_are_allowed(self):
        self.assertEqual(self.authorize(), 0)
        self.assertEqual(self.authorize(GITHUB_ACTOR="cursor", GITHUB_TRIGGERING_ACTOR="cursor[bot]"), 0)

    def test_ref_actor_rerun_confirmation_and_source_must_be_authorized(self):
        for overrides in ({"GITHUB_REF": "refs/heads/unreviewed"}, {"GITHUB_ACTOR": "other"},
                          {"GITHUB_TRIGGERING_ACTOR": "other"}, {"ALLOWED_ACTOR": ""},
                          {"GITHUB_EVENT_NAME": "push"}, {"GITHUB_REPOSITORY": "other/5151"},
                          {"CONFIRMATION": ""}, {"SOURCE_SHA": "master; exit 0"}):
            with self.subTest(overrides=overrides):
                self.assertNotEqual(self.authorize(**overrides), 0)


def payload():
    return {"source_sha": SOURCE, "image_ref": IMAGE, "diagnostic_script_sha256": SCRIPT_HASH,
            "diagnostic": {"checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                           "stored": {"rakuya": 0, "housefun": 2, "ddroom": 1},
                           "rakuya": {"url": "https://rent.rakuya.com.tw/result?city=0", "http_status": 403,
                                      "response_bytes": 123, "elapsed_ms": 50, "ok": False,
                                      "code": "FETCH_BLOCKED", "parsed_records": 0}}}


class EvidenceTests(unittest.TestCase):
    def test_block_is_preserved_and_extra_data_is_removed(self):
        raw = payload()
        raw["diagnostic"]["rakuya"]["message"] = "untrusted content"
        raw["diagnostic"]["listings"] = [{"private": "must not be collected"}]
        result = evidence.validate(raw, SOURCE, SCRIPT_HASH)
        self.assertFalse(result["diagnostic"]["rakuya"]["ok"])
        self.assertEqual(result["diagnostic"]["rakuya"]["code"], "FETCH_BLOCKED")
        self.assertNotIn("untrusted", json.dumps(result))
        self.assertNotIn("private", json.dumps(result))

    def test_rejects_mismatches_malformed_counts_and_wrong_target(self):
        alterations = [
            (("source_sha",), "d" * 40),
            (("diagnostic_script_sha256",), "e" * 64),
            (("image_ref",), "ghcr.io/fyun48/5151:latest"),
            (("diagnostic", "stored", "rakuya"), True),
            (("diagnostic", "rakuya", "url"), "https://other.example/"),
            (("diagnostic", "rakuya", "ok"), True),
            (("diagnostic", "checked_at"), "2020-01-01T00:00:00Z"),
        ]
        for keys, value in alterations:
            with self.subTest(keys=keys):
                raw = payload()
                parent = raw
                for key in keys[:-1]:
                    parent = parent[key]
                parent[keys[-1]] = value
                with self.assertRaises(ValueError):
                    evidence.validate(raw, SOURCE, SCRIPT_HASH)

    def test_success_requires_parsed_records_or_explicit_empty(self):
        raw = payload()
        raw["diagnostic"]["rakuya"].update(http_status=200, ok=True, code="SUCCESS", parsed_records=19)
        self.assertEqual(evidence.validate(raw, SOURCE, SCRIPT_HASH)["diagnostic"]["rakuya"]["parsed_records"], 19)
        raw["diagnostic"]["rakuya"].update(code="SUCCESS_EMPTY", parsed_records=0)
        self.assertTrue(evidence.validate(raw, SOURCE, SCRIPT_HASH)["diagnostic"]["rakuya"]["ok"])


class RemoteTests(unittest.TestCase):
    def run_remote(self, **overrides):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            docker = root / "docker"
            docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as out:
    out.write(json.dumps(args) + '\\n')
if args[:2] == ['inspect', '--format']:
    fmt = args[2]
    print({'{{.State.Status}}': os.environ['TEST_STATE'],
           '{{.Config.Image}}': os.environ['TEST_IMAGE'],
           '{{.Image}}': 'sha256:' + 'f' * 64}[fmt])
elif args[:3] == ['image', 'inspect', '--format']:
    print(os.environ['TEST_REVISION'] if 'revision' in args[3] else 'https://github.com/Fyun48/5151')
elif args[:5] == ['exec', '-w', '/app', '591-tracker-v3', 'node']:
    if args[5:] == ['src/diagnoseRakuya.js']:
        print(os.environ['TEST_DIAGNOSTIC'])
    elif args[5:7] == ['--input-type=module', '-e']:
        print(os.environ['TEST_SCRIPT_HASH'])
    else:
        raise SystemExit('Unexpected docker exec command')
else:
    raise SystemExit('Mutation or unexpected Docker command')
''')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ["PATH"], CALL_LOG=str(root / "calls"),
                       TEST_STATE="running", TEST_IMAGE=IMAGE, TEST_REVISION=SOURCE, TEST_SCRIPT_HASH=SCRIPT_HASH,
                       TEST_DIAGNOSTIC=json.dumps(payload()["diagnostic"]))
            env.update(overrides)
            result = subprocess.run(["bash", str(ROOT / "production-rakuya-remote.sh"), SOURCE, SCRIPT_HASH],
                                    env=env, capture_output=True, text=True, timeout=10)
            calls = [json.loads(line) for line in (root / "calls").read_text().splitlines()]
            diagnostic_calls = [call for call in calls if call[-1] == "src/diagnoseRakuya.js"]
            return result, diagnostic_calls

    def test_collects_one_diagnostic_without_mutating_docker_commands(self):
        result, calls = self.run_remote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 1)
        report = evidence.validate(json.loads(result.stdout), SOURCE, SCRIPT_HASH)
        self.assertEqual(report["diagnostic"]["rakuya"]["code"], "FETCH_BLOCKED")

    def test_stops_before_diagnostic_when_container_or_identity_is_wrong(self):
        for overrides in ({"TEST_STATE": "exited"}, {"TEST_IMAGE": "ghcr.io/fyun48/5151:latest"},
                          {"TEST_REVISION": "d" * 40}, {"TEST_SCRIPT_HASH": "e" * 64}):
            with self.subTest(overrides=overrides):
                result, calls = self.run_remote(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
