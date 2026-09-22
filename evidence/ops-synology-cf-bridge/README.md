# Synology OPS predeploy 走 Cloudflare Access SSH bridge 的實測證據（2026-09-22）

> 用途：這是「公網 SSH 埠 `58722` 可以關閉」的判準 —— 自動化必須能**只靠 Cloudflare Access**
> 進 NAS，而不是 fallback 到公網。本檔記錄 2026-09-22 的實測結果。

## 背景

`predeploy-ops-synology.yml`（read-only gate）在 2026-09-22T09:02Z 失敗，run `35708118677`：

- 失敗步驟：`Validate image digest + OCI metadata (read-only)`
- annotation：`tag missing: ghcr.io/fyun48/5151:4543133b1c8bc99ea2d925e63e3281eb6786a00f`

⇒ 不是 label 或 digest 格式問題，而是**那個 commit 根本還沒有對應的映像 tag**：
`.github/workflows/build-production-image.yml` 只推**不可變 SHA tag**，沒 build 過就沒有 tag 可驗。

## 這次做了什麼

1. 從 `master`（`6e4617b238b7b3df82f56d440fd968f0d8fc82f2`）觸發
   `build-production-image.yml`（`release_mode=manual_owner`）：

   ```bash
   gh workflow run build-production-image.yml --repo Fyun48/5151 --ref master \
     -f sha=6e4617b238b7b3df82f56d440fd968f0d8fc82f2 \
     -f release_mode=manual_owner -f release_intent_id=
   ```

   - run `35733385650` → **success**（1m25s；`docker/build-push-action`、`Record digest`、
     `Verify sharp + revision label inside built amd64 image` 全綠）
   - 產出：`ghcr.io/fyun48/5151:6e4617b2…`，multi-arch index digest
     `sha256:6f4ed1920d54f6106ac4a08c27c64181a17878783a2c7493f925d33faa2b16c2`

   以 GHCR registry API（匿名即可，package 為 public）獨立複驗 labels：

   | label | 值 |
   |---|---|
   | `org.opencontainers.image.revision` | `6e4617b238b7b3df82f56d440fd968f0d8fc82f2` |
   | `org.opencontainers.image.source` | `https://github.com/Fyun48/5151` |

2. 觸發 read-only 的 predeploy：

   ```bash
   gh workflow run predeploy-ops-synology.yml --repo Fyun48/5151 --ref master \
     -f sha=6e4617b238b7b3df82f56d440fd968f0d8fc82f2 \
     -f image_digest=sha256:6f4ed1920d54f6106ac4a08c27c64181a17878783a2c7493f925d33faa2b16c2
   ```

   - run `35733981203` → **success**（job `predeploy-check` 24s，驗證步驟全過）
   - 只留下 Node 20 deprecation 等 warning，無失敗

## 關鍵：SSH 走的是 CF bridge（不是公網 fallback）

同一 run 的 job log（`NAS SSH endpoint (Cloudflare Access bridge, falls back to public SSH)`）：

```
cf-ssh-bridge: SSH smoke test OK (***@127.0.0.1:2223)
cf-ssh-bridge: ssh-***.reversalplay.me -> 127.0.0.1:2223 / docker 172.17.0.1:2223 ready
```

- 走的是 `ssh-tori.reversalplay.me:2223` + service token（`CF-Access-Client-Id`/`Secret`）
- **沒有**出現 `::warning::cf-ssh-bridge falling back to public SSH …` ⇒ 公網 `58722` 全程未被使用

## Synology 端 read-only 檢查結果（artifact `predeploy.out`）

```
== docker / docker compose ==   Docker 24.0.2 / Compose v2.20.1-6047
== NAS architecture ==          x86_64
== app/data root ==             /volume1/docker/5151-ops/{app,data}
== disk free ==                 16T，用 11T，剩 5.3T（67%）
== port 5154 / container ==     port 5154 not currently listening；container=5151-ops present
== auth.env ==                  perms=600；owner email/password/secret(64hex) 皆 present
== ops.db ==                    present size=4096
== current release ==           e01bfc5b0175f9c13e416b5c12ec37e2ad0f88e3
                                runtime image ghcr.io/fyun48/5151@sha256:8a2a41a926f4107f345ad6818e151c8f704968f7d740ebc69660355d54026d2b
== first deploy ==              false
PREDEPLOY_RESULT=PASS
```

## 結論 / 後續

- `58722` 的關閉前提（自動化可全程走 Cloudflare Access）**已由實測滿足** → 可由 Owner 關閉公網 SSH 埠。
  - 注意：workflow 內仍保留 `fallback-host/port` 設定；埠關掉後 fallback 自然失效，只會在有問題時
    讓 `cf-ssh-bridge` 明確失敗（比默默走公網更安全）。要更嚴格可把 fallback secrets 一併移除。
- 尚未執行：`deploy-ops-synology.yml`（會**真的**在 Synology 上建立/切換 `5151-ops` 版本、
  symlink `current` 與容器重建）。目前 Synology 上是 `e01bfc5b…`；要更新成 `6e4617b2…` 需 Owner 明確指示：

  ```bash
  gh workflow run deploy-ops-synology.yml --repo Fyun48/5151 --ref master \
    -f sha=6e4617b238b7b3df82f56d440fd968f0d8fc82f2 \
    -f image_digest=sha256:6f4ed1920d54f6106ac4a08c27c64181a17878783a2c7493f925d33faa2b16c2 \
    -f confirmation=DEPLOY-OPS
  ```

## 重現方式（檢查用）

```bash
# 1) SHA tag 是否存在 + digest
gh api /users/Fyun48/packages/container/5151/versions   # 需 read:packages；或看 run 的 artifact
docker buildx imagetools inspect ghcr.io/fyun48/5151:<sha>
# 2) predeploy（read-only）
gh workflow run predeploy-ops-synology.yml -f sha=<sha> -f image_digest=<digest>
gh run view <run-id> --log | grep -E 'cf-ssh-bridge|PREDEPLOY_RESULT'
```
