# Repository Layer（Phase 5）

把 domain 與資料驅動解耦：domain 只依賴 repository interface，不綁 `node:sqlite`
或 SQLite 專屬語法。SQLite 現在可跑，PostgreSQL 是目標，透過 `DB_DRIVER` 切換。

```
Domain
  ↓
Repository interface（async，driver-agnostic）
  ↓
SQLite adapter（node:sqlite，今日） | PostgreSQL adapter（pg，目標）
```

## 已完成示範

- `settings.js`：`createSettingsRepository({ driver, sqliteDb, pgPool })` 工廠 +
  `createSqliteSettingsRepository` / `createPostgresSettingsRepository`。
- 介面：`get` / `set`（upsert）/ `delete` / `all`。
- SQLite 用 `?` + `ON CONFLICT(key)`；PostgreSQL 用 `$n` + `ON CONFLICT (key) ... EXCLUDED`。
- `flags.js`：`createFlagsRepository({ driver, sqliteDb, pgPool })` 工廠 +
  `createSqliteFlagsRepository` / `createPostgresFlagsRepository`。
- 介面：`get(userId, postId)` / `set(userId, postId, flags)`（upsert）/ `map(userId)` / `delete(userId, postId)`。
  示範**複合主鍵**（user_id + post_id）與 `map` 集合查詢，超出 key-value 的單鍵形態。

## 遷移路徑（其餘 domain）

依同樣 pattern 逐一抽出 `listings / users / flags / settings / search / geo / route /
jobs / notifications / wishes / matching / OPS-CRM outbox`。

注意：現有 `db.js` 是**同步**（node:sqlite `DatabaseSync`），PostgreSQL 是**非同步**。
遷移時需把呼叫端逐步改成 async；SQLite adapter 用 async 包裝同步底層，讓兩邊介面一致。
