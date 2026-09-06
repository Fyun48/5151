/** 居住數據自動抓取（B 階段）。每個 fetcher 回傳 entries[]，失敗只記錄不拋出，寫入時標 auto=true。
   目前來源：內政部戶政司 ODRP019（村里戶數／人口）→ 加總為雙北與全國戶籍人口（性別欄位相加＝該區登記總人口，數值明確）。 */

import { normalizeHousingData, upsertAutoEntry } from "./housingData.js";

const UA = "Mozilla/5.0 (compatible; JibbyRentBot/1.0)";
const RIS_POPULATION = "https://www.ris.gov.tw/rs-opendata/api/v1/datastore/ODRP019";
const PERSON_COLS = [
  "household_ordinary_m", "household_ordinary_f",
  "household_business_m", "household_business_f",
  "household_single_m", "household_single_f",
];
const HOUSEHOLD_COLS = [
  "household_ordinary_total", "household_business_total", "household_single_total",
];

export function rocYearNow(now = new Date()) {
  return now.getFullYear() - 1911;
}

async function defaultGetJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function cityKey(siteId) {
  const s = String(siteId || "").trim();
  const m = s.match(/^(.{2}[市縣])/);
  return m ? m[1] : "";
}

function formatPersons(n) {
  return n > 0 ? `${n.toLocaleString("en-US")} 人` : "";
}

/** 內政部戶政司 ODRP019：加總雙北與全國戶籍人口。回傳 population 分類的 entries。 */
export async function fetchRisPopulation({ getJson = defaultGetJson, year, now = new Date() } = {}) {
  const years = year ? [year] : [rocYearNow(now), rocYearNow(now) - 1];
  for (const y of years) {
    let first;
    try {
      first = await getJson(`${RIS_POPULATION}/${y}?page=1`);
    } catch {
      continue;
    }
    if (String(first?.responseCode || "") !== "OD-0101-S") continue;
    if (!Array.isArray(first.responseData) || !first.responseData.length) continue;
    const totalPage = Math.min(Math.max(1, Number(first.totalPage) || 1), 20);
    const persons = {};
    const houses = {};
    const addRows = (rows) => {
      for (const row of rows || []) {
        const p = PERSON_COLS.reduce((acc, key) => acc + (Number(row[key]) || 0), 0);
        const h = HOUSEHOLD_COLS.reduce((acc, key) => acc + (Number(row[key]) || 0), 0);
        const city = cityKey(row.site_id);
        if (city) { persons[city] = (persons[city] || 0) + p; houses[city] = (houses[city] || 0) + h; }
        persons["全國"] = (persons["全國"] || 0) + p;
        houses["全國"] = (houses["全國"] || 0) + h;
      }
    };
    addRows(first.responseData);
    for (let page = 2; page <= totalPage; page += 1) {
      const j = await getJson(`${RIS_POPULATION}/${y}?page=${page}`);
      addRows(j?.responseData);
    }
    const asOf = `民國${y}年`;
    const src = "內政部戶政司";
    const url = "https://www.ris.gov.tw/app/portal/346";
    const entries = [];
    const pushPop = (title, n) => { if (n > 0) entries.push({ category: "population", title, value: formatPersons(n), note: "戶籍登記人口（村里加總）", source: src, sourceUrl: url, asOf }); };
    const pushSize = (title, p, h) => { if (p > 0 && h > 0) entries.push({ category: "population", title, value: `${(p / h).toFixed(2)} 人/戶`, note: "戶籍人口 ÷ 戶數（家庭規模，越小通常租屋需求越高）", source: src, sourceUrl: url, asOf }); };
    pushPop("臺北市 戶籍人口", persons["臺北市"] || 0);
    pushPop("新北市 戶籍人口", persons["新北市"] || 0);
    pushPop("全國 戶籍人口", persons["全國"] || 0);
    pushSize("臺北市 平均每戶人口", persons["臺北市"] || 0, houses["臺北市"] || 0);
    pushSize("新北市 平均每戶人口", persons["新北市"] || 0, houses["新北市"] || 0);
    pushSize("全國 平均每戶人口", persons["全國"] || 0, houses["全國"] || 0);
    if (entries.length) return entries;
  }
  return [];
}

export const HOUSING_FETCHERS = [fetchRisPopulation];

/** 跑所有 fetcher，把結果以 auto 方式併入資料並寫回。getData/writeData 由 db 提供，方便測試注入。 */
export async function refreshHousingData({ fetchers = HOUSING_FETCHERS, getData, writeData, now = new Date() } = {}) {
  const errors = [];
  const updated = [];
  let data = normalizeHousingData(getData ? getData() : {});
  for (const fetcher of fetchers) {
    try {
      const entries = await fetcher({ now });
      for (const entry of entries || []) {
        data = upsertAutoEntry(data, entry);
        updated.push(`${entry.category}:${entry.title}`);
      }
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
  data.updatedAt = now.toISOString();
  if (writeData) writeData(data);
  return { updated, errors, count: updated.length, at: data.updatedAt };
}
