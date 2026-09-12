"""Exercise authorization and remote isolation before touching production."""
import base64
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
REMOTE = ROOT / '.github/scripts/production-support-remote.sh'
SOURCE = 'a' * 40
TREE = 'b' * 64


class SupportSafeguards(unittest.TestCase):
    def test_actual_workflow_authorization(self):
        workflow = (ROOT / '.github/workflows/production-support-check.yml').read_text()
        block = workflow.split('        run: |\n', 1)[1].split('\n      - uses:', 1)[0]
        script = '\n'.join(line[10:] for line in block.splitlines())
        env = dict(os.environ, GITHUB_REPOSITORY='Fyun48/5151', GITHUB_EVENT_NAME='workflow_dispatch',
                   GITHUB_REF='refs/heads/master', ALLOWED_ACTOR='owner', GITHUB_ACTOR='owner',
                   GITHUB_TRIGGERING_ACTOR='owner', CONFIRMATION='VERIFY-V3-SUPPORT',
                   SOURCE_SHA=SOURCE, ACCOUNT_HASH=TREE)
        self.assertEqual(subprocess.run(['bash', '-c', script], env=env).returncode, 0)
        for patch in [{'GITHUB_REF': 'refs/heads/other'}, {'GITHUB_ACTOR': 'outsider'},
                      {'GITHUB_TRIGGERING_ACTOR': 'outsider'}, {'CONFIRMATION': 'wrong'},
                      {'ACCOUNT_HASH': 'x;echo unsafe'}, {'SOURCE_SHA': 'master'},
                      {'GITHUB_EVENT_NAME': 'push'}, {'GITHUB_REPOSITORY': 'other/repo'},
                      {'ALLOWED_ACTOR': ''}]:
            with self.subTest(patch=patch):
                self.assertNotEqual(subprocess.run(['bash', '-c', script], env={**env, **patch}).returncode, 0)
        self.assertEqual(subprocess.run(['bash', '-c', script], env={**env, 'GITHUB_ACTOR': 'cursor',
                         'GITHUB_TRIGGERING_ACTOR': 'cursor[bot]'}).returncode, 0)

    def test_remote_isolation_and_source_mismatch(self):
        with tempfile.TemporaryDirectory(prefix='support-test-') as directory:
            root = Path(directory)
            live = root / 'live'
            live.mkdir()
            database = live / 'v3.db'
            con = sqlite3.connect(database)
            con.execute('CREATE TABLE sentinel(value TEXT)')
            con.execute("INSERT INTO sentinel VALUES ('unchanged')")
            con.commit()
            con.close()
            before = database.read_bytes()
            commands = root / 'commands.jsonl'
            docker = root / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
a = sys.argv[1:]
with open(os.environ['COMMANDS'], 'a') as out: out.write(json.dumps(a) + '\\n')
if a[0] == 'inspect':
    fmt = a[2]
    print('running' if 'State.Status' in fmt else 'ghcr.io/fyun48/5151@sha256:' + 'c'*64 if 'Config.Image' in fmt else os.environ['LIVE'] if 'Mounts' in fmt else 'sha256:' + 'd'*64)
elif a[:2] == ['image', 'inspect']:
    print(os.environ['SOURCE'] if 'revision' in a[3] else 'https://github.com/Fyun48/5151')
elif a[0] == 'exec':
    sys.stdin.read()
    if a[-1] == 'source-hash': print(os.environ['ACTUAL_TREE'])
    elif a[-1] == 'rakuya-response': print('{"http_status":403,"code":"FETCH_BLOCKED"}')
    else: raise SystemExit('Unexpected production execution')
elif a[0] == 'cp':
    assert a[1] == '591-tracker-v3:/app/src'
    pathlib.Path(a[2]).mkdir()
elif a[0] == 'run':
    assert a[a.index('--network') + 1] == 'none' and '--read-only' in a
    assert a[-1] == 'snapshot' and '-p' not in a and '--env-file' not in a
    mounts = [a[i+1] for i, value in enumerate(a) if value == '--mount']
    assert len(mounts) == 2 and all(os.environ['LIVE'] not in value for value in mounts)
    assert any('dst=/snapshot' in value for value in mounts)
    assert any('dst=/app/src,readonly' in value for value in mounts)
    sys.stdin.read()
    print('{"http_measured":false,"network":"none"}')
elif a[0] == 'rm':
    assert a[-1].startswith('v3-support-v3-support.')
else: raise SystemExit('Unexpected Docker mutation')
''')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       SOURCE=SOURCE, ACTUAL_TREE=TREE, LIVE=str(live), COMMANDS=str(commands))
            args = ['bash', str(REMOTE), SOURCE, TREE, 'e' * 64, base64.b64encode(b'// helper').decode()]
            failed = subprocess.run(args, env={**env, 'ACTUAL_TREE': 'f' * 64}, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn('source differs', failed.stderr)
            calls = [json.loads(line) for line in commands.read_text().splitlines()]
            self.assertFalse(any(call[0] in ('run', 'cp') for call in calls))
            commands.write_text('')
            done = subprocess.run(args, env=env, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            result = json.loads(done.stdout)
            self.assertEqual(result['snapshot']['network'], 'none')
            self.assertEqual(database.read_bytes(), before)
            calls = [json.loads(line) for line in commands.read_text().splitlines()]
            self.assertEqual(sum(call[0] == 'run' for call in calls), 1)
            self.assertEqual(sum(call[-1] == 'rakuya-response' for call in calls), 1)


if __name__ == '__main__':
    unittest.main()
