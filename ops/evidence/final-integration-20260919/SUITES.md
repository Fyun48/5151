# OPS final-integration — suite mapping + self-review (PR #369)

CI authority: GitHub Actions run **35418839519 = SUCCESS** (head `ea08925…`), which runs the
full `npm test` = `test/*.test.js v3/test/*.test.js ops/test/*.test.js` (~277 files). Local
targeted runs are cited where they add signal.

## Scenario A–H (E2E lifecycle) — mapping

The OPS lifecycle is covered end-to-end by the stack's own tests. The eight arcs below are the
integration's canonical flows; each is mapped to the green suite that exercises it.

| Scenario | Lifecycle arc | Suite (green) |
|---|---|---|
| A | Ingest feedback → cluster → issue candidate | `ops/test/ingest.test.js`, `clustering.test.js`, `analysis*.test.js` |
| B | Evaluate → propose → Owner Gate #1 approve | `ops/test/evaluation.test.js`, `proposal.test.js`, `proposal-api.test.js` |
| C | Approve development → coding → QA | `ops/test/coding.test.js`, `qa.test.js`, `qa-api.test.js` |
| D | QA PASS → staging → Gate #2 release candidate | `ops/test/staging.test.js`, `staging-api.test.js`, `release*.test.js` |
| E | Approve release → production release run (fail-closed) | `ops/test/production-release*.test.js` |
| F | Code rollback (exact previous stable, never silent DB restore) | `ops/test/pack27-code-rollback.test.js`, `pack28-db-restore.test.js` |
| G | Migration safety assessment (rollback/compat proof) | `ops/test/migration-safety.test.js`, `migration-safety-api.test.js` |
| H | Exit/retry + unknown-run reconciliation (idempotent) | `ops/test/pack37-exit-retry.test.js`, `exit-drill.test.js` |

Each arc also has its package-level regression tests (`pack8-live-contract` … `pack36-site-delivery`)
and the state-machine / canonical-state layer (`state-machine.test.js`, `canonical-state.test.js`).

## Concurrency / idempotency suite

- `ops/test/canonical-state.test.js` + `state-machine.test.js` — optimistic-lock versioning,
  idempotency-key dedup, append-only transitions (local **75/75 green** with the security set).
- `ops/test/production-release.test.js` — "concurrent execute on a non-deduplicating provider
  dispatches each workflow once", "worker restart after claimed dispatch binds by idempotency and
  never re-dispatches" (CI green).
- `ops/test/pack37-exit-retry.test.js` — exit/retry idempotency.

## Security suite

- Auth / identity: `ops/test/auth.test.js`
- Ingest secret + signature verification: `ops/test/ingest-signature.test.js`
- Outbound webhook (SSRF-class safety): `ops/test/webhook.test.js`
- Upload (attachment size/type/path): `ops/test/attachments.test.js`, `attachments-api.test.js`
- Prompt / instruction-source boundary (prompt-injection): `ops/test/instruction-source.test.js`
- Secrets never leak from production-release evidence: `ops/test/production-release-api.test.js`
  ("production-release read APIs require owner auth and do not leak secrets"; CI green).

Local run of the non-fixture security + concurrency files: **75 tests / 75 pass / 0 fail**.

## OPS_SCHEMA_VERSION + migration

The OPS DB is versioned per-entity plus explicit evidence/policy schema versions, and ships an
idempotent migration layer (no `PRAGMA user_version` gap):

- `ops/src/proposalSchema.js` → `PROPOSAL_SCHEMA_VERSION = "proposal-schema-v1"`
- `ops/src/qa/migrationEvidence.js` → `MIGRATION_EVIDENCE_SCHEMA_VERSION = "migration-evidence-v1"`
- `ops/src/release/migrationSafetyPolicy.js` → `ROLLBACK_PROOF_SCHEMA_VERSION` /
  `COMPAT_PROOF_SCHEMA_VERSION`
- `ops/src/exitDrill.js` → `HANDOFF_SCHEMA` (handoff export schema_version)
- `production_stable_current.schema_compat` + `static_tree_hash` (rollback contract; `compatible`
  vs incompatible is checked by `exitDrill.schemaLooksIncompatible`)
- `ops/src/opsDb.js` migration functions `upgradeExitDrill`, `upgradeProductionReleaseImmutability`,
  `upgradeProductIsolation`, `upgradeCrmReplica`, `upgradeMigrationSafetyImmutability` use
  `CREATE TABLE IF NOT EXISTS` + `addIfMissing` (`PRAGMA table_info` column check + `ALTER TABLE`)
  + `ON CONFLICT DO NOTHING`, i.e. idempotent and safe to re-run on an old DB.

Migration tests: `ops/test/migration-safety.test.js` + `migration-safety-api.test.js`
(immutable assessment, rollback/compat proof binding, schema_compat gating; CI green).

## Integration self-review

- **Duplicate routes = 0**: `v3/src/server.js` registers 288 routes, 0 duplicates (the OPS CRM /
  feedback / pHash routes are registered exactly once; no route is double-registered by the
  stack + master merge).
- **Duplicate migrations = 0 (harmful)**: 57 tables / 30 triggers; the 6 tables that appear in two
  `CREATE TABLE IF NOT EXISTS` sites are idempotent upgrade re-declarations (not double-applied
  migrations) — verified they differ only by `IF NOT EXISTS` and column-add idempotence.
- **Auto-Production trigger = 0**: `deploy-v3.yml`, `build-production-image.yml` (name: "no deploy"),
  and `migrate-v3-data-volume.yml` are all `workflow_dispatch` (manual) and gate on a
  `confirmation` input that must equal exactly `DEPLOY-PRODUCTION` / `PREDEPLOY-PRODUCTION` else
  fail. No `push:`/`schedule:` auto-trigger to Production exists in the integrated tree.
