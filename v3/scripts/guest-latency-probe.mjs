// 訪客清單端點（`GET /api/public/listings`）的**唯讀**延遲探針（2026-10-16）。
//
// 為什麼要這一支：SWR 陳舊上界（`v3/src/publicListings.js` 的 `MAX_STALE_MS`）這一包的驗收
// 是「低流量站的訪客，閒置之後的每一發都要 < 3 秒」，而這件事只有在真的等出間隔、真的打 HTTP
// 時才量得出來（單元測試的假時鐘證明不了）。正式站改動前後、本機改動前後的數字都是這支跑出來的。
//
// 這支腳本**只做 GET**、不帶任何憑證、不寫任何檔案、不碰資料庫；`--base-url` 指到哪就只打哪。
// 憑證（若哪天真的要帶）請走呼叫端自己的 header，不要把值寫進這裡或任何 commit。
//
// 用法：
//   node v3/scripts/guest-latency-probe.mjs --base-url http://127.0.0.1:5253 --gap-seconds 60 --count 5
//   node v3/scripts/guest-latency-probe.mjs --base-url https://jibbyrenth.reversalplay.me --gap-seconds 150 --count 5
//   node v3/scripts/guest-latency-probe.mjs --base-url http://127.0.0.1:5253 --gap-seconds 0 --count 1 \
//     --path "/api/public/listings?districts=%E6%96%87%E5%B1%B1%E5%8D%80&sort=newest&limit=40"   # 冷查詢（沒有 entry）
//
// 參數：
//   --base-url <url>        必填。服務來源（本機或正式站皆可；只打這個來源）。
//   --gap-seconds <n>       預設 150。**相鄰兩發的『開始時間』間隔**（不是「上一發結束後再等」），
//                           所以量到的間隔與維運講的「每 150 秒一發」一致。
//   --count <n>             預設 5。樣本數（不含間隔，第一發立刻打）。
//   --path <path>           預設訪客首頁的查詢形狀（見 DEFAULT_PATH）。
//   --timeout-seconds <n>   預設 60。單發請求的逾時（逾時算一筆失敗樣本，不中斷後面的樣本）。
//
// 輸出：每一發的序號、開始時間（ISO）、秒數、HTTP 狀態、回應的 `cache_hit`、筆數；
//       最後一行彙總（min／中位數／max／< 3 秒的發數）。腳本不解讀成敗，數字自己說話。
import { performance } from "node:perf_hooks";

// 訪客首頁預設查詢（`v3/public/index.html` 的 `guestListQuery()` 形狀）：
// 只選行政區＋排序＋兩個預設過濾，limit=40（`listPageSize()` 的預設）。
const DEFAULT_PATH = "/api/public/listings?districts=%E4%B8%AD%E5%B1%B1%E5%8D%80&sort=newest&excludeRooftop=1&excludeLowFloors=1&limit=40";
const FAST_MS = 3_000;

function parseArgs(argv) {
  const out = { gapSeconds: 150, count: 5, path: DEFAULT_PATH, timeoutSeconds: 60, baseUrl: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) throw new Error(`${arg} 需要一個值`);
      i += 1;
      return value;
    };
    if (arg === "--base-url") out.baseUrl = next();
    else if (arg === "--gap-seconds") out.gapSeconds = Number(next());
    else if (arg === "--count") out.count = Number(next());
    else if (arg === "--path") out.path = next();
    else if (arg === "--timeout-seconds") out.timeoutSeconds = Number(next());
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`不認得的參數：${arg}`);
  }
  return out;
}

function usage() {
  return [
    "用法：node v3/scripts/guest-latency-probe.mjs --base-url <url> [--gap-seconds 150] [--count 5] [--path <path>] [--timeout-seconds 60]",
    "唯讀：只對 --base-url 這個來源發 GET，不帶憑證、不寫檔、不碰資料庫。",
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!args.baseUrl) {
  console.error(`--base-url 是必填。\n${usage()}`);
  process.exit(2);
}
if (!Number.isFinite(args.gapSeconds) || args.gapSeconds < 0) {
  console.error("--gap-seconds 必須是 ≥ 0 的數字");
  process.exit(2);
}
if (!Number.isInteger(args.count) || args.count < 1) {
  console.error("--count 必須是 ≥ 1 的整數");
  process.exit(2);
}
if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) {
  console.error("--timeout-seconds 必須是 > 0 的數字");
  process.exit(2);
}

const base = args.baseUrl.replace(/\/+$/, "");
const url = `${base}${args.path.startsWith("/") ? "" : "/"}${args.path}`;
const startedAt = Date.now();

console.log(`# 訪客延遲探針（唯讀 GET）`);
console.log(`# 目標：${url}`);
console.log(`# 間隔：${args.gapSeconds} 秒（相鄰兩發的開始時間）／樣本數：${args.count}／單發逾時：${args.timeoutSeconds} 秒`);
console.log(`# 開始時間：${new Date(startedAt).toISOString()}`);
console.log(["#", "開始時間", "秒數", "HTTP", "cache_hit", "筆數", "totalMatched"].join("\t"));

const samples = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let i = 0; i < args.count; i += 1) {
  const dueAt = startedAt + i * args.gapSeconds * 1000;
  const waitMs = dueAt - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  const t0 = performance.now();
  const startedIso = new Date().toISOString();
  let status = 0;
  let cacheHit = "-";
  let count = "-";
  let totalMatched = "-";
  let note = "";
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(args.timeoutSeconds * 1000) });
    status = res.status;
    const text = await res.text();
    const elapsedMs = performance.now() - t0;
    try {
      const body = JSON.parse(text);
      cacheHit = body.cache_hit === true ? "true" : body.cache_hit === false ? "false" : "-";
      count = Array.isArray(body.listings) ? body.listings.length : "-";
      totalMatched = body.totalMatched === undefined ? "-" : String(body.totalMatched);
      if (body.error) note = ` error=${String(body.error).slice(0, 80)}`;
    } catch {
      note = ` 非 JSON 回應（前 80 字）：${text.slice(0, 80)}`;
    }
    samples.push({ ms: elapsedMs, ok: res.ok });
    console.log([i + 1, startedIso, (elapsedMs / 1000).toFixed(2), status, cacheHit, count, totalMatched].join("\t") + note);
  } catch (error) {
    const elapsedMs = performance.now() - t0;
    samples.push({ ms: elapsedMs, ok: false });
    console.log([i + 1, startedIso, (elapsedMs / 1000).toFixed(2), status || "ERR", "-", "-", "-"].join("\t") + ` ${error?.name || "error"}: ${error?.message || error}`);
  }
}

const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
const median = ms.length % 2 === 1 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2;
const fast = ms.filter((v) => v < FAST_MS).length;
console.log(
  `# 彙總：n=${ms.length} min=${(ms[0] / 1000).toFixed(2)}s 中位數=${(median / 1000).toFixed(2)}s max=${(ms[ms.length - 1] / 1000).toFixed(2)}s ` +
    `每發 < ${FAST_MS / 1000}s 的發數=${fast}/${ms.length} 失敗=${samples.filter((s) => !s.ok).length}`,
);
