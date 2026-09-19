# AGENTS

給 AI/coding agent 的專案約定（新專案請替換為實際內容）。

## 權威來源

- 原始碼與 CI/deploy 一律以本 repo 為唯一權威來源，不另開專案、不另開 tunnel。

## 開發範圍

- 只做目前活躍版本；歷史版本只讀，不修改。

## 開發工具

- 優先使用專案自訂 rules / skills / plugins / agents，不繞過。

## Pull requests 與部署

- 做完開非草稿 PR。
- 部署只走正式 workflow（Build → Predeploy → Deploy），皆從 master workflow_dispatch。
- 不自行 merge、不自行 production deploy、不改 Cloudflare 指向。
