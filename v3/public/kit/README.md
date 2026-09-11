# jibby-kit

固定版本、本機可建置的共用設計套件（OPS 第 9 包）。

## 三層

1. **基礎 token** — `tokens.css`。顏色／字級／間距／圓角。
2. **共用元件** — `components.css`。按鈕、輸入、分頁、表格、底欄、對話框、空狀態、錯誤。
3. **產品區塊** — `design-system/property-platform/`。找房卡片、許願房、關注配額只屬於吉比租房，**不要**整包貼到別的產業。

新站複製 `themes/example.css`，**只覆寫** `--accent`、`--bg`、`--paper`。

## 交付方式

```
node design-system/scripts/pack-kit.js
```

產出 `design-system/dist/jibby-kit-<version>/`，並快照到 `v3/public/kit/`、`ops/public/kit/`。

- 分家站使用資料夾快照或固定版本，**runtime 不可回抓 OPS**。
- 套件 CSS 不得含遠端 `@import`、也不得寫實際 OPS 網址。

## 反悔

v3 畫面繼續吃內建 `v3/public/tokens.css`（CasaOS 只同步 `v3/src`＋`v3/public`）。關掉或刪掉 `design-system/` 也不影響正式機。

OPS Console 吃本目錄快照的 token 名與主題覆寫，外觀維持控制台灰綠，不是租屋站皮。
