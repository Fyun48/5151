/** 站內刊登的房屋特質：用點選，不要做成 591 那種長表單。 */

export const SELF_TRAIT_GROUPS = [
  {
    id: "living",
    label: "生活條件",
    items: [
      { id: "cook", label: "可開伙" },
      { id: "pet", label: "可養寵物" },
      { id: "short", label: "可短租" },
      { id: "tax", label: "可報稅" },
      { id: "mrt", label: "近捷運" },
    ],
  },
  {
    id: "building",
    label: "建物",
    items: [
      { id: "elevator", label: "有電梯" },
      { id: "parking", label: "有車位" },
      { id: "community", label: "社區大樓" },
      { id: "courtyard", label: "有中庭" },
      { id: "balcony", label: "有陽台" },
      { id: "manage", label: "有管理室" },
      { id: "trash", label: "垃圾集中" },
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
      { id: "heater", label: "熱水器" },
      { id: "bed", label: "床" },
      { id: "closet", label: "衣櫃" },
      { id: "sofa", label: "沙發" },
    ],
  },
  {
    id: "who",
    label: "適合對象（可複選）",
    items: [
      { id: "anygender", label: "不限性別" },
      { id: "female", label: "限女性" },
      { id: "male", label: "限男性" },
      { id: "student", label: "學生可" },
      { id: "worker", label: "上班族佳" },
    ],
  },
];

export const SELF_DEPOSIT_OPTIONS = [
  { id: "one", label: "押金一個月" },
  { id: "two", label: "押金兩個月" },
  { id: "talk", label: "押金面議" },
];

export const SELF_BODY_TEMPLATES = [
  {
    id: "family",
    label: "家庭整層",
    text: "屋況整潔、採光佳，適合小家庭。可使用坪數已扣除公設。社區大樓可順便標中庭、陽台。可遷入日可再約看屋時間確認。沒有站內私訊，請用公開電話或 LINE 聯絡。",
  },
  {
    id: "suite",
    label: "套房自住",
    text: "獨立衛浴，家具家電可再看現場。可使用坪數已扣除公設。有陽台或中庭的話點一下就好。適合一人入住。沒有站內私訊，請用公開電話或 LINE 聯絡。",
  },
  {
    id: "near-mrt",
    label: "近捷運通勤",
    text: "步行可到捷運，適合通勤。可使用坪數已扣除公設。社區大樓可順便標中庭、陽台。歡迎先約看再決定。沒有站內私訊，請用公開電話或 LINE 聯絡。",
  },
];

const ALL_TRAITS = new Map(
  SELF_TRAIT_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label])),
);

export function normalizeSelfTraits(input) {
  const raw = Array.isArray(input) ? input : [];
  const ids = [];
  for (const item of raw) {
    const id = String(item || "").trim();
    if (ALL_TRAITS.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 28);
}

export function selfTraitLabels(ids) {
  return normalizeSelfTraits(ids).map((id) => ALL_TRAITS.get(id)).filter(Boolean);
}

export function normalizeDeposit(value) {
  const id = String(value || "").trim();
  return SELF_DEPOSIT_OPTIONS.some((row) => row.id === id) ? id : "";
}

export function depositLabel(id) {
  return SELF_DEPOSIT_OPTIONS.find((row) => row.id === id)?.label || "";
}
