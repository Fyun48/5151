# Runbook：`JimmyGOD/5151` 補回 issues / PRs（GitHub → Gitea metadata backfill）

> **狀態：未執行。** 本檔是「先備好的程序」，執行前必須通過 §1 的前置檢查；最後一步是 Owner 的決定。
> 背景：`JimmyGOD/5151` 是 2026-09-20 第一輪的**純 git 遷移** —— issues / pulls 的
> `X-Total-Count` 都是 **0**，而 GitHub `Fyun48/5151` 有 **19 issues + 354 PRs**。
> 程式碼本身沒有落差（65/65 分支、master tip sha 一致）。
> 詳見 `evidence/runtime-modernization/GITEA-MIGRATION.md` §1.4。

## 0. 為什麼不能「就地補」

Gitea 的 migration API（`POST /api/v1/repos/migrate`）只支援**建立**新 repo 時帶 metadata，
沒有「對既有 repo 補 issues/PRs」的端點。所以要補只能：

1. 刪掉 Gitea 上的 `JimmyGOD/5151`
2. 重新 migrate（這次帶 `issues/pull_requests/labels/milestones/releases`）

## 1. 前置檢查（全部要成立才可執行）

```bash
# (a) 沒有任何 run 在跑（刪 repo 會把正在跑的 job 連帶毀掉）
GITEA_TOKEN=<pat> bash ~/backfill-runs.sh status      # 期望 in_flight=0
# (b) 本機與 NAS 上沒有任何未推送的 commit
git -C /workspace/5151 status --porcelain             # 期望空
# (c) CI 積壓已清完（否則重建後又要重跑）
```

## 2. 會失去什麼（先備份、並確認可接受）

| 項目 | 重建後 | 處置 |
|---|---|---|
| Actions run 歷史（執行當下 **61 筆**） | 全部消失 | 先匯出 JSON 存檔（見 §3）；不可還原 |
| repo **secrets**（8 個） | 全部消失 | 值在 workspace 的 `INFRA-CREDENTIALS.md`（不在 repo 內），逐一手動重建 |
| repo **variables**（2 個） | 全部消失 | 先匯出（API 會回明文），重建時貼回 |
| Gitea 端既有分支/PR/標籤 | 以 GitHub 現況重新匯入 | 有意義的 Gitea-only 分支要先確認沒有 |
| repo 設定（預設分支、issue tracker、private 旗標、merge 策略） | 回到預設 | migrate 時用 `private=true` 明確帶上 |

實際的 secrets / variables（2026-09-20 由 API 查得，值見 `INFRA-CREDENTIALS.md`）：

- secrets（只回名稱）：`PRODUCTION_DEPLOY_ALLOWED_ACTOR`、`GHCR_REPO`、`SOURCE_REPO_URL`、`GHCR_USER`、
  `NAS_HOST`、`NAS_PORT`、`NAS_USER`、`NAS_SSH_KEY`
- variables（API 回**明文**）：`DEEPSEEK_API_KEY`、`DISCORD_WEBHOOK_URL`
  ⚠️ 順帶發現：`DISCORD_WEBHOOK_URL` 目前這顆值**無效**（`401 Invalid Webhook Token, code 50027`，
  用 `notify.sh` 實測確認）→ 重建時要換成有效的，或先留空（`notify.sh` 沒設會印 skipped 不會紅燈）。

## 3. 備份（執行前）

```bash
API=http://127.0.0.1:5251/api/v1/repos/JimmyGOD/5151
TOK=<pat from INFRA-CREDENTIALS>

# run 歷史（分頁抓滿；Gitea 端 log 在容器內 /data/gitea/actions_log/JimmyGOD/5151/）
for p in 1 2 3; do curl -sS -u "JimmyGOD:$TOK" "$API/actions/runs?limit=50&page=$p"; done > ~/5151-runs-backup.json
# variables（含明文值）
curl -sS -u "JimmyGOD:$TOK" "$API/actions/variables" > ~/5151-variables-backup.json
# secrets 只有名稱，值人工從 INFRA-CREDENTIALS.md 抄
curl -sS -u "JimmyGOD:$TOK" "$API/actions/secrets" > ~/5151-secrets-names.json
# 既有分支快照（重建後要比對）
git -C /workspace/5151 ls-remote origin | sort > ~/5151-refs-before.txt
```

