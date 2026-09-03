/** 功能表說明 Q&A：預設條目與正規化。管理員可改、可新增。 */

export function defaultHelpQaItems() {
  return [
    {
      id: "mrt-walk",
      question: "為什麼有的物件有顯示捷運站，有的卻沒有？",
      answer: "顯示與否看的是「人走得了的地圖路線」，不是房子到捷運站的直線距離。系統會用地圖算出可步行的最短路徑；只有步行距離未滿 1.5 公里才會顯示站名與「步行約 xx 公里」。直線看起來很近、但要繞路走到 1.5 公里（含）以上，或還沒算出步行路線、沒有可信座標時，都不會顯示站名。捷運這一欄也不會再顯示騎車或分鐘。",
    },
    {
      id: "interval",
      question: "為什麼一般會員看不到、也不能改檢查間隔？",
      answer: "檢查間隔是全站共用節奏，一般會員固定約每 8 分鐘、贊助會員約每 5 分鐘。畫面上只看得到說明，不能自行改短，避免對 591 造成過重負擔。管理員才能改間隔、每次抓取頁數與確認下架天數。",
    },
    {
      id: "districts-profiles",
      question: "為什麼行政區與設定檔有上限？",
      answer: "一般會員每個設定檔最多選 10 個行政區（可跨縣市），每個帳號最多 3 個設定檔。這是強制上限，用來控制全站實際要抓的覆蓋範圍。管理員不受此限。",
    },
    {
      id: "commute",
      question: "通勤公里是怎麼算的？為什麼有的物件不見了？",
      answer: "上班地址與路線上限開啟後，距離是用地圖上機車或汽車「可走的路」計算，不是直線。兩條替代路線都超過你設的公里上限，該物件就不會出現在列表，也不會通知。機車與汽車同時只能選一種。",
    },
    {
      id: "hidden-admin",
      question: "功能表上有些欄位會員看不到，是不是沒設定？",
      answer: "不是。抓取頁數、確認已下架天數、檢查間隔等是後台強制設定，一般會員畫面刻意不顯示、也不能改。實際仍會依這些規則過濾與更新。細節以這份 Q&A 與後台說明為準。",
    },
    {
      id: "notify-smtp",
      question: "為什麼物件通知要自己填 SMTP，系統信卻不用？",
      answer: "系統推播（加到主畫面後的鎖定畫面通知）與站內待看視窗是預設通道，不必填 SMTP。郵件與 Discord Webhook 是進階選用，走你自己的設定。註冊歡迎、忘記密碼、變更密碼、贊助與管理員刪除通知才用站方 SMTP。",
    },
    {
      id: "pwa-ios",
      question: "iPhone 收得到鎖定畫面推播嗎？",
      answer: "可以，但要先用 Safari 開啟本站，點分享 → 加入主畫面，再從主畫面圖示打開並允許通知。在瀏覽器分頁裡通常收不到鎖定畫面推播。Android 用 Chrome 加入主畫面後也可以。",
    },
    {
      id: "self-listings",
      question: "可以在站內刊登自己的房子嗎？",
      answer: "可以。登入後到「我的」填行政區、租金、坪數、樓層、地址與公開聯絡方式。同時最多 3 則、30 天後失效，新帳號需滿 24 小時。不是仲介、沒有私訊、不經手金錢。找房列表預設仍只顯示整層住家（與 591 相同）；若判定可能與 591 同一間，會標成需確認同屋源，不會自動刪掉。",
    },
    {
      id: "demand-wall",
      question: "需求專區是即時私訊嗎？",
      answer: "不是。需求牆是公開的找房條件留言板：每人最多兩則未過期需求、14 天後失效，回覆大家看得到。沒有私訊、不是仲介、不經手金錢，也不保證媒合。訪客可以看，發文與回覆要登入；新帳號需滿 24 小時。平台可隱藏檢舉內容。",
    },
    {
      id: "extra-portals",
      question: "找房列表會不會出現 591 以外的網站？",
      answer: "會，但預設仍以 591 為主。管理員可另外打開住商不動產：系統只抓該區租屋摘要，點進去是住商原頁，不是完整鏡像。樂屋、信義若被網站擋住就先不抓。跨站若像同一間，會標成需確認同屋源，不會自動刪掉。這是免費找房工具，不是仲介、不經手金錢。",
    },
    {
      id: "not-broker",
      question: "這是仲介或成交平台嗎？",
      answer: "不是。這是免費找房追蹤工具，物件來自第三方網站的摘要與連結，不是完整鏡像。使用者自行判斷與聯絡，平台不保證媒合、不處理租金或合約。",
    },
    {
      id: "guest",
      question: "訪客模式能改搜尋條件嗎？",
      answer: "不能。訪客只能看示範列表。改行政區、儲存設定檔、標記已瀏覽／特別關注、立即檢查都要先註冊。示範裡的公司地址與通勤也是固定範本。",
    },
  ];
}

function slugId(value, fallback) {
  const raw = String(value || "").trim().slice(0, 40);
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(raw)) return raw;
  return fallback;
}

export function normalizeHelpQaItems(input) {
  const src = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  src.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    const question = String(row.question || "").trim().slice(0, 200);
    const answer = String(row.answer || "").trim().slice(0, 4000);
    if (!question || !answer) return;
    let id = slugId(row.id, `qa${index + 1}`);
    if (seen.has(id)) id = `qa${index + 1}_${out.length + 1}`;
    seen.add(id);
    out.push({ id, question, answer });
  });
  return out.slice(0, 40);
}

export function publicHelpQa(items) {
  return { items: normalizeHelpQaItems(items) };
}
