/** 站內刊登的房屋特質：用點選，不要做成 591 那種長表單。
 *
 * 重要（向後相容）：特質是以「id 陣列」存在 listings.self_traits，勾選＝該 id 出現。
 * 因此改標籤時絕不能讓既有資料語意反轉：
 *  - 新增的「否定條件」使用「全新 id」（nocook/nopet/notax），不重用舊的正向 id。
 *  - 舊的正向/已移除 id（cook/pet/tax/mrt 與「適合對象」who 群）移到 LEGACY_TRAIT_LABELS，
 *    仍可正確「顯示」歷史刊登，但「新刊登」不再提供、也不接受（見 normalizeSelfTraitsInput）。
 *  - 少數只是「顯示文字微調且語意不反轉」的 id（trash/manage/community/elevator/heater）維持同 id，
 *    僅更新標籤（presence 仍代表「具備該建物/設備特徵」）。
 */

export const SELF_TRAIT_GROUPS = [
  {
    id: "living",
    label: "生活條件",
    items: [
      { id: "nocook", label: "不可開伙" },
      { id: "nopet", label: "不可養寵物" },
      { id: "notax", label: "不可報稅／不可租補" },
      { id: "short", label: "可短租" },
    ],
  },
  {
    id: "building",
    label: "建物",
    items: [
      { id: "elevator", label: "電梯華廈／寓" },
      { id: "parking", label: "有車位" },
      { id: "community", label: "電梯大樓" },
      { id: "courtyard", label: "有中庭" },
      { id: "balcony", label: "有陽台" },
      { id: "manage", label: "有門衛管理" },
      { id: "trash", label: "社區定時定點集中收垃圾" },
      { id: "trash24", label: "24H 大樓回收垃圾" },
      { id: "parcel", label: "代收包裹快遞" },
    ],
  },
  {
    id: "gear",
    label: "設備",
    items: [
      { id: "ac", label: "冷氣" },
      { id: "washer", label: "洗衣機" },
      { id: "fridge", label: "冰箱" },
      { id: "net", label: "網路" },
      { id: "cable", label: "第四台" },
      { id: "heater", label: "瓦斯熱水器" },
      { id: "heater_e", label: "電熱水器" },
      { id: "bed", label: "床" },
      { id: "closet", label: "衣櫃" },
      { id: "sofa", label: "沙發" },
      { id: "dining", label: "餐桌" },
    ],
  },
];

// 已停用（deprecated）但仍需正確顯示歷史刊登的 id → 標籤。新刊登不再提供、也不接受。
export const LEGACY_TRAIT_LABELS = {
  cook: "可開伙",
  pet: "可養寵物",
  tax: "可報稅",
  mrt: "近捷運",
  // 已完全移除的「適合對象」（降低居住歧視）；僅保留歷史顯示。
  anygender: "不限性別",
  female: "限女性",
  male: "限男性",
  student: "學生可",
  worker: "上班族佳",
};

export const SELF_DEPOSIT_OPTIONS = [
  { id: "one", label: "押金一個月" },
  { id: "two", label: "押金兩個月" },
  { id: "talk", label: "押金面議" },
];

// 保留（供 API 相容）；UI 已移除 3 個罐頭訊息套用按鈕。
export const SELF_BODY_TEMPLATES = [
  { id: "family", label: "家庭整層", text: "屋況整潔、採光佳，適合小家庭。可使用坪數已扣除公設。可遷入日可再約看屋時間確認。沒有站內私訊，請用公開電話或 LINE 聯絡。" },
  { id: "suite", label: "套房自住", text: "獨立衛浴，家具家電可再看現場。可使用坪數已扣除公設。適合一人入住。沒有站內私訊，請用公開電話或 LINE 聯絡。" },
];

// 目前刊登表單提供的「有效」id（新刊登只接受這些）。
const ACTIVE_TRAITS = new Map(
  SELF_TRAIT_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label])),
);
// 顯示用：有效 + 已停用（歷史相容）。
const ALL_TRAITS = new Map([...ACTIVE_TRAITS, ...Object.entries(LEGACY_TRAIT_LABELS)]);

const TRAIT_CAP = 40;

// 顯示用正規化：接受「所有已知 id」（含 legacy），保序去重、上限。歷史刊登不會遺失標籤。
export function normalizeSelfTraits(input) {
  const raw = Array.isArray(input) ? input : [];
  const ids = [];
  for (const item of raw) {
    const id = String(item || "").trim();
    if (ALL_TRAITS.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, TRAIT_CAP);
}

// 新刊登輸入正規化：只接受「目前表單提供的有效 id」；停用/歧視性/已移除 id 一律丟棄，避免寫入新資料。
export function normalizeSelfTraitsInput(input) {
  const raw = Array.isArray(input) ? input : [];
  const ids = [];
  for (const item of raw) {
    const id = String(item || "").trim();
    if (ACTIVE_TRAITS.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, TRAIT_CAP);
}

export function selfTraitLabels(ids) {
  const raw = Array.isArray(ids) ? ids : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item || "").trim();
    if (ALL_TRAITS.has(id) && !seen.has(id)) { seen.add(id); out.push(ALL_TRAITS.get(id)); }
  }
  return out.slice(0, TRAIT_CAP);
}

export function normalizeDeposit(value) {
  const id = String(value || "").trim();
  return SELF_DEPOSIT_OPTIONS.some((row) => row.id === id) ? id : "";
}

export function depositLabel(id) {
  return SELF_DEPOSIT_OPTIONS.find((row) => row.id === id)?.label || "";
}
