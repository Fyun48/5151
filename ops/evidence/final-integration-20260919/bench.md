# OPS final-integration seeded benchmark — PR #369

node v24.13.0 / win32 x64; in-memory SQLite; generated 2026-09-19T04:21:10.972Z

## scale 100 rows

| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |
|---|---|---|---|---|---|---|---|---|
| SELECT * FROM issue_proposal_current WHERE issue_id = ? | 0.121 | 0.459 | 0.459 | 0.146 | 20 | 8 | 1 | 0 |
| SELECT * FROM state_entity WHERE id = ? | 0.007 | 0.023 | 0.023 | 0.008 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1 | 0.007 | 0.041 | 0.041 | 0.01 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_transition WHERE idempotency_key = ? | 0.006 | 0.015 | 0.015 | 0.007 | 20 | 1 | 1 | 0 |
| SELECT * FROM audit_log ORDER BY id DESC LIMIT 200 | 0.161 | 1.573 | 1.573 | 0.233 | 20 | 2 | 0 | 1 |
| seedProductionStable (idempotent upsert) | 0.045 | 0.228 | 0.228 | 0.058 | 12 | 2 | - | - |
| describeRollbackIdentityRecord (pure) | 0.004 | 0.098 | 0.098 | 0.008 | 20 | 0 | - | - |
| ingestFeedback (write) | 0.089 | 0.4 | 0.4 | 0.114 | 12 | 6 | - | - |
| SELECT * FROM feedback_analysis WHERE status IN ('pending','failed_retry','processing') | 0.491 | 1.154 | 1.154 | 0.71 | 3 | 39 | 1 | 0 |
| SELECT * FROM issue_candidate ORDER BY id DESC LIMIT 80 | 2.017 | 4.504 | 4.504 | 2.198 | 20 | 401 | 0 | 1 |
| SELECT * FROM ingested_crm_contact ORDER BY id DESC | 4.465 | 4.465 | 4.465 | 4.123 | 2 | 501 | 0 | 1 |
| SELECT COUNT(*) FROM ingested_feedback | 1.014 | 1.365 | 1.365 | 1.122 | 3 | 7 | 0 | 1 |
| SELECT * FROM ops_product ORDER BY id | 0.051 | 0.211 | 0.211 | 0.058 | 20 | 3 | 0 | 1 |

row counts: issue_candidate=100, issue_proposal=100, issue_proposal_current=100, state_entity=100, state_transition=100, audit_log=200, production_stable_current=1

## scale 1000 rows

| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |
|---|---|---|---|---|---|---|---|---|
| SELECT * FROM issue_proposal_current WHERE issue_id = ? | 0.092 | 0.156 | 0.156 | 0.094 | 20 | 8 | 1 | 0 |
| SELECT * FROM state_entity WHERE id = ? | 0.007 | 0.022 | 0.022 | 0.008 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1 | 0.006 | 0.012 | 0.012 | 0.007 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_transition WHERE idempotency_key = ? | 0.005 | 0.029 | 0.029 | 0.008 | 20 | 1 | 1 | 0 |
| SELECT * FROM audit_log ORDER BY id DESC LIMIT 200 | 0.15 | 0.781 | 0.781 | 0.185 | 20 | 2 | 0 | 1 |
| seedProductionStable (idempotent upsert) | 0.029 | 0.093 | 0.093 | 0.034 | 12 | 2 | - | - |
| describeRollbackIdentityRecord (pure) | 0 | 0.005 | 0.005 | 0.001 | 20 | 0 | - | - |
| ingestFeedback (write) | 0.063 | 0.112 | 0.112 | 0.067 | 12 | 6 | - | - |
| SELECT * FROM feedback_analysis WHERE status IN ('pending','failed_retry','processing') | 1.158 | 1.427 | 1.427 | 1.239 | 3 | 39 | 1 | 0 |
| SELECT * FROM issue_candidate ORDER BY id DESC LIMIT 80 | 1.796 | 4.265 | 4.265 | 1.935 | 20 | 401 | 0 | 1 |
| SELECT * FROM ingested_crm_contact ORDER BY id DESC | 47.92 | 47.92 | 47.92 | 43.237 | 2 | 5001 | 0 | 1 |
| SELECT COUNT(*) FROM ingested_feedback | 85.833 | 87.155 | 87.155 | 85.904 | 3 | 7 | 0 | 1 |
| SELECT * FROM ops_product ORDER BY id | 0.041 | 0.086 | 0.086 | 0.045 | 20 | 3 | 0 | 1 |

row counts: issue_candidate=1000, issue_proposal=1000, issue_proposal_current=1000, state_entity=1000, state_transition=1000, audit_log=2000, production_stable_current=1

## scale 10000 rows

| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |
|---|---|---|---|---|---|---|---|---|
| SELECT * FROM issue_proposal_current WHERE issue_id = ? | 0.075 | 0.153 | 0.153 | 0.081 | 20 | 8 | 1 | 0 |
| SELECT * FROM state_entity WHERE id = ? | 0.007 | 0.025 | 0.025 | 0.008 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1 | 0.006 | 0.015 | 0.015 | 0.007 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_transition WHERE idempotency_key = ? | 0.005 | 0.015 | 0.015 | 0.006 | 20 | 1 | 1 | 0 |
| SELECT * FROM audit_log ORDER BY id DESC LIMIT 200 | 0.147 | 0.461 | 0.461 | 0.167 | 20 | 2 | 0 | 1 |
| seedProductionStable (idempotent upsert) | 0.025 | 0.087 | 0.087 | 0.031 | 12 | 2 | - | - |
| describeRollbackIdentityRecord (pure) | 0.001 | 0.005 | 0.005 | 0.001 | 20 | 0 | - | - |
| ingestFeedback (write) | 0.055 | 0.103 | 0.103 | 0.061 | 12 | 6 | - | - |
| SELECT * FROM feedback_analysis WHERE status IN ('pending','failed_retry','processing') | 9.156 | 9.513 | 9.513 | 9.08 | 3 | 39 | 1 | 0 |
| SELECT * FROM issue_candidate ORDER BY id DESC LIMIT 80 | 1.821 | 2.958 | 2.958 | 1.895 | 20 | 401 | 0 | 1 |
| SELECT * FROM ingested_crm_contact ORDER BY id DESC | 496.926 | 496.926 | 496.926 | 455.484 | 2 | 50001 | 0 | 1 |
| SELECT COUNT(*) FROM ingested_feedback | 8508.394 | 8533.491 | 8533.491 | 8492.316 | 3 | 7 | 0 | 1 |
| SELECT * FROM ops_product ORDER BY id | 0.043 | 0.106 | 0.106 | 0.047 | 20 | 3 | 0 | 1 |

row counts: issue_candidate=10000, issue_proposal=10000, issue_proposal_current=10000, state_entity=10000, state_transition=10000, audit_log=20000, production_stable_current=1

## EXPLAIN QUERY PLAN summary

30 read-path/scale observations: 15 are index SEARCH with no SCAN node, 15 contain a SCAN node.

- `SEARCH issue_proposal_current USING INTEGER PRIMARY KEY (rowid=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX sqlite_autoindex_state_entity_1 (id=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX idx_state_entity_type (entity_type=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_transition USING INDEX sqlite_autoindex_state_transition_1 (idempotency_key=?)` — SEARCH 1 / SCAN 0
- `SCAN audit_log` — SEARCH 0 / SCAN 1
- `SEARCH feedback_analysis USING INDEX idx_analysis_status (status=?)` — SEARCH 1 / SCAN 0
- `SCAN issue_candidate` — SEARCH 0 / SCAN 1
- `SCAN ingested_crm_contact` — SEARCH 0 / SCAN 1
- `SCAN ingested_feedback USING COVERING INDEX idx_ingested_product` — SEARCH 0 / SCAN 1
- `SCAN ops_product USING INDEX sqlite_autoindex_ops_product_1` — SEARCH 0 / SCAN 1
- `SEARCH issue_proposal_current USING INTEGER PRIMARY KEY (rowid=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX sqlite_autoindex_state_entity_1 (id=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX idx_state_entity_type (entity_type=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_transition USING INDEX sqlite_autoindex_state_transition_1 (idempotency_key=?)` — SEARCH 1 / SCAN 0
- `SCAN audit_log` — SEARCH 0 / SCAN 1
- `SEARCH feedback_analysis USING INDEX idx_analysis_status (status=?)` — SEARCH 1 / SCAN 0
- `SCAN issue_candidate` — SEARCH 0 / SCAN 1
- `SCAN ingested_crm_contact` — SEARCH 0 / SCAN 1
- `SCAN ingested_feedback USING COVERING INDEX idx_ingested_product` — SEARCH 0 / SCAN 1
- `SCAN ops_product USING INDEX sqlite_autoindex_ops_product_1` — SEARCH 0 / SCAN 1
- `SEARCH issue_proposal_current USING INTEGER PRIMARY KEY (rowid=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX sqlite_autoindex_state_entity_1 (id=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX idx_state_entity_type (entity_type=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_transition USING INDEX sqlite_autoindex_state_transition_1 (idempotency_key=?)` — SEARCH 1 / SCAN 0
- `SCAN audit_log` — SEARCH 0 / SCAN 1
- `SEARCH feedback_analysis USING INDEX idx_analysis_status (status=?)` — SEARCH 1 / SCAN 0
- `SCAN issue_candidate` — SEARCH 0 / SCAN 1
- `SCAN ingested_crm_contact` — SEARCH 0 / SCAN 1
- `SCAN ingested_feedback USING COVERING INDEX idx_ingested_product` — SEARCH 0 / SCAN 1
- `SCAN ops_product USING INDEX sqlite_autoindex_ops_product_1` — SEARCH 0 / SCAN 1
