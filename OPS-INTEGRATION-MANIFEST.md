# OPS Integration Manifest (final integration, current master baseline)

- Generated: 2026-09-19T03:05:15.694Z
- Baseline master: `450c07a0885fcbcebbb1e8d8d7a875689b2112d8`
- Integration branch: `cursor/ops-final-integration` (cut from current master, then the linear stack tip was merged in)
- Stack tip: `cursor/ops-exit-retry-ed3f` (contains Packages 0-37)
- Open OPS PRs: 35; cursor/ops-* branches: 60 (25 without an open PR)

## Strategy

1. Not by hard-merging the oldest PR: the integration branch was cut from current master.
2. The OPS PRs form a linear stack (each base is the previous head; ahead grows 24 -> 82), so merging the stack tip covers Packages 0-37.
3. After the merge, 192 files / +24529 lines applied automatically and 15 files conflicted.
4. Every conflict was resolved as: keep current master's architecture, re-apply only the OPS wiring still needed.
5. Superseded OPS implementations (older v3 admin/nav/docs) were deliberately NOT restored.

## Conflict resolution record

| File | Resolution | Why |
|---|---|---|
| `.env.example` | master | OPS copy described the retired a5151/b5151/c5151 hosts |
| `.github/workflows/test.yml` | master | OPS copy was the older auto-merge test policy |
| `AGENTS.md` | master | OPS copy described retired v1/v2 and old tunnel names |
| `README.md` | master | same |
| `design-system/property-platform/pages/admin.md` | master | older admin IA |
| `v3/ARCHITECTURE.md` | master | older version string (3.51 vs 3.57) |
| `test/deploy-safety.test.js` | master | older packages: write policy |
| `test/v2-compose.test.js` | master | older v1/v2 assertions |
| `v3/public/admin.html` | master | OPS copy is the older static-nav admin; master already has AdminIA + feedback/crm panels |
| `v3/test/admin-nav.test.js` | master | matches current AdminIA admin |
| `v3/src/server.js` | merged | keeps master workers, adds OPS startCrmDeliveryLoop wiring |
| `v3/src/client591.js` | merged | keeps master crawl watchdog imports, adds OPS provider import |
| `package.json` | merged | keeps master test script, adds pack:kit |
| `test/v3-compose.test.js` | merged | keeps master assertions, adds OPS console (5154) service checks |
| `casaos-compose.yml` | merged | keeps master description plus an OPS container note |

## Open OPS PR mapping

| PR | Package | head branch | ahead | behind | status |
|---|---|---|---|---|---|
| #242 | 0-3 | `cursor/ops-complete-ed3f` | 24 | 133 | integrated via stack tip |
| #249 | 4 | `cursor/ops-crm-ed3f` | 33 | 133 | integrated via stack tip |
| #251 | 5 | `cursor/ops-staging-ed3f` | 40 | 133 | integrated via stack tip |
| #258 | 6 | `cursor/ops-budget-ed3f` | 42 | 133 | integrated via stack tip |
| #259 | 7 | `cursor/ops-phash-ed3f` | 44 | 133 | integrated via stack tip |
| #260 | 8 | `cursor/ops-live-ed3f` | 46 | 133 | integrated via stack tip |
| #261 | 9 | `cursor/ops-design-ed3f` | 47 | 133 | integrated via stack tip |
| #262 | 10 | `cursor/ops-remote-cs-ed3f` | 48 | 133 | integrated via stack tip |
| #263 | 11 | `cursor/ops-insight-ed3f` | 50 | 133 | integrated via stack tip |
| #264 | 12 | `cursor/ops-stats-ed3f` | 51 | 133 | integrated via stack tip |
| #265 | 13 | `cursor/ops-stale-gen-ed3f` | 52 | 133 | integrated via stack tip |
| #266 | 14 | `cursor/ops-late-ai-ed3f` | 53 | 133 | integrated via stack tip |
| #267 | 15 | `cursor/ops-coding-gen-ed3f` | 54 | 133 | integrated via stack tip |
| #268 | 16 | `cursor/ops-stage-gen-ed3f` | 55 | 133 | integrated via stack tip |
| #269 | 17 | `cursor/ops-handoff-unknown-ed3f` | 56 | 133 | integrated via stack tip |
| #270 | 18 | `cursor/ops-reeval-gen-ed3f` | 57 | 133 | integrated via stack tip |
| #271 | 19 | `cursor/ops-cmd-gen-ed3f` | 58 | 133 | integrated via stack tip |
| #272 | 20 | `cursor/ops-qa-cancel-ed3f` | 60 | 133 | integrated via stack tip |
| #273 | 21 | `cursor/ops-cmd-cancel-ed3f` | 61 | 133 | integrated via stack tip |
| #285 | 22 | `cursor/ops-eval-cancel-ed3f` | 62 | 133 | integrated via stack tip |
| #287 | 23 | `cursor/ops-notify-cancel-ed3f` | 63 | 133 | integrated via stack tip |
| #291 | 24 | `cursor/ops-dev-cancel-ed3f` | 65 | 133 | integrated via stack tip |
| #292 | 25 | `cursor/ops-prod-cancel-ed3f` | 66 | 133 | integrated via stack tip |
| #295 | 26 | `cursor/ops-runner-cancel-ed3f` | 67 | 133 | integrated via stack tip |
| #296 | 27 | `cursor/ops-code-rollback-ed3f` | 68 | 133 | integrated via stack tip |
| #297 | 28 | `cursor/ops-db-restore-ed3f` | 71 | 133 | integrated via stack tip |
| #298 | 29 | `cursor/ops-cancel-result-ed3f` | 72 | 133 | integrated via stack tip |
| #299 | 30 | `cursor/ops-rollback-record-ed3f` | 73 | 133 | integrated via stack tip |
| #300 | 31 | `cursor/ops-gate2-pending-ed3f` | 74 | 133 | integrated via stack tip |
| #302 | 32 | `cursor/ops-gate1-pending-ed3f` | 75 | 133 | integrated via stack tip |
| #303 | 33 | `cursor/ops-reeval-pending-ed3f` | 76 | 133 | integrated via stack tip |
| #304 | 34 | `cursor/ops-unknown-confirm-ed3f` | 77 | 133 | integrated via stack tip |
| #305 | 35 | `cursor/ops-cmd-apply-ed3f` | 79 | 133 | integrated via stack tip |
| #311 | 36 | `cursor/ops-delivery-confirm-ed3f` | 81 | 133 | integrated via stack tip |
| #312 | 37 | `cursor/ops-exit-retry-ed3f` | 82 | 133 | integrated via stack tip |

