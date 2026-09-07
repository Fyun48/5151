import { probeListingAlive as probe591Body, isListingGoneError } from "./client591.js";
import { probeHpListingAlive } from "./houseprice.js";

// 各大平台「物件是否還在」的統一探測。原則：保守——只有出現「明確不在的訊號」才判定下架，
// 其它（正常頁、403/429/5xx、逾時、被擋、JS 空殼）一律視為「還在」，避免把仍上架的物件誤標下架。
//
// 已用真實頁面校準的下架訊號：
//   591      ：JSON 明細 API 查無 → gone（client591.probeListingAlive 會丟 isListingGoneError）。
//   5168     ：/ws/detail JSON 無物件內容 → gone（houseprice.probeHpListingAlive）。
//   住商 hb   ：明細頁 HTTP 404 → gone。
//   信義 sinyi：明細頁 HTTP 404（頁面另有下架字樣）→ gone。
//   好房 hf   ：轉址到 /nosupport/noobject.aspx → gone。
//   租租通 dd ：明細頁 HTTP 404 → gone。

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 僅保留「非常明確」的下架字樣，避免把導覽/推薦區塊的字誤判。
const GONE_TEXT = /物件已(下架|成交|出租|刪除|結案|售出)|此(物件|案件|房屋|刊登|頁面)已(下架|不存在|刪除|成交|出租)|查無(此|該)?(物件|房屋|刊登)|物件不存在|找不到.{0,6}(物件|房屋|刊登|頁面)/;

// 通用 HTML 明細探測：404/410 或轉址到「查無物件」頁或明確下架字樣 → gone；其它保守 → alive。
export async function probeHtmlListingAlive(url, { redirectGoneMarkers = [], referer = "" } = {}) {
  const target = String(url || "").trim();
  if (!target) return true;
  let res;
  try {
    res = await fetch(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml", ...(referer ? { Referer: referer } : {}) },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return true; // 網路/逾時：保守視為仍在
  }
  if (res.status === 404 || res.status === 410) return false;
  const finalUrl = String(res.url || "");
  if (redirectGoneMarkers.some((m) => finalUrl.includes(m))) return false;
  if (!res.ok) return true; // 403/429/5xx：保守
  let html = "";
  try { html = await res.text(); } catch { return true; }
  if (redirectGoneMarkers.some((m) => html.includes(m))) return false;
  return GONE_TEXT.test(html) ? false : true;
}

// 依來源分派探測。回傳 { supported, alive }：supported=false 表示此來源不支援即時探測（如自刊 self）。
export async function probeListingAliveBySource(listing) {
  const source = String(listing?.source || "591") || "591";
  const url = String(listing?.url || "");
  if (source === "self") return { supported: false, alive: null };
  try {
    if (source === "591" || source === "") {
      await probe591Body(listing.post_id);
      return { supported: true, alive: true };
    }
    if (source === "houseprice") return { supported: true, alive: await probeHpListingAlive(url) };
    if (source === "housefun") return { supported: true, alive: await probeHtmlListingAlive(url, { redirectGoneMarkers: ["noobject"] }) };
    if (source === "hbhousing" || source === "sinyi" || source === "ddroom") {
      return { supported: true, alive: await probeHtmlListingAlive(url) };
    }
    return { supported: false, alive: null };
  } catch (error) {
    if ((source === "591" || source === "") && isListingGoneError(error)) return { supported: true, alive: false };
    return { supported: true, alive: true }; // 其它錯誤（含 591 暫時性）保守視為仍在
  }
}
