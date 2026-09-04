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
      answer: "檢查間隔改成全站共用抓取庫的節奏，由管理員在後台設定（建議約 15 分鐘）。會員可以在篩選功能表看到目前分鐘數，但不能改。物件寫進同一份資料庫，同一行政區不會因為會員變多就重複爬。管理員不再用「每次抓取頁數」這個欄位；系統內部用固定頁數抓摘要。",
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
      answer: "不是。591 進階網址、來源開關、系統抓取底庫是管理員用的。抓取頁數已從畫面拿掉。確認已下架天數與檢查間隔會員可以看、不能改。實際仍會依這些規則過濾與更新。",
    },
    {
      id: "notify-smtp",
      question: "為什麼物件通知要自己填 SMTP，系統信卻不用？",
      answer: "系統推播（加到主畫面後的鎖定畫面通知）與站內待看視窗是預設通道，不必填 SMTP。郵件與 Discord Webhook 是進階選用，走你自己的設定。註冊確認、確認連結失效通知、忘記密碼、變更密碼、贊助與管理員刪除通知才用站方 SMTP。",
    },
    {
      id: "pwa-ios",
      question: "iPhone 收得到鎖定畫面推播嗎？",
      answer: "可以，但要先用 Safari 開啟本站，點分享 → 加入主畫面，再從主畫面圖示打開並允許通知。在瀏覽器分頁裡通常收不到鎖定畫面推播。Android 用 Chrome 加入主畫面後也可以。",
    },
    {
      id: "self-listings",
      question: "可以在站內刊登自己的房子嗎？",
      answer: "可以。登入後到「有房刊登」先選縣市再選行政區，填可用坪數、樓層、路名與房屋特質（點選即可）。社區大樓可標中庭、陽台。電話與 LINE 選填。說明最多 500 字，可套用樣式。照片專區最多 100 張，上傳時會自動壓縮。必須勾選屋主／代理人聲明。同時最多 10 則、30 天後失效，新帳號需滿 24 小時。平台會抽查，不實刊登會下架並暫停上傳 14 天。這不是仲介認證、不保證真實。找房列表預設仍只顯示整層住家；房客可選「有中庭／有陽台」，只會篩站內刊登。",
    },
    {
      id: "demand-wall",
      question: "需求專區是即時私訊嗎？",
      answer: "不是。需求牆是公開的找房條件留言板：每人最多兩則未過期需求、14 天後失效，回覆大家看得到。沒有私訊、不是仲介、不經手金錢，也不保證媒合。訪客可以看，發文與回覆要登入；新帳號需滿 24 小時。平台可隱藏檢舉內容。",
    },
    {
      id: "extra-portals",
      question: "找房列表會不會出現 591 以外的網站？",
      answer: "會，但預設仍以 591 為主。管理員可另外打開住商、信義、5168、租租通、好房網：系統只抓該區租屋摘要，點進去是原站頁面，不是完整鏡像。樂屋被 Cloudflare 擋住，打開也不會抓。跨站若像同一間，會標成需確認同屋源，不會自動刪掉。列表可依「較適合」排序。這是免費找房工具，不是仲介、不經手金錢。",
    },
    {
      id: "listing-fit",
      question: "「較適合」是什麼分數？會不會預測成交？",
      answer: "不會。較適合排序是依你目前條件打的規則分（0–100），分數高的排前面。加分：租金落在你設的區間、整層住家、樓高夠、通勤在上限內、有電梯。扣分：租金超出、套房／非整層、1 樓或以下、樓層太矮、通勤超標、有額外費用。每人條件不同，不是成交預測、不是仲介評等，也不是原站的分數。",
    },
    {
      id: "not-broker",
      question: "這是仲介或成交平台嗎？",
      answer: "不是。這是免費找房追蹤工具，物件來自第三方網站的摘要與連結，不是完整鏡像。使用者自行判斷與聯絡，平台不保證媒合、不處理租金或合約。",
    },
    {
      id: "guest",
      question: "訪客模式能改搜尋條件嗎？",
      answer: "不能。訪客只能看示範列表。改行政區、儲存設定檔、特別關注都要先註冊。示範裡的公司地址與通勤也是固定範本。",
    },
    {
      id: "viewed-once",
      question: "要不要按「標記已瀏覽」？全新物件會一直通知嗎？",
      answer: "不用特意標記。點進物件（連回原站或打開站內刊登）就算已瀏覽，列表的「未瀏覽」會跟著更新。全新物件只通知一次，之後不會因為你有沒有點過再重發同一則新物件通知。",
    },
    {
      id: "notify-page",
      question: "「通知」這一頁是做什麼的？設定在哪裡？",
      answer: "通知頁上面是待看清單，下面是通知設定（推播、種類、Discord、自己的 SMTP），兩塊寬度對齊。「設定」放個人資料與帳號；刊登房子請到「有房刊登」。",
    },
    {
      id: "profile-nick",
      question: "暱稱會用在哪裡？",
      answer: "你在「設定」填的暱稱，會出現在帳號列、需求牆與回覆。沒填暱稱時，需求牆仍只顯示遮罩後的信箱。居住地、公司、電話、LINE 預設不公開。系統沒有即時私訊。",
    },
    {
      id: "self-verify",
      question: "站內刊登有沒有認證屋主？會不會保證不是假的？",
      answer: "沒有權狀認證，也不會標「已驗證屋主」。刊登者必須自行聲明是屋主或代理人；平台會抽查，兩人檢舉或不實就下架並暫停上傳 14 天。請仍以現場與合約為準，平台不負法律擔保。",
    },
    {
      id: "profile-privacy",
      question: "個人資料會不會被拿去公開或外流？",
      answer: "居住地、公司、電話、LINE 與聯絡信箱只存在你的會員資料，預設不公開、也不會自動貼到刊登。本站依提供服務所需處理，不做專責保管、不轉售、也不主動散給第三人；除非法律要求，或你另外同意公開。可隨時改或清空。",
    },
    {
      id: "self-rich",
      question: "刊登一定要把特質都勾完嗎？",
      answer: "不用勉強。不過來看的人最常問的，多半就是中庭、陽台、開伙、寵物這些。點選寫清楚，對方通常能先自己判斷，比較少一再問同一句，聯絡方式也不容易被無關問題佔滿。",
    },
    {
      id: "register-verify",
      question: "註冊後為什麼不能立刻登入？",
      answer: "要先到信箱點確認連結才算註冊成功，點過會自動登入，這個連結只能用一次。3 天內沒點，連結會失效，系統會再寄一封失效通知；之後請用同一個信箱重新註冊，會再寄新的確認信。",
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

/** 後台已存過 Q&A 時，仍補上程式新增、尚未寫入的預設條目。 */
export function mergeMissingDefaultHelpQa(items) {
  const out = normalizeHelpQaItems(items);
  const have = new Set(out.map((row) => row.id));
  for (const row of defaultHelpQaItems()) {
    if (row.id && !have.has(row.id)) out.push(row);
  }
  return out.slice(0, 40);
}

export function publicHelpQa(items) {
  return { items: normalizeHelpQaItems(items) };
}
