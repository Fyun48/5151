import { probeListingAlive as probe591Body, isListingGoneError } from "./client591.js";
import { probeHpListingOutcome } from "./houseprice.js";
import { PROBE_ALIVE, PROBE_GONE, PROBE_INCONCLUSIVE } from "./probeOutcomes.js";

export { PROBE_ALIVE, PROBE_GONE, PROBE_INCONCLUSIVE };

function asProbeResult(supported, outcome) {
  return {
    supported,
    outcome,
    alive: outcome === PROBE_ALIVE ? true : outcome === PROBE_GONE ? false : null,
  };
}

// 三大結果：確認上架／有下架證據／本次無法確認。
// 逾時、403、429、5xx、驗證頁、空殼或未預期格式 → 無法確認，不得改寫既有上下架。
//
// 已用真實頁面校準的下架訊號：
//   591      ：JSON 明細 API 查無 → gone（client591.probeListingAlive 會丟 isListingGoneError）。
//   5168     ：/ws/detail 404/410 或明確下架文案 → gone；400／空 JSON／逾時／驗證頁 → 無法確認。
//   住商 hb   ：明細頁 HTTP 404 → gone。
//   信義 sinyi：明細頁 HTTP 404（頁面另有下架字樣）→ gone。
//   好房 hf   ：轉址到 /nosupport/noobject.aspx → gone。
//   租租通 dd ：明細頁 HTTP 404 → gone。

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 僅保留「非常明確」的下架字樣，避免把導覽/推薦區塊的字誤判。
const GONE_TEXT = /物件已(下架|成交|出租|刪除|結案|售出)|此(物件|案件|房屋|刊登|頁面)已(下架|不存在|刪除|成交|出租)|查無(此|該)?(物件|房屋|刊登)|物件不存在|找不到.{0,6}(物件|房屋|刊登|頁面)/;

// 通用 HTML 明細探測：404/410 或轉址到「查無物件」頁或明確下架字樣 → gone；其它保守 → alive。
export async function probeHtmlListingOutcome(url, { redirectGoneMarkers = [], referer = "" } = {}) {
  const target = String(url || "").trim();
  if (!target) return { outcome: PROBE_INCONCLUSIVE, reason: "missing_url" };
  let res;
  try {
    res = await fetch(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml", ...(referer ? { Referer: referer } : {}) },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { outcome: PROBE_INCONCLUSIVE, reason: "timeout" };
  }
  if (res.status === 404 || res.status === 410) return { outcome: PROBE_GONE, reason: `http_${res.status}` };
  const finalUrl = String(res.url || "");
  if (redirectGoneMarkers.some((m) => finalUrl.includes(m))) return { outcome: PROBE_GONE, reason: "redirect_gone" };
  if (res.status === 403 || res.status === 429 || res.status >= 500) {
    return { outcome: PROBE_INCONCLUSIVE, reason: `http_${res.status}` };
  }
  if (!res.ok) return { outcome: PROBE_INCONCLUSIVE, reason: `http_${res.status}` };
  let html = "";
  try { html = await res.text(); } catch { return { outcome: PROBE_INCONCLUSIVE, reason: "empty_body" }; }
  if (/驗證碼|captcha|cloudflare|just a moment/i.test(html)) {
    return { outcome: PROBE_INCONCLUSIVE, reason: "challenge" };
  }
  if (redirectGoneMarkers.some((m) => html.includes(m))) return { outcome: PROBE_GONE, reason: "body_gone_marker" };
  if (GONE_TEXT.test(html)) return { outcome: PROBE_GONE, reason: "gone_text" };
  if (!String(html || "").trim()) return { outcome: PROBE_INCONCLUSIVE, reason: "empty_shell" };
  if (!htmlLooksLikeListing(html)) return { outcome: PROBE_INCONCLUSIVE, reason: "empty_shell" };
  return { outcome: PROBE_ALIVE, reason: "html_ok" };
}

function htmlLooksLikeListing(html) {
  const text = String(html || "");
  if (!text.trim()) return false;
  const signals = [
    /\d+\s*房/,
    /月租|租金.{0,12}\d{3,}|元\s*\/\s*月/,
    /\d+(?:\.\d+)?\s*坪/,
    /樓層|[0-9]+\/[0-9]+\s*樓/,
    /[市縣].{0,8}[區鄉鎮].{0,20}[路街巷]/,
  ];
  return signals.filter((re) => re.test(text)).length >= 1;
}

export async function probeHtmlListingAlive(url, opts = {}) {
  const { outcome } = await probeHtmlListingOutcome(url, opts);
  return outcome === PROBE_ALIVE;
}

// 依來源分派探測。回傳 { supported, alive }：supported=false 表示此來源不支援即時探測（如自刊 self）。
export async function probeListingAliveBySource(listing) {
  const source = String(listing?.source || "591") || "591";
  const url = String(listing?.url || "");
  if (source === "self") return asProbeResult(false, null);
  try {
    if (source === "591" || source === "") {
      await probe591Body(listing.post_id);
      return asProbeResult(true, PROBE_ALIVE);
    }
    if (source === "houseprice") {
      const { outcome } = await probeHpListingOutcome(url);
      return asProbeResult(true, outcome);
    }
    if (source === "housefun") {
      const { outcome } = await probeHtmlListingOutcome(url, { redirectGoneMarkers: ["noobject"] });
      return asProbeResult(true, outcome);
    }
    if (source === "hbhousing" || source === "sinyi" || source === "ddroom") {
      const { outcome } = await probeHtmlListingOutcome(url);
      return asProbeResult(true, outcome);
    }
    return asProbeResult(false, null);
  } catch (error) {
    if ((source === "591" || source === "") && isListingGoneError(error)) return asProbeResult(true, PROBE_GONE);
    return asProbeResult(true, PROBE_INCONCLUSIVE);
  }
}