## 4. 執行步驟

```bash
TOK=<pat>; HOST=http://127.0.0.1:5251; API=$HOST/api/v1

# 4.1 刪除（二次確認字串是自己打的，不是貼的）
curl -sS -u "JimmyGOD:$TOK" -X DELETE "$API/repos/JimmyGOD/5151" -o /dev/null -w '%{http_code}\n'   # 期望 204

# 4.2 重新 migrate（帶 metadata；**一定要從 NAS 內部**，走 Cloudflare 會 524）
curl -sS -u "JimmyGOD:$TOK" -H 'Content-Type: application/json' \
  -X POST "$API/repos/migrate" --data-binary @- <<JSON
{"clone_addr":"https://github.com/Fyun48/5151.git","repo_name":"5151","repo_owner":"JimmyGOD",
 "service":"github","auth_token":"<GH_TOKEN>","auth_username":"Fyun48",
 "mirror":false,"private":true,"issues":true,"pull_requests":true,"labels":true,
 "milestones":true,"releases":true,"wiki":false,"lfs":true}
JSON
# 期望 201。大 repo 會跑數分鐘；Gitea 是伺服器端執行，客戶端斷線不影響（實測見 §1.3 第 8 點）。

# 4.3 重建 secrets（8 個；值見 INFRA-CREDENTIALS.md）
for n in PRODUCTION_DEPLOY_ALLOWED_ACTOR GHCR_REPO SOURCE_REPO_URL GHCR_USER NAS_HOST NAS_PORT NAS_USER NAS_SSH_KEY; do
  curl -sS -u "JimmyGOD:$TOK" -H 'Content-Type: application/json' -X PUT \
    "$API/actions/secrets/$n" --data-binary "{\"data\":\"<值>\"}" -o /dev/null -w "$n %{http_code}\n"
done

# 4.4 重建 variables
curl -sS -u "JimmyGOD:$TOK" -H 'Content-Type: application/json' -X POST "$API/actions/variables" \
  --data-binary '{"name":"DEEPSEEK_API_KEY","value":"<值>"}'
curl -sS -u "JimmyGOD:$TOK" -H 'Content-Type: application/json' -X POST "$API/actions/variables" \
  --data-binary '{"name":"DISCORD_WEBHOOK_URL","value":"<有效的 webhook>"}'
```

## 5. 驗收

```bash
# 5.1 ref/metadata 一次比對（分支數、tip sha 必須相等；issues/PRs/releases 不得少於 GitHub）
GH_TOKEN=<github-token> GITEA_TOKEN=<pat> bash ~/migrate-github-repos.sh verify 5151
# 期望：br 65/65、iss 19/19、pr 354/354、rel 0/0、private=true、verdict OK

# 5.2 refs 快照與 §3 的 before 比對
git -C /workspace/5151 ls-remote origin | sort > /tmp/refs-after.txt && diff ~/5151-refs-before.txt /tmp/refs-after.txt && echo refs_identical

# 5.3 讓 CI 重新綠一次（重建後第一個 run）
GITEA_TOKEN=<pat> bash ~/dispatch.sh run build-production-image.yml "$(git -C /workspace/5151 rev-parse HEAD)" \
  --input release_mode=manual_owner --input release_intent_id=
```

## 6. 復原（Rollback）

- **沒有真正的 rollback**：run 歷史不可還原。
- 若 migrate 失敗（例如 GitHub API 速率限制或 token 失效），修好原因後**直接重跑 4.2**；
  Gitea 若留下半殘 repo，先 `DELETE` 再跑一次（第一輪就是這樣處理 524 的空 repo）。
- 若重建後發現 Gitea-only 的東西沒了，只能從 §3 的備份檔重建設定（run 歷史仍不可還原）。

## 7. 決策建議（給 Owner）

- 若你**不在乎** Gitea 上的 Actions 歷史與重建 secrets 的 10 分鐘：可做，做完 `JimmyGOD/5151`
  的 issues/PRs 就與 GitHub 對齊。
- 若你在乎：**維持現狀**也完全沒有功能影響 —— 程式碼、CI、build、部署都不依賴 Gitea 的 issues/PRs；
  GitHub 端仍是那些 metadata 的權威來源。
- 折衷（未實作）：另開一個 `JimmyGOD/5151-history` 作為純 metadata 的鏡像，不動主 repo。
