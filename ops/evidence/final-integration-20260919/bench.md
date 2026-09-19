# OPS final-integration seeded benchmark — PR #369

node v24.13.0 / win32 x64; in-memory SQLite; generated 2026-09-19T03:42:56.003Z

## scale 100 rows

| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |
|---|---|---|---|---|---|---|---|---|
| SELECT * FROM issue_proposal_current WHERE issue_id = ? | 0.088 | 0.13 | 3.642 | 0.102 | 400 | 8 | 1 | 0 |
| SELECT * FROM state_entity WHERE id = ? | 0.006 | 0.018 | 0.045 | 0.007 | 400 | 1 | 1 | 0 |
| SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1 | 0.006 | 0.021 | 4.504 | 0.019 | 400 | 1 | 1 | 0 |
| SELECT * FROM state_transition WHERE idempotency_key = ? | 0.005 | 0.016 | 0.042 | 0.006 | 400 | 1 | 1 | 0 |
| SELECT * FROM audit_log ORDER BY id DESC LIMIT 200 | 0.143 | 0.208 | 0.776 | 0.152 | 400 | 2 | 0 | 1 |
| seedProductionStable (idempotent upsert) | 0.027 | 0.046 | 0.249 | 0.033 | 100 | 2 | - | - |
| describeRollbackIdentityRecord (pure) | 0 | 0.001 | 0.113 | 0.001 | 400 | 0 | - | - |

row counts: issue_candidate=100, issue_proposal=100, issue_proposal_current=100, state_entity=100, state_transition=100, audit_log=200, production_stable_current=1

## scale 1000 rows

| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |
|---|---|---|---|---|---|---|---|---|
| SELECT * FROM issue_proposal_current WHERE issue_id = ? | 0.085 | 0.123 | 2.805 | 0.095 | 400 | 8 | 1 | 0 |
| SELECT * FROM state_entity WHERE id = ? | 0.006 | 0.017 | 4.842 | 0.019 | 400 | 1 | 1 | 0 |
| SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1 | 0.006 | 0.015 | 0.03 | 0.007 | 400 | 1 | 1 | 0 |
| SELECT * FROM state_transition WHERE idempotency_key = ? | 0.005 | 0.019 | 0.035 | 0.006 | 400 | 1 | 1 | 0 |
| SELECT * FROM audit_log ORDER BY id DESC LIMIT 200 | 0.142 | 0.22 | 1.442 | 0.155 | 400 | 2 | 0 | 1 |
| seedProductionStable (idempotent upsert) | 0.026 | 0.043 | 0.127 | 0.029 | 100 | 2 | - | - |
| describeRollbackIdentityRecord (pure) | 0 | 0.001 | 0.034 | 0.001 | 400 | 0 | - | - |

row counts: issue_candidate=1000, issue_proposal=1000, issue_proposal_current=1000, state_entity=1000, state_transition=1000, audit_log=2000, production_stable_current=1

## scale 10000 rows

| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |
|---|---|---|---|---|---|---|---|---|
| SELECT * FROM issue_proposal_current WHERE issue_id = ? | 0.087 | 0.121 | 3.782 | 0.099 | 400 | 8 | 1 | 0 |
| SELECT * FROM state_entity WHERE id = ? | 0.006 | 0.021 | 0.05 | 0.008 | 400 | 1 | 1 | 0 |
| SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1 | 0.006 | 0.014 | 0.043 | 0.007 | 400 | 1 | 1 | 0 |
| SELECT * FROM state_transition WHERE idempotency_key = ? | 0.005 | 0.02 | 0.083 | 0.007 | 400 | 1 | 1 | 0 |
| SELECT * FROM audit_log ORDER BY id DESC LIMIT 200 | 0.147 | 0.197 | 3.885 | 0.166 | 400 | 2 | 0 | 1 |
| seedProductionStable (idempotent upsert) | 0.027 | 0.048 | 0.237 | 0.034 | 100 | 2 | - | - |
| describeRollbackIdentityRecord (pure) | 0 | 0 | 0.713 | 0.002 | 400 | 0 | - | - |

row counts: issue_candidate=10000, issue_proposal=10000, issue_proposal_current=10000, state_entity=10000, state_transition=10000, audit_log=20000, production_stable_current=1

## EXPLAIN QUERY PLAN summary

15 read-path/scale observations: 12 are index SEARCH with no SCAN node, 3 contain a SCAN node.

- `SEARCH issue_proposal_current USING INTEGER PRIMARY KEY (rowid=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX sqlite_autoindex_state_entity_1 (id=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX idx_state_entity_type (entity_type=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_transition USING INDEX sqlite_autoindex_state_transition_1 (idempotency_key=?)` — SEARCH 1 / SCAN 0
- `SCAN audit_log` — SEARCH 0 / SCAN 1
- `SEARCH issue_proposal_current USING INTEGER PRIMARY KEY (rowid=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX sqlite_autoindex_state_entity_1 (id=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX idx_state_entity_type (entity_type=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_transition USING INDEX sqlite_autoindex_state_transition_1 (idempotency_key=?)` — SEARCH 1 / SCAN 0
- `SCAN audit_log` — SEARCH 0 / SCAN 1
- `SEARCH issue_proposal_current USING INTEGER PRIMARY KEY (rowid=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX sqlite_autoindex_state_entity_1 (id=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_entity USING INDEX idx_state_entity_type (entity_type=?)` — SEARCH 1 / SCAN 0
- `SEARCH state_transition USING INDEX sqlite_autoindex_state_transition_1 (idempotency_key=?)` — SEARCH 1 / SCAN 0
- `SCAN audit_log` — SEARCH 0 / SCAN 1
