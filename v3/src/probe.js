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
const GONE_TEXT = /物件已(下架|成交|出租|刪除|結案|售出|關閉)|此(物件|案件|房屋|刊登|頁面)已(下架|不存在|刪除|成交|出租|關閉)|查無(此|該)?(物件|房屋|刊登)|物件不存在|找不到.{0,6}(物件|房屋|刊登|頁面)/;

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

function findMatchingClose(html, from, tagName) {
  const open = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const close = new RegExp(`</${tagName}\\s*>`, "gi");
  let depth = 1;
  let i = from;
  while (i < html.length && depth > 0) {
    open.lastIndex = i;
    close.lastIndex = i;
    const opened = open.exec(html);
    const closed = close.exec(html);
    if (!closed) return html.length;
    if (opened && opened.index < closed.index) {
      depth += 1;
      i = opened.index + opened[0].length;
    } else {
      depth -= 1;
      i = closed.index + closed[0].length;
    }
  }
  return i;
}

function firstElementInner(html, tagName) {
  const open = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const match = String(html || "").match(open);
  if (!match) return null;
  const start = match.index + match[0].length;
  const end = findMatchingClose(html, start, tagName);
  return String(html).slice(start, end);
}

function stripClassedSubtrees(html, classRe) {
  let text = String(html || "");
  const openRe = /<(section|div|aside|article)(\s[^>]*)?>/gi;
  for (let guard = 0; guard < 40; guard += 1) {
    openRe.lastIndex = 0;
    let found = null;
    let match;
    while ((match = openRe.exec(text))) {
      if (classRe.test(match[2] || "")) {
        found = { start: match.index, tag: match[1], after: match.index + match[0].length };
        break;
      }
    }
    if (!found) break;
    const end = findMatchingClose(text, found.after, found.tag);
    text = `${text.slice(0, found.start)} ${text.slice(end)}`;
  }
  return text;
}

function listingMainText(html) {
  const source = String(html || "");
  const mainInner = firstElementInner(source, "main");
  const body = mainInner != null ? mainInner : source;
  return stripClassedSubtrees(body, /\b(?:recommend|related|search|suggest)\b/i)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<(aside|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlLooksLikeListing(html) {
  const text = listingMainText(html);
  if (!text) return false;
  const valueSignals = [
    /\d+\s*房/,
    /(?:月租|租金)\s*\d{3,}|元\s*\/\s*月/,
    /\d+(?:\.\d+)?\s*坪/,
    /[0-9]+\/[0-9]+\s*樓|\d+\s*樓/,
    /[市縣].{0,8}[區鄉鎮].{0,20}[路街巷].{0,16}\d*/,
  ];
  return valueSignals.filter((re) => re.test(text)).length >= 2;
}

export async function probeHtmlListingAlive(url, opts = {}) {
  const { outcome } = await probeHtmlListingOutcome(url, opts);
  return outcome === PROBE_ALIVE;
}

// 依來源分派探測。回傳 { supported, alive }：supported=false 表示此來源不支援即時探測（如自刊 self）。
function rent591HtmlUrl(listing) {
  const id = Number(listing?.post_id);
  if (!id) return "";
  return `https://rent.591.com.tw/${id}`;
}

export async function probeListingAliveBySource(listing, { thorough = false } = {}) {
  const source = String(listing?.source || "591") || "591";
  const url = String(listing?.url || "");
  const rentUrl = source === "591" || source === "" ? rent591HtmlUrl(listing) : "";
  if (source === "self") return asProbeResult(false, null);
  try {
    if (source === "591" || source === "") {
      await probe591Body(listing.post_id);
      if (thorough && rentUrl) {
        const html = await probeHtmlListingOutcome(rentUrl);
        if (html.outcome === PROBE_GONE) return asProbeResult(true, PROBE_GONE);
      }
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
    if (thorough && (source === "591" || source === "") && rentUrl) {
      const html = await probeHtmlListingOutcome(rentUrl);
      if (html.outcome === PROBE_GONE) return asProbeResult(true, PROBE_GONE);
    }
    return asProbeResult(true, PROBE_INCONCLUSIVE);
  }
}
