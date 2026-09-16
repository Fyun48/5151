/** 吉比後台資訊架構：分類、深連結、功能搜尋、常用、未儲存提示。 */
(function adminIa(global) {
  const FAVORITES_KEY = "jibby-admin-favorites";

  const PAGES = [
    {
      id: "overview",
      group: "overview",
      groupLabel: "總覽",
      label: "總覽",
      blurb: "先看系統現在有沒有問題，再進各區操作。",
      aliases: ["首頁", "dashboard", "狀態", "總覽"],
    },
    {
      id: "inventory/sources",
      group: "inventory",
      groupLabel: "房源與資料",
      label: "房源來源",
      blurb: "啟用或關閉各站抓取來源，並查看最近成功與今日新增。",
      aliases: ["物件來源", "來源開關", "591", "住商", "信義", "5168", "租租通", "好房網", "樂屋", "樂屋網", "rakuya", "爬蟲來源"],
    },
    {
      id: "inventory/crawl",
      group: "inventory",
      groupLabel: "房源與資料",
      label: "抓取範圍與排程",
      blurb: "全站抓取間隔、確認已下架天數、行政區 coverage、底庫與最近一輪結果。",
      aliases: ["系統抓取底庫", "抓取底庫", "行政區", "間隔", "排程", "底庫", "下架", "確認已下架", "天數"],
    },
    {
      id: "inventory/same-house",
      group: "inventory",
      groupLabel: "房源與資料",
      label: "同房源判定",
      blurb: "批次 reconciliation 與管理員全站確認同一房源。",
      aliases: ["同房源", "同屋源", "reconcile", "合併", "疑似同房源"],
    },
    {
      id: "inventory/imports",
      group: "inventory",
      groupLabel: "房源與資料",
      label: "外部物件匯入",
      blurb: "查看會員從外站匯入的草稿與處理狀態。",
      aliases: ["外部匯入", "匯入", "import"],
    },
    {
      id: "inventory/health",
      group: "inventory",
      groupLabel: "房源與資料",
      label: "資料健康度",
      blurb: "底庫缺地址、座標、樓層、坪數等欄位的數量。",
      aliases: ["健康度", "缺欄位", "缺座標", "缺地址"],
    },
    {
      id: "members/users",
      group: "members",
      groupLabel: "會員與權限",
      label: "會員管理",
      blurb: "查會員、改方案與間隔；刪除放在危險操作。",
      aliases: ["會員", "刪除會員", "帳號", "方案", "間隔"],
    },
    {
      id: "members/plans",
      group: "members",
      groupLabel: "會員與權限",
      label: "方案與限制",
      blurb: "一般／已贊助的間隔、關注與刊登上限（現行產品規則）。",
      aliases: ["贊助方案", "關注上限", "刊登上限"],
    },
    {
      id: "members/guest",
      group: "members",
      groupLabel: "會員與權限",
      label: "訪客權限",
      blurb: "Guest 與 Member 的功能邊界。這裡不改前台搜尋語意。",
      aliases: ["訪客", "guest", "未登入", "訪客搜尋"],
    },
    {
      id: "members/login",
      group: "members",
      groupLabel: "會員與權限",
      label: "登入政策",
      blurb: "Email 開通與社群登入入口（金鑰在系統與整合）。",
      aliases: ["登入", "驗證信", "開通"],
    },
    {
      id: "content/brand",
      group: "content",
      groupLabel: "站台內容",
      label: "品牌與 Logo",
      blurb: "吉比形象、圓標與短片文案。",
      aliases: ["形象", "Logo", "吉比形象", "圓標", "吉比"],
    },
    {
      id: "content/spirit",
      group: "content",
      groupLabel: "站台內容",
      label: "本站理念",
      blurb: "spirit.html 顯示的理念文字。",
      aliases: ["理念", "為什麼存在"],
    },
    {
      id: "content/legal",
      group: "content",
      groupLabel: "站台內容",
      label: "法律與個資",
      blurb: "免責聲明與個資說明本文。",
      aliases: ["免責", "個資", "宣告", "隱私", "法律"],
    },
    {
      id: "content/cms",
      group: "content",
      groupLabel: "站台內容",
      label: "內容版本庫",
      blurb: "草稿、預覽、發布與歷史版本。",
      aliases: ["版本庫", "CMS", "再同意", "刊登規則"],
    },
    {
      id: "content/qa",
      group: "content",
      groupLabel: "站台內容",
      label: "功能說明 Q&A",
      blurb: "前台功能說明條目。",
      aliases: ["Q&A", "QA", "功能說明", "常見問題"],
    },
    {
      id: "content/housing",
      group: "content",
      groupLabel: "站台內容",
      label: "居住數據",
      blurb: "data.html 的指標與開放資料更新。",
      aliases: ["居住數據", "戶籍", "開放資料"],
    },
    {
      id: "rental/catalog",
      group: "rental",
      groupLabel: "租屋與配對",
      label: "共用條件目錄",
      blurb: "刊登與求租條件共用的分類與名稱。",
      aliases: ["條件目錄", "catalog", "共用條件"],
    },
    {
      id: "rental/listing",
      group: "rental",
      groupLabel: "租屋與配對",
      label: "有房刊登設定",
      blurb: "哪些共用條件出現在有房刊登表單。",
      aliases: ["刊登條件", "self traits", "房屋條件"],
    },
    {
      id: "rental/wish",
      group: "rental",
      groupLabel: "租屋與配對",
      label: "許願房設定",
      blurb: "許願房可選條件、生命週期與相容選單。",
      aliases: ["許願房", "許願", "條件選單", "必須有"],
    },
    {
      id: "rental/rules",
      group: "rental",
      groupLabel: "租屋與配對",
      label: "配對規則",
      blurb: "正式配對引擎尚未開放，這裡只是預留位置。",
      aliases: ["配對", "match", "matching"],
    },
    {
      id: "rental/templates",
      group: "rental",
      groupLabel: "租屋與配對",
      label: "條件範本",
      blurb: "套用目錄範本會先變成草稿，確認後才發布。",
      aliases: ["範本", "template", "吉比標準版"],
    },
    {
      id: "comms/notices",
      group: "comms",
      groupLabel: "通知與溝通",
      label: "系統公告",
      blurb: "服務資訊公告。舊 hop 公告在已停用區。",
      aliases: ["公告", "系統公告", "公告專區", "維護"],
    },
    {
      id: "comms/news",
      group: "comms",
      groupLabel: "通知與溝通",
      label: "最新消息",
      blurb: "歷史 hop 最新消息欄位；新的服務資訊請用系統公告。",
      aliases: ["最新消息", "news", "hop"],
    },
    {
      id: "comms/smtp",
      group: "comms",
      groupLabel: "通知與溝通",
      label: "郵件服務",
      blurb: "系統信 SMTP 與測試寄信。",
      aliases: ["SMTP", "寄信", "系統信件", "郵件"],
    },
    {
      id: "comms/templates",
      group: "comms",
      groupLabel: "通知與溝通",
      label: "信件範本",
      blurb: "註冊、歡迎、驗證、刪除與通知主旨本文。",
      aliases: ["信件內容", "範本", "歡迎信", "刪除會員信"],
    },
    {
      id: "revenue/sponsors",
      group: "revenue",
      groupLabel: "收益與曝光",
      label: "贊助連結",
      blurb: "會員贊助收款連結。",
      aliases: ["贊助", "贊助曝光", "收款", "Ko-fi", "PayPal"],
    },
    {
      id: "revenue/support",
      group: "revenue",
      groupLabel: "收益與曝光",
      label: "支持本站",
      blurb: "支持總覽、前台呈現、方案、收款、企業贊助與維運成本。",
      aliases: ["支持本站", "支持呈現", "支持總覽", "收款設定", "感謝牆", "維運成本", "Buy Me a Coffee"],
    },
    {
      id: "revenue/campaigns",
      group: "revenue",
      groupLabel: "收益與曝光",
      label: "贊助活動",
      blurb: "第一方贊助活動與插入間隔。",
      aliases: ["贊助活動", "campaign"],
    },
    {
      id: "revenue/ads",
      group: "revenue",
      groupLabel: "收益與曝光",
      label: "站內曝光",
      blurb: "現行贊助插入；舊站內小廣告在已停用區。",
      aliases: ["站內小廣告", "廣告", "曝光"],
    },
    {
      id: "system/maps",
      group: "system",
      groupLabel: "系統與整合",
      label: "地圖與通勤",
      blurb: "OSRM、Google Directions 金鑰與捷運顯示。",
      aliases: ["Google", "地圖", "通勤", "OSRM", "Directions", "API Key", "捷運"],
    },
    {
      id: "system/oauth",
      group: "system",
      groupLabel: "系統與整合",
      label: "社群登入",
      blurb: "Google／LINE／Facebook OAuth。",
      aliases: ["OAuth", "Google 登入", "Facebook", "LINE", "社群"],
    },
    {
      id: "system/services",
      group: "system",
      groupLabel: "系統與整合",
      label: "外部服務",
      blurb: "SMTP、OAuth、地圖等整合狀態一覽。",
      aliases: ["外部服務", "整合", "金鑰"],
    },
    {
      id: "system/status",
      group: "system",
      groupLabel: "系統與整合",
      label: "系統狀態",
      blurb: "版本與唯讀狀態，不會啟動抓取或補算。",
      aliases: ["系統狀態", "版本"],
    },
    {
      id: "feedback/inbox",
      group: "feedback",
      groupLabel: "意見與治理",
      label: "使用者回饋",
      blurb: "Bug、建議與處理狀態。",
      aliases: ["回饋", "意見", "bug", "建議"],
    },
    {
      id: "feedback/audit",
      group: "feedback",
      groupLabel: "意見與治理",
      label: "管理操作紀錄",
      blurb: "誰在何時改了來源、同房源、公告或金鑰。",
      aliases: ["操作紀錄", "audit", "稽核", "誰改的"],
    },
  ];

  const LEGACY = {
    members: "members/users",
    "content/wish": "rental/wish",
    crawl: "inventory/crawl",
    site: "content/brand",
    qa: "content/qa",
    notices: "comms/notices",
    promo: "revenue/sponsors",
    ads: "revenue/ads",
    mail: "comms/smtp",
    feedback: "feedback/inbox",
  };

  const GROUPS = [
    { id: "overview", label: "總覽", pages: ["overview"] },
    { id: "inventory", label: "房源與資料", pages: ["inventory/sources", "inventory/crawl", "inventory/same-house", "inventory/imports", "inventory/health"] },
    { id: "members", label: "會員與權限", pages: ["members/users", "members/plans", "members/guest", "members/login"] },
    { id: "rental", label: "租屋與配對", pages: ["rental/catalog", "rental/listing", "rental/wish", "rental/rules", "rental/templates"] },
    { id: "content", label: "站台內容", pages: ["content/brand", "content/spirit", "content/legal", "content/cms", "content/qa", "content/housing"] },
    { id: "comms", label: "通知與溝通", pages: ["comms/notices", "comms/news", "comms/smtp", "comms/templates"] },
    { id: "revenue", label: "收益與曝光", pages: ["revenue/sponsors", "revenue/support", "revenue/campaigns", "revenue/ads"] },
    { id: "system", label: "系統與整合", pages: ["system/maps", "system/oauth", "system/services", "system/status"] },
    { id: "feedback", label: "意見與治理", pages: ["feedback/inbox", "feedback/audit"] },
  ];

  function pageById(id) {
    return PAGES.find((row) => row.id === id) || PAGES[0];
  }

  function normalizeHash(raw) {
    const key = String(raw || "").replace(/^#/, "").trim();
    if (!key) return "overview";
    if (LEGACY[key]) return LEGACY[key];
    if (PAGES.some((row) => row.id === key)) return key;
    return "overview";
  }

  function searchPages(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    return PAGES.map((row) => {
      const aliases = (row.aliases || []).map((item) => String(item).toLowerCase());
      const label = String(row.label || "").toLowerCase();
      const id = String(row.id || "").toLowerCase();
      const blurb = String(row.blurb || "").toLowerCase();
      const group = String(row.groupLabel || "").toLowerCase();
      const hay = [label, group, blurb, id, ...aliases].join(" ");
      if (!hay.includes(q)) return null;
      let score = 1;
      if (aliases.includes(q) || label === q || id === q) score = 100;
      else if (aliases.some((item) => item.startsWith(q)) || label.startsWith(q)) score = 80;
      else if (aliases.some((item) => item.includes(q)) || label.includes(q) || id.includes(q)) score = 40;
      return { row, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id)).slice(0, 8).map((item) => item.row);
  }

  function readFavorites() {
    try {
      const raw = JSON.parse(global.localStorage?.getItem(FAVORITES_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((id) => PAGES.some((row) => row.id === id)) : [];
    } catch {
      return [];
    }
  }

  function writeFavorites(ids) {
    try {
      global.localStorage?.setItem(FAVORITES_KEY, JSON.stringify(ids.slice(0, 12)));
    } catch {
      // ignore quota
    }
  }

  function toggleFavorite(id) {
    const cur = readFavorites();
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    writeFavorites(next);
    return next;
  }

  const TRANSIENT_IDS = {
    memberQuery: true,
    memberSort: true,
    sameHouseLimit: true,
    sameHouseQuery: true,
    importAdminQuery: true,
    importAdminStatus: true,
    feedbackFilterStatus: true,
    feedbackFilterKind: true,
    adminSearch: true,
  };

  const SAVE_PAGES = {
    "inventory/sources": { form: "crawlForm", label: "儲存物件來源" },
    "inventory/crawl": { form: "systemCrawlForm", label: "儲存抓取範圍" },
    "content/brand": { form: "brandForm", label: "儲存品牌設定" },
    "content/spirit": { form: "spiritForm", label: "儲存理念文字" },
    "content/legal": { form: "legalCopyForm", label: "儲存宣告文字" },
    "content/cms": { form: "cmsEditor", label: "儲存草稿" },
    "content/qa": { button: "helpQaSave", label: "儲存 Q&A" },
    "content/housing": { button: "housingSave", label: "儲存居住數據" },
    "content/wish": { button: "wishCondSave", label: "儲存條件選單" },
    "rental/wish": { button: "wishCondSave", label: "儲存條件選單" },
    "rental/catalog": { button: "catalogPublishDraft", label: "發布目錄草稿" },
    "rental/templates": { button: "catalogApplyTemplate", label: "套用範本為草稿" },
    "comms/notices": { form: "announceForm", label: "儲存公告" },
    "comms/news": { form: "newsHopForm", label: "儲存最新消息" },
    "comms/smtp": { form: "smtpForm", label: "儲存 SMTP" },
    "comms/templates": { form: "tplForm", label: "儲存信件內容" },
    "revenue/sponsors": { form: "sponsorForm", label: "儲存贊助連結" },
    "revenue/support": { form: "supportConfigForm", label: "儲存支持呈現" },
    "revenue/campaigns": { form: "campaignConfigForm", label: "儲存插入設定" },
    "system/maps": { form: "mapsForm", label: "儲存路線設定" },
    "system/oauth": { form: "oauthForm", label: "儲存社群登入" },
  };

  let dirty = false;
  let dirtyCount = 0;
  let dirtyOwner = "";
  let currentPageId = "overview";
  const baselines = {};

  function saveSpec(pageId) {
    return SAVE_PAGES[pageId || currentPageId] || null;
  }

  function isTransientControl(el) {
    if (!el) return true;
    const id = el.id || "";
    if (TRANSIENT_IDS[id]) return true;
    if (el.dataset && (el.dataset.adminTransient === "" || el.dataset.adminTransient === "true")) return true;
    if (el.type === "search" || el.type === "file" || el.type === "button" || el.type === "submit") return true;
    return false;
  }

  function changedCount(baseline, current) {
    const keys = new Set([...Object.keys(baseline || {}), ...Object.keys(current || {})]);
    let n = 0;
    for (const key of keys) {
      if (String(baseline?.[key] ?? "") !== String(current?.[key] ?? "")) n += 1;
    }
    return n;
  }

  function decideNavigation(nextId) {
    const next = normalizeHash(nextId);
    if (!dirty || !dirtyOwner || dirtyOwner === next) {
      return { allow: true, prompt: false, stayOn: currentPageId };
    }
    return { allow: false, prompt: true, stayOn: dirtyOwner };
  }

  function controlKey(el) {
    return el.name || el.id || el.dataset?.crawlId || el.dataset?.systemDistrict || el.getAttribute("data-admin-key") || "";
  }

  function snapshotPage(pageId, root) {
    const spec = saveSpec(pageId);
    if (!spec) return {};
    const host = root || (global.document && (
      (spec.form && global.document.getElementById(spec.form))
      || global.document.querySelector(`[data-admin-page="${pageId}"]`)
    ));
    if (!host || !host.querySelectorAll) return {};
    const out = {};
    host.querySelectorAll("input, select, textarea").forEach((el, index) => {
      if (isTransientControl(el)) return;
      const key = controlKey(el) || `anon-${index}`;
      out[key] = el.type === "checkbox" || el.type === "radio" ? String(el.checked) : String(el.value ?? "");
    });
    return out;
  }

  function refreshDirtyFromSnapshot() {
    if (!saveSpec(currentPageId)) {
      dirty = false;
      dirtyCount = 0;
      dirtyOwner = "";
      renderDirtyBar();
      return;
    }
    const current = snapshotPage(currentPageId);
    dirtyCount = changedCount(baselines[currentPageId] || {}, current);
    dirty = dirtyCount > 0;
    dirtyOwner = dirty ? currentPageId : "";
    renderDirtyBar();
  }

  function renderDirtyBar() {
    const bar = global.document?.getElementById("adminDirtyBar");
    const label = global.document?.getElementById("adminDirtyLabel");
    const saveBtn = global.document?.getElementById("adminDirtySave");
    const spec = saveSpec(dirtyOwner || currentPageId);
    bar?.toggleAttribute("hidden", !dirty);
    if (label) label.textContent = dirty ? `你有 ${dirtyCount} 項尚未儲存的變更` : "";
    if (saveBtn) {
      saveBtn.hidden = !spec;
      if (spec) saveBtn.textContent = spec.label || "儲存變更";
    }
  }

  function setDirty(on, count) {
    if (on) {
      if (!saveSpec(currentPageId)) return;
      dirty = true;
      dirtyOwner = currentPageId;
      dirtyCount = count == null ? Math.max(1, dirtyCount) : Math.max(1, Number(count) || 1);
    } else {
      dirty = false;
      dirtyCount = 0;
      dirtyOwner = "";
    }
    renderDirtyBar();
  }

  function confirmLeave() {
    if (!dirty) return true;
    return global.confirm("這個頁面有尚未儲存的變更。要離開並放棄嗎？");
  }

  function markClean() {
    dirty = false;
    dirtyCount = 0;
    dirtyOwner = "";
    renderDirtyBar();
  }

  function beginPage(pageId) {
    currentPageId = normalizeHash(pageId);
  }

  function captureBaseline(pageId) {
    const id = normalizeHash(pageId || currentPageId);
    baselines[id] = snapshotPage(id);
    if (dirtyOwner === id || !dirty) {
      markClean();
      currentPageId = id;
    }
  }

  function finishPageLoad(pageId) {
    const id = normalizeHash(pageId || currentPageId);
    if (id !== currentPageId) return;
    if (!dirty || dirtyOwner !== id) captureBaseline(id);
  }

  function noteControlChange(el) {
    if (isTransientControl(el)) return false;
    if (!saveSpec(currentPageId)) return false;
    refreshDirtyFromSnapshot();
    return dirty;
  }

  function runStickySave() {
    const spec = saveSpec(dirtyOwner || currentPageId);
    if (!spec) return false;
    const doc = global.document;
    if (!doc) return false;
    if (spec.form) {
      const form = doc.getElementById(spec.form);
      if (!form) return false;
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      return true;
    }
    if (spec.button) {
      const btn = doc.getElementById(spec.button);
      if (!btn) return false;
      btn.click();
      return true;
    }
    return false;
  }

  global.AdminIA = {
    PAGES,
    GROUPS,
    LEGACY,
    SAVE_PAGES,
    pageById,
    normalizeHash,
    searchPages,
    readFavorites,
    toggleFavorite,
    setDirty,
    confirmLeave,
    markClean,
    isDirty: () => dirty,
    currentPageId: () => currentPageId,
    dirtyPageId: () => dirtyOwner,
    saveSpec,
    isTransientControl,
    changedCount,
    decideNavigation,
    beginPage,
    captureBaseline,
    finishPageLoad,
    noteControlChange,
    runStickySave,
    snapshotPage,
  };
})(typeof window !== "undefined" ? window : globalThis);
