# Manual disposable CasaOS PR-B acceptance

This workflow uses the existing Cloudflare service token bridge and pinned ED25519 host key. It does not deploy the application or modify production databases. It runs the exact PR #497 source SHA's disposable runner on the existing CasaOS N3450 only, after verifying that SHA's required CI checks succeeded.

Run from master using the authorized production actor:

```bash
gh workflow run prb-nas-acceptance.yml --repo Fyun48/5151 --ref master \
  -f source_sha=4ee81e7495f63873e302a6451b1bdc51a46cca16 \
  -f confirmation=VERIFY-PRB-NAS
```

The production environment's existing approval rules apply. No credentials go into commands, logs or chat. Artifact `prb-nas-<full SHA>-<run ID>-<attempt>` contains the NAS evidence archive, exact source provenance, runner exit, cleanup results and SHA256SUMS. A hard performance gate failure makes the workflow fail after artifact upload; Owner's accepted performance exception does not rewrite the measured result. Inspect PG tests, errors, timeouts, result hashes and cleanup separately.

The NAS runner is detached with setsid/nohup so a dropped SSH connection does not trigger premature cleanup. Evidence remains under `/mnt/Storage1/prb-acceptance/evidence/prb-nas-<short SHA>-gha-<run ID>-<attempt>`. If collection times out, the detached run may still be active: inspect its retained runner log before retrying. The launcher refuses to start when labeled acceptance resources exist and never removes another run's resources. The workflow is not a restore or failover test, nor a production crawler throughput test.
