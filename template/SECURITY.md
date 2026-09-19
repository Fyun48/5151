# SECURITY

## Secrets

- 不 commit 任何 secret。Repo 只放 `.env.example`、secret name、驗證邏輯、bootstrap docs。
- Secret value 禁止出現在 Git / PR / logs / evidence / screenshots / final report。

## CI / Gitea Runner

- 一般 CI runner **禁止取得 host Docker root**。優先 rootless DinD；否則隔離 DinD。
- **不要把 `/var/run/docker.sock` 掛給一般 AI/CI job**。
- Production deployment runner 是**另一個 capability boundary**（manual-only / Owner 授權）。

## Webhook

- Gitea webhook 必須驗證 signature（HMAC-SHA256）。

## 存取

- 最小權限；DB 密碼、replication 密碼、Gitea token、API keys 分離。
- 用 env 傳遞 host/port，不硬編碼 LAN IP。
