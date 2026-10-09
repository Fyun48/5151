# 量 web 延遲的正確方法（2026-10-10 實測）

## 為什麼要有這份
2026-10-09 到 10-10 之間，我把「公開站篩選 28 秒」拆成「約 25 秒是 web 容器的 Node CPU」之前，**先用錯的方法量過**：在 casa-nas 的 host 上打 `http://127.0.0.1:5153/api/public/listings…`，拿到 `1 ms` 的數字，讀成「快取生效、1 毫秒」。那是**連不上**——`curl -w %{time_total}` 在埠沒開時會 1 ms 返回 `code=000`。

## casa-nas 上 5153 的歸屬（`docker inspect` ＋ `ss -ltn` 實測）
| 對象 | 容器內埠 | host 綁定 |
|---|---|---|
| `591-tracker-v3`（抓取節點） | 5153 | **`127.0.0.1:5153`** ← host 打 5153 到的是**它**，不是 web |
| `5151-web-A` | 5153（`PORT=5153`） | **`0.0.0.0:15153`** |
| `5151-haproxy` | 15153 frontend、25433/25434 | `0.0.0.0:25153` |
| `5151-crawl-sandbox` | 5153 | **無 host 綁定**（只能 `docker exec` 進容器內用 `127.0.0.1:5199/5153`） |
`web-B`（syn-nas）同理：一律 **進容器內**量，不要在 host 上猜埠號。

## 正确量法（一定要看 http code）
```bash
export PATH=/usr/local/bin:/bin:/usr/bin:$PATH
docker exec 5151-web-A node -e '
const h = Date.now();
require("http").get("http://127.0.0.1:5153/api/public/listings?kind=whole&sort=newest&limit=5", (r) => {
  let n = 0; r.on("data", (c) => (n += c.length));
  r.on("end", () => console.log("code=" + r.statusCode + " ms=" + (Date.now() - h) + " bytes=" + n));
}).on("error", (e) => console.log("ERR " + e.code));'
```
- `code=000`／`ERR` ＝ 沒連上，**不是快**。
- 要分攤「是 Node 還是 DB」：request 進行中每 4–5 秒取樣 `docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}}' 5151-web-A 5151-postgres-A`，並查 `pg_stat_activity` 有幾個 `active` query。2026-10-10 的實測是 `web-A 79→108%`、`postgres 46→1.2%`、中段 `active=0` ⇒ **Node 端**。
- 公網數字會比容器內高（多走 Cloudflare Tunnel ＋ HAProxy，而且可能落到 `web-B`）；**兩條都要量**才能分清「應用本身慢」與「通道慢」。

## 硬體基線（外推隔離庫數字時要打折）
- `casa-nas`：`Intel Celeron N3450 @1.10GHz`、4 核、load 1.9–3.1，同機養 `5151-postgres-A`（PRIMARY）＋`591-tracker-v3`。
- 跑差分工具的機器：`AMD Ryzen Embedded R1600`、4 邏輯核。
- 實例：同一支管線在隔離庫 127,088 列跑 **~5 秒**，正式站 182,954 列跑 **~27 秒**——資料量只差 1.55 倍，**速度差主要是單核 CPU**。所以「在 DSH 主機上量的毫秒」**不能**当成正式站的承諾數字，只能用于相对比较。
