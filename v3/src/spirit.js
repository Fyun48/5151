/** 本站理念（「這個站為什麼存在」）文案：後台可改，spirit.html 讀同一份。
   body 用極簡標記：`## 標題`＝小標、`- 項目`＝條列、空行＝分段，其餘為段落。 */

export const DEFAULT_SPIRIT_TITLE = "這個站為什麼存在";

export const DEFAULT_SPIRIT_BODY = `吉比租房物件追蹤是免費工具。目的不是再做一個比較會推播的仲介牆，而是讓租屋的人把價格、條件、同一間房的重刊，看清楚一點。

時代變了：薪資停滯、少子化、大繼承將至。買不起房的人仍要租。居住不是口號，是每個月要付出去的錢、以及能不能把屋況講清楚。

## 我們看見的問題
- 大型租屋平台會員很多，卻沒有硬性要求屋況寫完整；刊登說下架就下架，電話可接可不接。
- 第三方進駐分潤（仲介、包租代管）常常只是把價格墊高。政府說會管，租客仍難檢驗「有沒有跟房東一起把租金抬上去」。
- 包租代管若沒有真正壓低租客負擔、也沒有可驗證的屋況責任，就接近浪費納稅人的錢，帶不來居住正義。
- 北漂年輕人、長者租屋一年比一年難。沒有人該被當成流量。

## 這個站怎麼做事
- 把各來源租屋摘要放在一起比，像比價，而不是再幫平台養會員。
- 特別關注、不再顯示、同屋源比對，讓你少被同一間房重複騷擾。
- 自行刊登要聲明、可抽查、可檢舉下架。不標「已認證」、不驗權狀。
- 站內廣告與贊助提醒可以關；我們不靠把電話藏起來賺錢。

## 接下來會補的
台灣房市與租金的公開整理、惡劣房東與不當包租行為的紀錄方式。未來房價、人口、失業率怎麼走，沒有人能打包票；但租客需要的是可核對的資料，不是口號。

人用得愈多，只想抬價的業者就愈難假裝這個站不存在。這需要大家一起用、一起回報不實刊登。`;

const MAX_TITLE = 120;
const MAX_BODY = 8000;

export function defaultSpirit() {
  return { title: DEFAULT_SPIRIT_TITLE, body: DEFAULT_SPIRIT_BODY };
}

export function normalizeSpirit(value = {}) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const d = defaultSpirit();
  const title = String(src.title ?? "").trim().slice(0, MAX_TITLE) || d.title;
  const body = String(src.body ?? "").replace(/\r\n/g, "\n").slice(0, MAX_BODY) || d.body;
  return { title, body };
}

export function publicSpirit(value) {
  return normalizeSpirit(value);
}
