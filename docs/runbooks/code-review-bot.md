# 自動程式碼審查（advisory）— 與模型無關

`.github/workflows/code-review.yml` ＋ `.github/scripts/code-review.mjs`：PR 開好之後請一個
**OpenAI 相容**的模型看一次 diff，把結果**留言在 PR 上**。

> **不是 merge gate**：這支 workflow 沒有任何 required check 的效果，不改程式、不合併、不部署
> （測試會擋住誤加的 `gh pr merge`／`git push`／`deploy` 字眼）。模型掛掉、金鑰沒設，都只會 skip，
> 不會讓 PR 變紅、也不會擋任何事。

## 為什麼是「與模型無關」

審查本體只是一次 chat-completions 呼叫，所以 provider 是設定而不是相依：

| provider | `REVIEW_BASE_URL` | `REVIEW_MODEL` 例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| **DeepSeek** | `https://api.deepseek.com` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | 任意模型 id |
| Groq | `https://api.groq.com/openai/v1` | 任意模型 id |
| 自架（vLLM / Ollama / LM Studio） | `http://<host>:<port>/v1` | 你載入的模型名稱 |

端點正規化在 `reviewEndpoint()`：base 已經帶 `/vN` 就照用，否則補上 `/v1`，最後接
`/chat/completions`。要換模型只改 repo variable，不必改程式。

## 啟用步驟（Owner 端，一次性）

GitHub → Settings → Secrets and variables → Actions：

1. **secret** `REVIEW_API_KEY` = provider 金鑰。
2. **variable** `REVIEW_BASE_URL` = 上表那欄（不設則預設 `https://api.openai.com/v1`）。
3. **variable** `REVIEW_MODEL` = 上表那欄（不設則預設 `gpt-4o-mini`）。

之後每個 PR（opened／synchronize／reopened／ready_for_review）都會自動留言一次。
也可以手動跑：Actions → **Code review (advisory)** → Run workflow → 填 PR 編號。
**要關掉**：把 secret 刪掉或清空即可（workflow 會 skip，維持綠色）。

## 行為細節

- 收集 diff 的方式是 `gh pr diff <number>`（`pull_request` 事件或手動輸入的編號）。
- diff 超過 `MAX_DIFF_CHARS`（120,000 字元）會截斷並在提示裡註明，避免 provider 直接拒收。
- 提示詞（`SYSTEM_PROMPT`）要求：只依 diff 說話、標嚴重度（blocker／should-fix／nit）、指出
  檔案與行號、不要重寫程式、找不到問題就一行說沒有。要調風格就改這一段。
- 沒有 `REVIEW_API_KEY`、diff 檔不存在、diff 為空 → 印一行 skip 並 exit 0。
- provider 回非 2xx／非 JSON → 印錯誤並 exit 1，但 workflow 那一步是 `continue-on-error: true`，
  而且只有在產出檔案存在時才留言，所以 provider 出事不會污染 PR 討論。
- fork 來的 PR 拿不到 secret → 自動 skip（不會外洩金鑰）。

## 與 Gitea 時代文件的關係

`evidence/runtime-modernization/*` 提到的「OpenAI Reviewer API key」是 Gitea 時代的敘述
（當時的 agent workflow 已暫停）。這裡沒有綁任何特定 provider，`REVIEW_*` 三個設定就能換模型，
所以那一項可以視為**已由這支取代**。

