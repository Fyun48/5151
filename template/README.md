# Engineering Template

可複製到未來新專案的工程模板（Phase 29）。涵蓋 CI/CD、agent 契約、專案文件。

## 結構

```
.gitea/workflows/
  ci.yml          # push/PR：tests + lint
  build.yml       # 手動：建 SHA-tagged 映像（不部署）
  staging.yml     # 手動：staging 部署
  predeploy.yml   # 手動：backup + integrity + smoke（fail-closed，不部署）
  production.yml  # 手動：production 部署（需精確 confirmation，專屬 runner）
.agent/
  policy.yml      # agent 行為契約（production manual-only、secrets、shadow-first）
  limits.yml      # max runtime/tokens/cost/changed files/diff lines/self-fix iterations
  context.md      # 給 agent 的架構與慣例脈絡
ARCHITECTURE.md
SECURITY.md
OPERATIONS.md
RELEASE.md
AGENTS.md
```

## 使用

1. 複製到新專案，替換 placeholder（`./scripts/*`、repository 名、runner label 等）。
2. Production workflow 保持 `workflow_dispatch` + confirmation，**絕不加 push 觸發**。
3. `.agent/limits.yml` 依專案調整預算；`.agent/context.md` 填實際架構。
4. Secrets 一律走 repo/runner secret，不 commit 明文。

## 核心原則（固化於此模板）

- Production **manual-only**；merge/push 不自動部署。
- CI runner **不掛 host docker.sock**；production deploy 是獨立 capability boundary。
- Final Code Review **optional**；Skip Review 仍需 Owner Production Approval。
- 重大架構變更 **shadow-first**；不順便改產品語意。
