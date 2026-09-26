# PR-B 可接續狀態

更新：2026-09-26。**BLOCKED：需要既有 NAS 執行通道，才能完成實機驗收。**
PR [#497](https://github.com/Fyun48/5151/pull/497) 保持 open、非草稿、未合併、未部署。

- 分支：`fix/pr-b-persist-listing-transaction`；精確最終 HEAD 讀 GitHub PR，不使用先前報告的 HEAD 當最新值。
- 已完成實測的程式 SHA：`316995b768415e7b69f03e658c4027cdb5bab6cd`；[Tests run 36222517400](https://github.com/Fyun48/5151/actions/runs/36222517400)。
- 一般 2,598 pass／0 fail／34 skip；PG 129 pass／0 fail／1 optional shadow skip。CI smoke PASS；本批 lag 全部達標。
- 全部修正、效能表、驗證範圍、保留／撤回理由：[接手結果](PRB_CODEX_TAKEOVER_20260926.md)。
- 原始及中間量測：`evidence/prb-codex-20260926/`；失敗歷程保留於 Git，不靠重跑或取消 CI 製造綠燈。
- 整體架構的剩餘 gate：[GATE 1～12](gate-1-12-evidence-20260924.md)。C～F／完整 HTTP E2E／HA 未完成。

## 下一步

1. 提供本工作階段可用的既有 NAS 遠端執行通道。沒有要求新 tunnel、重建憑證庫或先部署。
2. 在獨立 checkout，以 PR 最終 HEAD 執行 `bash v3/scripts/prb-nas-verify.sh <完整 SHA>`。
   完整指令及產物位置：`docs/runbooks/PRB_NAS_Disposable_Verification.md`。
3. 讀取 PG test log／四案效能 JSON，修正任何未達標項目；NAS gate 通過前不得標 READY_FOR_REVIEW。
4. 完整 PR-B 驗收後，另依 C～F 的逐項 gate 接續整體遷移；正式變更維持 manual-only。

## 本機／CI 重跑

```bash
npm ci
TZ=UTC npm test
# 僅在已設定拋棄式 PG_TEST_URL／PG_URL 的隔離環境：
npm run test:pg
node v3/scripts/prb-search-benchmark.mjs
```

本機 Node 24 最近完整結果：2,632 tests／2,598 pass／0 fail／34 skip；CI 使用 Node 22／PG 16.14。
必要 PG fixture 由專用 CI job 實跑；lint NOT_RUN。NAS runner 只完成 bash 語法檢查，實機容器流程 NOT_RUN。
正式庫 `5151_shadow` 不可用於 setup／import／migration／ANALYZE；測試腳本不接受正式連線。
