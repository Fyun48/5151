# OPS final-integration evidence — PR #369

Local, non-Production evidence for the ChatGPT completion gates on #369. Nothing here
deploys, changes a Production flag, writes to Production data, or opens an outbound
Production path.

## 1. Performance benchmark (`bench.mjs` → `bench.json` / `bench.md`)

In-memory SQLite (`node:sqlite`), seeded only. Scales 100 / 1k / 10k rows. Measures the
integration-critical OPS DB paths with p50 / p95 / max over iterations, SQL-statement count
per call (via a `db.prepare` counting wrapper), and `EXPLAIN QUERY PLAN` (SEARCH vs SCAN)
for every read path:

- canonical `issue_proposal_current → issue_proposal` pointer lookup (`getCurrentIssueProposal`)
- `state_entity` read / find by id (`getEntity`, `findEntity`)
- state-machine idempotency-key dedup (`state_transition.idempotency_key` UNIQUE)
- hash-chained audit append + range read (`appendAuditRow`, `listAudit`)
- production-stable identity idempotent upsert (`seedProductionStable`) — rollback contract
- rollback-contract describe (`describeRollbackIdentityRecord`, pure)

Headline: canonical proposal lookup ~0.085 ms p50 (index SEARCH), idempotency dedup ~0.005 ms
(UNIQUE SEARCH), state entity read ~0.006 ms. EXPLAIN: 15 read-path/scale observations — 12 are
index SEARCH with no SCAN node; 3 contain a SCAN node (the `audit_log ORDER BY id DESC LIMIT 200`
range read, which is bounded by LIMIT and runs ~0.15 ms at 20k rows). Full table in `bench.md`.

Run: `node ops/evidence/final-integration-20260919/bench.mjs`

Product paths added (the required set): `ingestFeedback` (feedback ingestion), `listPendingWork`
(pending queue), `listIssuesWithLifecycle` (cluster list), `listCrmViews` (CRM list), `getDashboard`
(dashboard), `listAudit` (audit timeline), `listProducts` (multi-site overview).

Findings — fixed in this PR, before → after (10k scale):
- CRM list (`listCrmViews`): **50,001 queries / ~497 ms** → **6 queries / ~0.67 ms** (batched cases/notes/todos/owner/module/fb/progress; added LIMIT pagination).
- dashboard (`getDashboard`): **~8.5 s** (O(N²) correlated-EXISTS lifecycle scan) → **~8 ms** (de-correlated single `IN` subquery).
- cluster list (`listIssuesWithLifecycle`): **401 queries / ~1.8 ms** → **6 queries / ~0.26 ms** (batched entity/impact/eval/member/product lookups).

The benchmark reports p50/p95/max + query count + EXPLAIN for each path at 100/1k/10k.


## 2. Responsive + focus evidence (`capture-ops-admin.mjs` → `ops-responsive.json`, `shots/`)

Drives a LOCAL v3 server (same integrated code as deployed) with headless Chrome over CDP.
Captures the three OPS admin surfaces at 375 / 768 / 1440:

- `admin-crm` (`#crm`, `crmContactForm`)
- `admin-similarity` (`#similarity`, `phashForm`)
- `admin-feedback-inbox` (`#feedback/inbox`, `opsOutboxCompact`)

Per surface×width it records horizontal overflow, `<44px` touch targets (checkbox/radio measured
by their 44px wrapping label per WCAG 2.5.8 AA), unnamed controls (accessible name resolved as
aria-label → aria-labelledby → label[for] → wrapping label → title → text → placeholder), and a
Tab-walk focus check (per stop: `:focus-visible` outline/box-shadow + accessible name + visible).

Result: **9 / 9 surface-width observations pass** — 0 overflow, 0 small targets, 0 unnamed
controls, 0 focus failures (logged in as the owner).

Run (server must be started with the same `SESSION_SECRET`):
```
AUTH_EMAIL=owner@evidence.test AUTH_PASSWORD=<>=8 chars> SESSION_SECRET=<secret> \
  DATA_DIR=<tmp> PORT=5199 node v3/src/server.js &
EVIDENCE_BASE_URL=http://127.0.0.1:5199 AUTH_EMAIL=owner@evidence.test \
  AUTH_PASSWORD=<pw> SESSION_SECRET=<secret> \
  node ops/evidence/final-integration-20260919/capture-ops-admin.mjs
```

## 3. A11y fixes this pass made (not waived)

The first capture found real issues on the newly ported OPS panels; they are fixed at the
producer in `v3/public/admin.html`:

- CRM search field was `min-width: 560px` (horizontal overflow 243px at 375px) → now
  `min-width: 0; flex: 1 1 240px` with `@media (min-width:700px){ min-width:560px }`.
- pHash checkbox rows → `ops-check` (44px min-height label target).