## cursor/ops-* branches without an open PR (25)

- `cursor/ops-build-reuse-digest-pipefail-fix-39d3` @ 11ff3d27f8
- `cursor/ops-ci-fast-tests-39d3` @ 8ec7e8d0af
- `cursor/ops-deploy-v3-remote-syntax-fix-39d3` @ 43d5e17de6
- `cursor/ops-deploy-v3-ssh-case-39d3` @ d955e93d5d
- `cursor/ops-existing-candidate-adoption-0ca3` @ 4fddfc6e17
- `cursor/ops-phase1-foundation-b879` @ baa2b97ba7
- `cursor/ops-phase10-coding-task-b879` @ 5ea782705b
- `cursor/ops-phase11-independent-qa-b879` @ 3421eab0a4
- `cursor/ops-phase12-isolated-staging-b879` @ 71a280488d
- `cursor/ops-phase13-release-gate2-b879` @ 88b3ed9292
- `cursor/ops-phase14-db-migration-safety-bae1` @ f3bad0075e
- `cursor/ops-phase15-production-release-rollback-949c` @ 847d04d557
- `cursor/ops-phase2-async-ingestion-b879` @ fa8f5b20f2
- `cursor/ops-phase3-5-deploy-safety-b879` @ 688170b6cd
- `cursor/ops-phase3-attachments-b879` @ 969c7d5694
- `cursor/ops-phase4-ai-classification-b879` @ e695b7e49f
- `cursor/ops-phase5-clustering-b879` @ aa9da8e9c5
- `cursor/ops-phase6-impact-b879` @ dc9903fa8f
- `cursor/ops-phase7-evaluation-b879` @ 50519a2816
- `cursor/ops-phase8-proposal-gate-b879` @ 510c3c7100
- `cursor/ops-phase9-reevaluation-b879` @ bcde759f46
- `cursor/ops-predeploy-backup-verify-39d3` @ 4743d80014
- `cursor/ops-predeploy-backup-verify-node18-fix-39d3` @ 7f626aa630
- `cursor/ops-predeploy-smoke-sql-fix-39d3` @ f7e76a43ee
- `cursor/ops-v3-digest-deploy-39d3` @ 43cb0d4f8b

## Not done (must not be treated as complete)

- Scenario A-H end-to-end tests, UI 375/768/1440 verification, performance benchmarks, dedicated security suite and OPS_SCHEMA_VERSION migration tests are NOT implemented in this branch.
- The 35 open OPS PRs are not closed or superseded yet; that decision is left to the final review.
