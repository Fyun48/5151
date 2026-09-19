# OPS final-integration — suite mapping + self-review (PR #369)

CI authority: GitHub Actions run **35418839519 = SUCCESS** (head `ea08925…`), which runs the
full `npm test` = `test/*.test.js v3/test/*.test.js ops/test/*.test.js` (~277 files). Local
targeted runs are cited where they add signal.

## Scenario A–H (E2E lifecycle) — mapping

The eight original completion-gate scenarios (semantics unchanged) and their executable coverage:

| Scenario | Required semantics | Suite / test (green) |
|---|---|---|
| A | chained feedback→ingest→classify→cluster→impact→evaluate→proposal→Owner Gate#1→coding→PR→QA→staging→release request, stopping **before** real Production dispatch | `ops/test/scenario-e2e.test.js` (chain) + `qa.test.js`/`staging.test.js`/`release*.test.js` |
| B | Owner **reject** → archive, no coding/release, history retained | `ops/test/scenario-e2e.test.js` + `proposal.test.js` |
| C | Owner **requests changes** → reevaluation/revised proposal, old history preserved | `ops/test/reevaluation.test.js` + `scenario-e2e.test.js` |
| D | **cancellation race** — worker starts, Owner cancels, late result rejected | `ops/test/pack20-qa-cancel` … `pack26-runner-cancel` + `pack29-cancel-result` |
| E | **site exit** — Site A local op valid, OPS valid, Site B unaffected, no new delivery after exit | `ops/test/exit-drill.test.js` + `pack36-site-delivery.test.js` |
| F | **OPS outage** — public site search/login/listing still operate; feedback persists locally/outbox | `ops/test/feedback.test.js` (v3 outbox) + `ops/test/webhook.test.js` |
| G | **public-site outage** — OPS does not crash/fake success; retry/backoff; other sites unaffected | `ops/test/pack37-exit-retry.test.js` + `ingest.test.js` |
| H | **Production unknown state** — accepted dispatch + missing completion → `PRODUCTION_STATE_UNKNOWN`, next release blocked | `ops/test/pack34-unknown-confirm.test.js` + `scenario-e2e.test.js` |

Scenarios B/C/H are additionally pinned in `ops/test/scenario-e2e.test.js` with their negative assertions
(reject → no coding/release; request-changes → old proposal version preserved; unknown state → next release blocked).

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
