# OPS final-integration seeded benchmark — PR #369

node v24.13.0 / win32 x64; in-memory SQLite; generated 2026-09-19T05:02:26.561Z

## scale 100 rows

| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |
|---|---|---|---|---|---|---|---|---|
| SELECT * FROM issue_proposal_current WHERE issue_id = ? | 0.102 | 0.462 | 0.462 | 0.125 | 20 | 8 | 1 | 0 |
| SELECT * FROM state_entity WHERE id = ? | 0.007 | 0.028 | 0.028 | 0.009 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1 | 0.006 | 0.015 | 0.015 | 0.007 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_transition WHERE idempotency_key = ? | 0.006 | 0.022 | 0.022 | 0.008 | 20 | 1 | 1 | 0 |
| SELECT * FROM audit_log ORDER BY id DESC LIMIT 200 | 0.159 | 1.722 | 1.722 | 0.255 | 20 | 2 | 0 | 1 |
| seedProductionStable (idempotent upsert) | 0.042 | 0.232 | 0.232 | 0.057 | 12 | 2 | - | - |
| describeRollbackIdentityRecord (pure) | 0.004 | 0.099 | 0.099 | 0.008 | 20 | 0 | - | - |
| ingestFeedback (write) | 0.085 | 0.39 | 0.39 | 0.109 | 12 | 6 | - | - |
| SELECT * FROM feedback_analysis WHERE status IN ('pending','failed_retry','processing') | 0.52 | 1.174 | 1.174 | 0.73 | 3 | 39 | 1 | 0 |
| SELECT * FROM issue_candidate ORDER BY id DESC LIMIT 80 | 0.267 | 0.831 | 0.831 | 0.304 | 20 | 6 | 0 | 1 |
| SELECT * FROM ingested_crm_contact ORDER BY id DESC | 1.049 | 1.049 | 1.049 | 0.871 | 2 | 6 | 0 | 1 |
| SELECT COUNT(*) FROM ingested_feedback | 0.245 | 0.717 | 0.717 | 0.399 | 3 | 7 | 0 | 1 |
| SELECT * FROM ops_product ORDER BY id | 0.042 | 0.197 | 0.197 | 0.052 | 20 | 3 | 0 | 1 |

row counts: issue_candidate=100, issue_proposal=100, issue_proposal_current=100, state_entity=100, state_transition=100, audit_log=200, production_stable_current=1

## scale 1000 rows

| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |
|---|---|---|---|---|---|---|---|---|
| SELECT * FROM issue_proposal_current WHERE issue_id = ? | 0.088 | 0.173 | 0.173 | 0.093 | 20 | 8 | 1 | 0 |
| SELECT * FROM state_entity WHERE id = ? | 0.006 | 0.025 | 0.025 | 0.007 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1 | 0.006 | 0.011 | 0.011 | 0.006 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_transition WHERE idempotency_key = ? | 0.005 | 0.03 | 0.03 | 0.007 | 20 | 1 | 1 | 0 |
| SELECT * FROM audit_log ORDER BY id DESC LIMIT 200 | 0.147 | 0.552 | 0.552 | 0.168 | 20 | 2 | 0 | 1 |
| seedProductionStable (idempotent upsert) | 0.025 | 0.067 | 0.067 | 0.03 | 12 | 2 | - | - |
| describeRollbackIdentityRecord (pure) | 0 | 0.004 | 0.004 | 0.001 | 20 | 0 | - | - |
| ingestFeedback (write) | 0.059 | 0.098 | 0.098 | 0.062 | 12 | 6 | - | - |
| SELECT * FROM feedback_analysis WHERE status IN ('pending','failed_retry','processing') | 1.335 | 1.421 | 1.421 | 1.298 | 3 | 39 | 1 | 0 |
| SELECT * FROM issue_candidate ORDER BY id DESC LIMIT 80 | 0.247 | 0.305 | 0.305 | 0.252 | 20 | 6 | 0 | 1 |
| SELECT * FROM ingested_crm_contact ORDER BY id DESC | 1.331 | 1.331 | 1.331 | 1.038 | 2 | 6 | 0 | 1 |
| SELECT COUNT(*) FROM ingested_feedback | 0.763 | 0.861 | 0.861 | 0.777 | 3 | 7 | 0 | 1 |
| SELECT * FROM ops_product ORDER BY id | 0.037 | 0.066 | 0.066 | 0.04 | 20 | 3 | 0 | 1 |

row counts: issue_candidate=1000, issue_proposal=1000, issue_proposal_current=1000, state_entity=1000, state_transition=1000, audit_log=2000, production_stable_current=1

## scale 10000 rows

| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |
|---|---|---|---|---|---|---|---|---|
| SELECT * FROM issue_proposal_current WHERE issue_id = ? | 0.078 | 0.157 | 0.157 | 0.086 | 20 | 8 | 1 | 0 |
| SELECT * FROM state_entity WHERE id = ? | 0.007 | 0.021 | 0.021 | 0.008 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1 | 0.006 | 0.013 | 0.013 | 0.007 | 20 | 1 | 1 | 0 |
| SELECT * FROM state_transition WHERE idempotency_key = ? | 0.005 | 0.009 | 0.009 | 0.006 | 20 | 1 | 1 | 0 |
| SELECT * FROM audit_log ORDER BY id DESC LIMIT 200 | 0.179 | 0.582 | 0.582 | 0.217 | 20 | 2 | 0 | 1 |
| seedProductionStable (idempotent upsert) | 0.025 | 0.092 | 0.092 | 0.032 | 12 | 2 | - | - |
| describeRollbackIdentityRecord (pure) | 0 | 0.004 | 0.004 | 0.001 | 20 | 0 | - | - |
| ingestFeedback (write) | 0.054 | 0.109 | 0.109 | 0.06 | 12 | 6 | - | - |
| SELECT * FROM feedback_analysis WHERE status IN ('pending','failed_retry','processing') | 9.196 | 9.232 | 9.232 | 9.026 | 3 | 39 | 1 | 0 |
| SELECT * FROM issue_candidate ORDER BY id DESC LIMIT 80 | 0.26 | 0.501 | 0.501 | 0.284 | 20 | 6 | 0 | 1 |
| SELECT * FROM ingested_crm_contact ORDER BY id DESC | 0.667 | 0.667 | 0.667 | 0.635 | 2 | 6 | 0 | 1 |
| SELECT COUNT(*) FROM ingested_feedback | 7.989 | 8.591 | 8.591 | 8.104 | 3 | 7 | 0 | 1 |
| SELECT * FROM ops_product ORDER BY id | 0.038 | 0.074 | 0.074 | 0.04 | 20 | 3 | 0 | 1 |

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
