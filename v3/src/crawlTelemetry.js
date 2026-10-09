// 抓取輪次儀表板（觀測層，2026-10-09）。
//
// 目的：在一輪抓取的生命週期留下「結構化、單行、繁中」的計時與停手記錄，
// 讓「輪次逾時 ⇒ 輪尾可見優先掃描永遠不跑」這種問題可以被量出來、看出停在哪。
//
// 鐵則（本包唯一允諾）：**只加觀測，不改控制流、門檻、順序或回傳形狀**。
// 所以這裡只做三件事：
//   1. 把 console.log／console.warn 包成一層可注入的 sink（測試用 fake logger 取代）。
//   2. 記住「目前這輪正在哪個來源／階段」（模組層變數：爬蟲一次只跑一輪）。
//   3. 產生短輪次 id。
//
// 刻意不新增任何 npm 依賴；預設 sink 就是既有的 console 輸出管道。
const defaultSink = {
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
};

let sink = defaultSink;
let phase = "準備";
let seq = 0;

/** 測試用：把儀表板輸出導到 fake logger（傳 null 恢復 console）。 */
export function setCrawlTelemetrySink(next) {
  sink = next || defaultSink;
}

/** 標記「這一輪現在在哪個來源／階段」（只寫觀測狀態，不影響控制流）。 */
export function setCrawlPhase(label) {
  phase = String(label || "準備") || "準備";
}

/** 讀「這一輪現在在哪」——給「到點停手」用。 */
export function currentCrawlPhase() {
  return phase;
}

/** 短輪次 id：時間戳（36 進位）＋遞增序號，足夠在同一台節點上區分每一輪。 */
export function newCrawlRoundId() {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

/** 儀表板的單一輸出管道（log＝info、warn＝停手／警告）。 */
export const crawlTelemetry = {
  log: (...args) => sink.log(...args),
  warn: (...args) => sink.warn(...args),
};

/**
 * 到點停手：預算用盡時**先寫一行、再取消**。
 * 由 withBudget 的計時器在 abort 前呼叫，所以訊息出現的順序保證在失敗行之前。
 */
export function logDeadlineStop(elapsedMs) {
  crawlTelemetry.warn(`到點停手：本輪已耗 ${Math.round(Number(elapsedMs) || 0)}ms，停在〈${phase}〉`);
}
