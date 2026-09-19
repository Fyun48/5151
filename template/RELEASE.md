# RELEASE

## 流程

1. `Build image (no deploy)` — workflow_dispatch，建 SHA-tagged immutable 映像。
2. `Predeploy check (no deploy)` — backup + integrity + smoke（fail-closed）。
3. `Production deploy (manual-only)` — workflow_dispatch + 精確 confirmation 字串。

## 規則

- merge/push **不會**自動部署。Production 一律 manual-only。
- Final Code Review 為 optional：Owner 可選 `FINAL_REVIEW` / `SKIP_REVIEW_AND_RELEASE` /
  `RETURN_TO_DEVELOPMENT`。
- **Skip Code Review ≠ Skip Owner Production Approval**。
- 不自行 merge、不自行 production deploy；最後交回 Owner Final Gate。
