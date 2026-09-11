// LLM 同源確認與爬蟲洞察：兩個 category 分開開關，失敗就略過。
// 不可送整頁 HTML 或會員個資。洞察只當提示，不覆寫已結構化欄位。

import { createHash } from "node:crypto";
import { executeWithProvider } from "./executeWithProvider.js";
import { getBoundBudgetDb, loadEnabledProvider, readCredential } from "../budgetGuard.js";
import { houseNumber, streetKey } from "../match.js";

export const PACK7_LLM_BASELINE = "pack7-llm-same-house-v1";
export const PACK7_INSIGHT_BASELINE = "pack7-llm-crawl-insight-v1";

const TITLE_MAX = 120;
const NOTE_MAX = 400;
const TAG_MAX = 8;

function stripHtml(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripPii(text) {
  return stripHtml(text)
    .replace(/[Ａ-Ｚａ-ｚ０-９．＿％＋－]+＠[Ａ-Ｚａ-ｚ０-９．－]+．[Ａ-Ｚａ-ｚ]{2,}/g, "")
    .replace(/[A-Z0-9._%+-]+\s*@\s*[A-Z0-9.-]+\s*\.\s*[A-Z]{2,}/gi, "")
    .replace(/\+?886[-.\s]?0?9[\d\s-]{8,}/g, "")
    .replace(/09[\s-]?\d{2,4}[\s-]?\d{3,4}/g, "")
    .replace(/0\d{1,2}[-\s]?\d{6,8}/g, "")
    .replace(/[０-９]{8,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fuzzyAddress(address) {
  const street = streetKey(address);
  if (street) return street.slice(0, 40);
  return stripPii(String(address || "").replace(houseNumber(address), "")).slice(0, 40);
}

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map((item) => stripPii(item)).filter(Boolean).slice(0, TAG_MAX);
  try {
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) return parsed.map((item) => stripPii(item)).filter(Boolean).slice(0, TAG_MAX);
  } catch {
    // ignore
  }
  return String(raw || "")
    .split(/[,|、]/)
    .map((item) => stripPii(item))
    .filter(Boolean)
    .slice(0, TAG_MAX);
}

export function listingLlmSlice(listing) {
  return {
    title: stripPii(listing?.title).slice(0, TITLE_MAX),
    note: stripPii(listing?.self_body || listing?.extra_fee_text || listing?.price_contain_text || "").slice(0, NOTE_MAX),
    fuzzy_address: fuzzyAddress(listing?.address),
    tags: parseTags(listing?.tags),
  };
}

export function sanitizeSameHousePayload(a, b) {
  return { a: listingLlmSlice(a), b: listingLlmSlice(b) };
}

export function assertSafeLlmPayload(payload) {
  const text = JSON.stringify(payload || {});
  if (/<!doctype|<html|<\/html>|password|authorization|cookie:/i.test(text)) {
    const err = new Error("unsafe llm payload");
    err.code = "unsafe_payload";
    throw err;
  }
  if (
    /\+?886[-.\s]?0?9[\d\s-]{8,}/.test(text)
    || /09[\s-]?\d{2,4}[\s-]?\d{3,4}/.test(text)
    || /[A-Z0-9._%+-]+\s*@\s*[A-Z0-9.-]+\s*\.\s*[A-Z]{2,}/i.test(text)
  ) {
    const err = new Error("pii in llm payload");
    err.code = "pii_payload";
    throw err;
  }
  return payload;
}

export function normalizeSameHouseVerdict(raw) {
  if (!raw || typeof raw !== "object") return { verdict: "uncertain", confidence: 0 };
  const text = String(raw.verdict || raw.result || (raw.is_same === true ? "same" : raw.is_same === false ? "different" : "")).toLowerCase();
  let verdict = "uncertain";
  if (text === "same" || text === "yes" || text === "true") verdict = "same";
  else if (text === "different" || text === "no" || text === "false") verdict = "different";
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  return { verdict, confidence };
}

export function sourceTextHash(listing) {
  const slice = listingLlmSlice(listing);
  return createHash("sha256").update(JSON.stringify(slice)).digest("hex").slice(0, 32);
}

async function callOpenAiCompat(cfg, db, body) {
  const key = readCredential(db, cfg);
  if (!key) throw new Error("missing llm credential");
  const endpoint = String(cfg.endpoint || "").trim()
    || (cfg.provider_code === "qwen"
      ? "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions");
  const model = String(cfg.model_id || "").trim() || (cfg.provider_code === "qwen" ? "qwen-flash" : "gpt-4o-mini");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: body.messages,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`llm HTTP ${res.status}`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { verdict: "uncertain", confidence: 0 };
  }
}

export async function compareSameHouseWithLlm(db, a, b, opts = {}) {
  const database = db || getBoundBudgetDb();
  const payload = assertSafeLlmPayload(sanitizeSameHousePayload(a, b));
  const fallback = async () => null;
  if (typeof opts.llmCompare === "function") {
    return opts.llmCompare(payload);
  }
  return executeWithProvider({
    db: database,
    category: "llm",
    costCeilingMinor: opts.costCeilingMinor,
    now: opts.now,
    fallbackAction: fallback,
    actionWithProvider: async (cfg) => {
      if (cfg.provider_code === "stub_paid") {
        const forced = opts.stubVerdict || { verdict: "uncertain", confidence: 0 };
        return { value: normalizeSameHouseVerdict(forced), usage: { costMinor: Number(cfg.ceiling_minor) || 0 } };
      }
      const parsed = await callOpenAiCompat(cfg, database, {
        messages: [
          { role: "system", content: "判斷兩筆租屋廣告是否同一戶。只回 JSON：verdict=same|different|uncertain，confidence=0到1。門牌或樓層衝突時回 different。不要推論未提供的個資。" },
          { role: "user", content: JSON.stringify(payload) },
        ],
      });
      return {
        value: normalizeSameHouseVerdict(parsed),
        usage: { costMinor: Number(cfg.ceiling_minor) || 0 },
      };
    },
  });
}

export function normalizeInsightHints(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const confidence = Math.max(0, Math.min(1, Number(src.confidence) || 0));
  return {
    floor: stripPii(src.floor).slice(0, 40),
    parking: stripPii(src.parking).slice(0, 40),
    rooftop: stripPii(src.rooftop).slice(0, 40),
    fees: stripPii(src.fees).slice(0, 80),
    confidence,
  };
}

export async function extractCrawlInsight(db, listing, opts = {}) {
  const database = db || getBoundBudgetDb();
  const payload = assertSafeLlmPayload({ listing: listingLlmSlice(listing) });
  if (typeof opts.llmInsight === "function") {
    return opts.llmInsight(payload);
  }
  return executeWithProvider({
    db: database,
    category: "llm_crawl_insight",
    costCeilingMinor: opts.costCeilingMinor,
    now: opts.now,
    fallbackAction: async () => null,
    actionWithProvider: async (cfg) => {
      if (cfg.provider_code === "stub_paid") {
        return {
          value: normalizeInsightHints(opts.stubInsight || { confidence: 0 }),
          usage: { costMinor: Number(cfg.ceiling_minor) || 0 },
        };
      }
      const parsed = await callOpenAiCompat(cfg, database, {
        messages: [
          { role: "system", content: "從租屋廣告的標題、說明與標籤抽出樓層、車位、頂加、費用。只回 JSON：floor,parking,rooftop,fees,confidence。沒看到就留空。這是提示不是判決。" },
          { role: "user", content: JSON.stringify(payload) },
        ],
      });
      return {
        value: normalizeInsightHints(parsed),
        usage: { costMinor: Number(cfg.ceiling_minor) || 0 },
      };
    },
  });
}

export function llmEnabled(db, category) {
  return Boolean(loadEnabledProvider(db, category));
}
