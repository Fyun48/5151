/** 居住數據（台灣房市／人口／居住相關統計）：後台可編輯、公開頁與 /api/housing-data 讀同一份。
   entries 每筆為一則指標；category 決定分組。B 階段自動抓取的資料會以 auto=true 併入同一份。 */

export const HOUSING_DATA_CATEGORIES = [
  { id: "population", label: "人口與年齡" },
  { id: "vacancy", label: "空屋率" },
  { id: "income", label: "薪資所得" },
  { id: "socialhousing", label: "社會住宅（社宅）" },
  { id: "foreign", label: "外籍在台工作者" },
  { id: "mobility", label: "日夜人口流動" },
  { id: "ltc", label: "長照資訊與申請" },
  { id: "other", label: "其他" },
];

const CATEGORY_IDS = new Set(HOUSING_DATA_CATEGORIES.map((c) => c.id));

export const DEFAULT_HOUSING_DATA_INTRO =
  "這裡整理與居住有關的公開統計與民間資料，供租屋決策參考。數字以標註的來源與更新時間為準；政府開放資料會定期自動更新，其餘由本站整理。歡迎回報更正。";

/** 預設先放「分類＋官方來源連結」的骨架，數值標為待更新，避免放上會過時的假數字；之後由後台或自動抓取填入。 */
export const DEFAULT_HOUSING_DATA_ENTRIES = [
  { category: "population", title: "全國總人口、各縣市人口與年齡結構", value: "待更新", note: "含年齡中位數、扶老比等", source: "內政部戶政司／國發會人口推估", sourceUrl: "https://www.ris.gov.tw/app/portal/346" },
  { category: "vacancy", title: "低度用電住宅（空屋）比率", value: "待更新", note: "以台電低度用電住宅估算，非戶籍空屋", source: "內政部不動產資訊平台", sourceUrl: "https://pip.moi.gov.tw/V3/E/SCRE0104.aspx" },
  { category: "income", title: "受僱員工全時薪資中位數／平均數", value: "待更新", note: "可分縣市與行業", source: "行政院主計總處 薪情平台", sourceUrl: "https://earnings.dgbas.gov.tw/" },
  { category: "socialhousing", title: "社會住宅興辦進度與各地區比例", value: "待更新", note: "只租不賣；一定比例保留給弱勢，租期有上限", source: "國家住宅及都市更新中心／內政部", sourceUrl: "https://www.hurc.org.tw/" },
  { category: "foreign", title: "外籍合法在台工作者人數", value: "待更新", note: "產業與社福移工、外國專業人員", source: "勞動部 勞動統計查詢網", sourceUrl: "https://statdb.mol.gov.tw/" },
  { category: "mobility", title: "白天／夜間人口與縣市間人口流動", value: "待更新", note: "由電信信令推估白晝、夜間人口差；目前僅政府定期報告釋出，無免費即時 API，依報告更新", source: "內政部 社會經濟資料服務平台（SEGIS）／主計總處 電信信令人口統計", sourceUrl: "https://segis.moi.gov.tw/" },
  { category: "ltc", title: "長照 2.0 服務與申請方式", value: "撥打 1966 長照專線，或洽各縣市長照管理中心", note: "失能、失智照顧、喘息服務、輔具與居家服務", source: "衛生福利部 長期照顧專區", sourceUrl: "https://1966.gov.tw/" },
];

const MAX_INTRO = 2000;
const MAX_ENTRIES = 200;
const MAX_FIELD = 300;
const MAX_URL = 500;

function clip(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeUrl(value) {
  const url = String(value ?? "").trim().slice(0, MAX_URL);
  return /^https?:\/\//i.test(url) ? url : "";
}

let seq = 0;
function entryId(given) {
  const id = String(given ?? "").trim().slice(0, 40);
  if (id) return id;
  seq += 1;
  return `hd_${Date.now().toString(36)}_${seq}`;
}

export function normalizeHousingEntry(value = {}) {
  const src = value && typeof value === "object" ? value : {};
  const category = CATEGORY_IDS.has(src.category) ? src.category : "other";
  return {
    id: entryId(src.id),
    category,
    title: clip(src.title, MAX_FIELD),
    value: clip(src.value, MAX_FIELD),
    note: clip(src.note, MAX_FIELD),
    source: clip(src.source, MAX_FIELD),
    sourceUrl: safeUrl(src.sourceUrl),
    asOf: clip(src.asOf, 40),
    auto: src.auto === true,
  };
}

export function defaultHousingData() {
  return {
    intro: DEFAULT_HOUSING_DATA_INTRO,
    entries: DEFAULT_HOUSING_DATA_ENTRIES.map((e) => normalizeHousingEntry(e)),
  };
}

export function normalizeHousingData(value = {}) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const intro = clip(src.intro, MAX_INTRO) || DEFAULT_HOUSING_DATA_INTRO;
  const rawEntries = Array.isArray(src.entries) ? src.entries : [];
  const entries = rawEntries
    .map((e) => normalizeHousingEntry(e))
    .filter((e) => e.title || e.value)
    .slice(0, MAX_ENTRIES);
  const updatedAt = clip(src.updatedAt, 40);
  return { intro, entries, updatedAt };
}

export function publicHousingData(value) {
  const data = normalizeHousingData(value && (value.entries || value.intro) ? value : defaultHousingData());
  return { intro: data.intro, entries: data.entries, updatedAt: data.updatedAt, categories: HOUSING_DATA_CATEGORIES };
}

/** 供 B 階段：以 (category + title) 當鍵，更新或插入自動抓取的一筆，不動管理員手改的其它筆。 */
export function upsertAutoEntry(data, entry) {
  const current = normalizeHousingData(data);
  const next = normalizeHousingEntry({ ...entry, auto: true });
  const key = (e) => `${e.category}::${e.title}`;
  const idx = current.entries.findIndex((e) => e.auto && key(e) === key(next));
  if (idx >= 0) current.entries[idx] = { ...next, id: current.entries[idx].id };
  else current.entries.push(next);
  return current;
}
