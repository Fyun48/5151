// 變異測試工具（2026-09-27）。
//
// 用途：把「修正」逐條拿掉，確認**對應那一項測試會失敗**。沒有這一步的綠燈不能信任——
// 本系列先前已抓到多次「測試是空的、拿掉修正照樣過」。
//
// 用法：node v3/scripts/mutation-check.mjs <測試檔> [--json]
//   mutation 清單寫在 MUTATIONS，每條都要指名「預期被殺掉的測試」。
//   `from` 必須在檔案中**恰好出現一次**（避免改錯地方，見 AGENT-RULES §七.2）。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const SRC = "v3/src/sameHouseAsync.js";
const USER_SRC = "v3/src/userSameHouseAsync.js";
const AUDIT_SRC = "v3/src/adminAuditAsync.js";
const AUDIT_HEALTH_SRC = "v3/src/adminAuditHealth.js";

// 稽核失敗可視性的變異集（v3/test/admin-audit-visibility.test.js）。
// 這一組要證明的是「痕跡真的會留下」——因為「沒有痕跡」正是原本壞掉的東西。
const AUDIT_MUTATIONS = [
  {
    name: "拿掉記數與寫 log（回到完全隱形的 catch）",
    file: AUDIT_SRC,
    from: "    noteAuditFailure(error);\n    throw error;",
    to: "    throw error;",
    expect: "必須記數",
  },
  {
    name: "失敗改成靜默回傳（不再往外丟，契約被改掉）",
    file: AUDIT_SRC,
    from: "    noteAuditFailure(error);\n    throw error;",
    to: "    noteAuditFailure(error);\n    return null;",
    expect: "仍然往外丟",
  },
  {
    name: "計數器不遞增（有 log 但數字永遠 0）",
    file: AUDIT_HEALTH_SRC,
    from: "  failures += 1;",
    to: "  failures += 0;",
    expect: "必須記數",
  },
  {
    name: "每次都印 log（洗版）",
    file: AUDIT_HEALTH_SRC,
    from: "  if (logCount === 1 || logCount % LOG_EVERY === 0) {",
    to: "  if (true) {",
    expect: "不得洗版",
  },
  {
    // 複合變異：單獨把條件改回耦合版是「等價變異」（計數器正常時行為相同），殺不掉。
    // 必須與「計數器壞掉」同時發生，才顯現出耦合的代價——那正是解耦要防的情況。
    name: "（複合）計數器壞掉＋日誌節奏耦合失敗計數 → 會洗版",
    file: AUDIT_HEALTH_SRC,
    from: "  if (logCount === 1 || logCount % LOG_EVERY === 0) {",
    to: "  if (failures === 1 || failures % LOG_EVERY === 0) {",
    also: [{ from: "  failures += 1;", to: "  failures += 0;" }],
    expect: "洗版",
  },
  {
    name: "成功路徑也記成失敗（把正常當故障）",
    file: AUDIT_SRC,
    from: "    return await writeAdminAuditPg(params, options);\n  } catch (error) {",
    to: "    const r = await writeAdminAuditPg(params, options);\n    noteAuditFailure(new Error(\"forced\"));\n    return r;\n  } catch (error) {",
    expect: "成功時不得計數",
  },
];

const SUPPORT_WRITE_SRC = "v3/src/supportAsync.js";

// Support 後台「寫入」的變異集（v3/test/support-async.test.js 的寫入段）。
const SUPPORT_WRITE_MUTATIONS = [
  {
    name: "tiers：完全不把其他方案的 is_default 歸零（會出現兩個預設）",
    file: SUPPORT_WRITE_SRC,
    from: "  if (bool01(src.is_default, 0)) await exec(CLEAR_TIER_DEFAULT_SQL, []);\n",
    to: "",
    expect: "先歸零再寫入",
  },
  {
    // 複合變異：把「先歸零」搬到 INSERT **之後**。單獨拿掉歸零只會測到「有沒有做」，
    // 這個才測到**順序**——順序顛倒會把剛建立的預設方案又清掉，而回傳值看起來仍然是對的。
    name: "（複合）tiers：把 is_default 歸零搬到 INSERT 之後（順序顛倒）",
    file: SUPPORT_WRITE_SRC,
    from: "  if (bool01(src.is_default, 0)) await exec(CLEAR_TIER_DEFAULT_SQL, []);\n",
    to: "",
    also: [{ from: "  return tierRow((await exec(TIER_LAST_SQL, []))[0]);", to: "  await exec(CLEAR_TIER_DEFAULT_SQL, []);\n  return tierRow((await exec(TIER_LAST_SQL, []))[0]);" }],
    expect: "先歸零再寫入",
  },
  {
    name: "costs：end_date 的 `!== undefined` 改成 `!= null`（傳 null 就清不掉了）",
    file: SUPPORT_WRITE_SRC,
    from: "    end_date: src.end_date !== undefined ? (src.end_date ? cleanText(src.end_date, 20) : null) : current.end_date || null,",
    to: "    end_date: src.end_date != null ? (src.end_date ? cleanText(src.end_date, 20) : null) : current.end_date || null,",
    expect: "end_date 傳 null",
  },
  {
    name: "costs：start_date 少了預設成今天的邏輯",
    file: SUPPORT_WRITE_SRC,
    from: "    cleanText(src.start_date, 20) || stamp.slice(0, 10),",
    to: "    cleanText(src.start_date, 20),",
    expect: "含日期預設",
  },
  {
    name: "providers：is_active 的預設值寫成 0",
    file: SUPPORT_WRITE_SRC,
    from: "    src.is_active != null ? bool01(src.is_active, 1) : current.is_active ? 1 : 0,\n    src.is_default != null ? bool01(src.is_default, 0) : current.is_default ? 1 : 0,\n    iso(now),\n    Number(id) || 0,\n  ]);\n  return adminProviderView(",
    to: "    src.is_active != null ? bool01(src.is_active, 1) : 0,\n    src.is_default != null ? bool01(src.is_default, 0) : current.is_default ? 1 : 0,\n    iso(now),\n    Number(id) || 0,\n  ]);\n  return adminProviderView(",
    expect: "只有一個預設收款方式",
  },
  {
    name: "dashboard：公開成本誤用「全部成本」（公開數字會變大）",
    file: SUPPORT_WRITE_SRC,
    from: "  const publicCost = await monthlyOperatingTotalAsync(exec, now, { publicOnly: true });",
    to: "  const publicCost = await monthlyOperatingTotalAsync(exec, now);",
    expect: "整包 dashboard",
  },
  {
    name: "dashboard：漏斗沒有帶入事件計數（cta_shown 永遠 0）",
    file: SUPPORT_WRITE_SRC,
    from: "    funnel: conversionFunnel({ ...counts, completed: totals.count }, webhookReady),",
    to: "    funnel: conversionFunnel({ completed: totals.count }, webhookReady),",
    expect: "整包 dashboard",
  },
  {
    name: "dashboard：recent 永遠空陣列",
    file: SUPPORT_WRITE_SRC,
    from: "    recent: txs.slice(0, 12),",
    to: "    recent: [],",
    expect: "整包 dashboard",
  },
  {
    name: "dashboard：eventCounts 一律回 0（漏斗全空）",
    file: SUPPORT_WRITE_SRC,
    from: "  for (const row of rows) out[row.kind] = Number(row.n) || 0;",
    to: "  for (const row of rows) out[row.kind] = 0;",
    expect: "整包 dashboard",
  },
  {
    name: "preview：看 published 而不是 draft（預覽看到已發佈的內容）",
    file: SUPPORT_WRITE_SRC,
    from: "  return publicPagePayloadAsync(exec, await readDraftAsync(exec), flags, now);",
    to: "  return publicPagePayloadAsync(exec, await readPublishedAsync(exec), flags, now);",
    expect: "用 draft",
  },
  {
    name: "preview：不強制 enabled（站台沒開就看不到預覽）",
    file: SUPPORT_WRITE_SRC,
    from: "  const flags = { ...(await readFlagsAsync(exec)), enabled: true };",
    to: "  const flags = { ...(await readFlagsAsync(exec)) };",
    expect: "用 draft",
  },
  {
    name: "public：未開啟時不提供 sponsor_links（/support.html 變成死路）",
    file: SUPPORT_WRITE_SRC,
    from: "      cta: { enabled: false },\n      sponsor_links: await publicSponsorWaysAsync(exec),",
    to: "      cta: { enabled: false },\n      sponsor_links: [],",
    expect: "未開啟時的形狀",
  },
  {
    name: "public：公開成本永遠回空陣列",
    file: SUPPORT_WRITE_SRC,
    from: "    costs: flags.public_cost_enabled && page.show_cost ? await publicMonthlyCostsAsync(exec, now) : [],",
    to: "    costs: [],",
    expect: "整包 payload",
  },
  {
    name: "public：感謝牆永遠回空陣列",
    file: SUPPORT_WRITE_SRC,
    from: "    thanks: config.wall_enabled && page.show_supporters ? await publicSupportThanksAsync(exec) : [],",
    to: "    thanks: [],",
    expect: "整包 payload",
  },
  {
    name: "public：checkout_available 永遠 false（前台顯示付款不可用）",
    file: SUPPORT_WRITE_SRC,
    from: "    checkout_available: Boolean(provider && provider.page_url && Number(provider.is_active) === 1),",
    to: "    checkout_available: false,",
    expect: "整包 payload",
  },
  {
    name: "cta：dismiss 忽略傳入的天數（固定 7 天）",
    file: SUPPORT_WRITE_SRC,
    from: "  const next = { ...current, dismissedUntil: dismissUntilFromDays(days, now) };",
    to: "  const next = { ...current, dismissedUntil: dismissUntilFromDays(7, now) };",
    expect: "落地的 prompt 狀態",
  },
  {
    name: "cta：shownCount 不累加（永遠 1）",
    file: SUPPORT_WRITE_SRC,
    from: "    shownCount: (Number(current.shownCount) || 0) + 1,\n  };\n  await writePromptStateAsync(exec, userId, next, now);",
    to: "    shownCount: (Number(current.shownCount) || 0) + 0,\n  };\n  await writePromptStateAsync(exec, userId, next, now);",
    expect: "累加",
  },
  {
    name: "cta：沒有可用規則時仍然回 show:true（前端會拿到空的 CTA）",
    file: SUPPORT_WRITE_SRC,
    from: '  if (!rule) return { show: false, reason: "cooldown_or_threshold", state };',
    to: '  if (!rule) return { show: true, ruleId: 0 };',
    expect: "沒有可用規則",
  },
  {
    name: "cta：完整流程不寫事件（前台顯示了但沒有紀錄）",
    file: SUPPORT_WRITE_SRC,
    from: '  await recordSupportEventAsync("support_cta_shown", { userId, meta: { ruleId: result.ruleId }, now, ...options });\n',
    to: "",
    expect: "完整流程",
  },
  {
    name: "checkout：不看 flags.enabled（沒開放也能結帳）",
    file: SUPPORT_WRITE_SRC,
    from: "  if (!flags.enabled) {\n    return { available: false, message: \"目前尚未開放支持。\" };\n  }",
    to: "  if (false) {\n    return { available: false, message: \"目前尚未開放支持。\" };\n  }",
    expect: "三種情形都要一致",
  },
  {
    name: "config：wall_enabled 永遠 false（後台開關讀不出來）",
    file: SUPPORT_WRITE_SRC,
    from: "    wall_enabled: Number(row?.wall_enabled) === 1,",
    to: "    wall_enabled: false,",
    expect: "有設定值時逐欄相同",
  },
  {
    name: "config：draft 與 published 讀反了",
    file: SUPPORT_WRITE_SRC,
    from: "    draft: await readDraftAsync(exec),\n    published: await readPublishedAsync(exec),",
    to: "    draft: await readPublishedAsync(exec),\n    published: await readDraftAsync(exec),",
    expect: "有設定值時逐欄相同",
  },
  {
    name: "config：save 時不把 src.copy 併進 draft",
    file: SUPPORT_WRITE_SRC,
    from: "    copy: normalizePageCopy({ ...current.draft.copy, ...(src.draft?.copy || src.copy || {}) }),",
    to: "    copy: normalizePageCopy({ ...current.draft.copy }),",
    expect: "落地的 config 列",
  },
  {
    name: "config：publish 發佈的是 published 而不是 draft（永遠發不出去）",
    file: SUPPORT_WRITE_SRC,
    from: "  await exec(PUBLISH_CONFIG_SQL, [JSON.stringify(current.draft), iso(now), iso(now)]);",
    to: "  await exec(PUBLISH_CONFIG_SQL, [JSON.stringify(current.published), iso(now), iso(now)]);",
    expect: "published_json 要等於 draft",
  },
  {
    name: "events：拿掉 kind 白名單（任何字串都寫進去）",
    file: SUPPORT_WRITE_SRC,
    from: "  if (!SUPPORT_EVENT_KINDS.includes(kind)) return { ok: false };",
    to: "",
    expect: "不合法的 kind",
  },
  {
    name: "events：meta 不做白名單過濾（會把任意欄位寫進 DB）",
    file: SUPPORT_WRITE_SRC,
    from: "  const safe = {};\n  if (meta && typeof meta === \"object\") {",
    to: "  const safe = (meta && typeof meta === \"object\") ? { ...meta } : {};\n  if (false) {",
    expect: "meta 只留白名單欄位",
  },
  {
    name: "🚨 transactions：拿掉去重查詢（同一組 provider+交易號會寫進第二筆）",
    file: SUPPORT_WRITE_SRC,
    from: "  if (providerTx && transactionDedupeKey(provider, providerTx)) {",
    to: "  if (false) {",
    expect: "去重要生效",
  },
  {
    name: "transactions：net_amount 不重算（沿用舊值）",
    file: SUPPORT_WRITE_SRC,
    from: "    fee,\n    moneyAmount(amount - fee),\n    src.anonymous != null ? bool01(src.anonymous, 1) : current.anonymous ? 1 : 0,",
    to: "    fee,\n    current.net_amount,\n    src.anonymous != null ? bool01(src.anonymous, 1) : current.anonymous ? 1 : 0,",
    expect: "net_amount 要跟著",
  },
  {
    name: "sponsors：amount 的空字串寫成 0（少了 `=== \"\"` 的判斷）",
    file: SUPPORT_WRITE_SRC,
    from: "    src.amount == null || src.amount === \"\" ? null : moneyAmount(src.amount),",
    to: "    moneyAmount(src.amount),",
    expect: "空字串要寫 null",
  },
  {
    name: "sponsors：update 的 website_url 不做 sanitize",
    file: SUPPORT_WRITE_SRC,
    from: "    src.website_url !== undefined ? sanitizeHttpUrl(src.website_url) : current.website_url,",
    to: "    src.website_url !== undefined ? src.website_url : current.website_url,",
    expect: "沒給的欄位沿用現值",
  },
  {
    name: "cta-rules：threshold 的下限 Math.max(1,…) 拿掉（可以寫進負數）",
    file: SUPPORT_WRITE_SRC,
    from: "    src.threshold != null ? Math.max(1, Number(src.threshold) || 1) : current.threshold,",
    to: "    src.threshold != null ? Number(src.threshold) || 1 : current.threshold,",
    expect: "下限",
  },
  {
    name: "providers：page_url 不做 sanitize",
    file: SUPPORT_WRITE_SRC,
    from: "  const pageUrl = src.page_url !== undefined ? sanitizeHttpUrl(src.page_url) : current.page_url;",
    to: "  const pageUrl = src.page_url !== undefined ? src.page_url : current.page_url;",
    expect: "只有一個預設收款方式",
  },
];

const HOUSING_SRC = "v3/src/siteContentAsync.js";
const HOUSING_FETCH_SRC = "v3/src/housingFetch.js";

// 居住數據的變異集（v3/test/housing-refresh-async.test.js）。
const HOUSING_MUTATIONS = [
  {
    name: "🚨 refreshHousingData 不 await getData（async 回呼會被當成 Promise ⇒ 資料換成預設）",
    file: HOUSING_FETCH_SRC,
    from: "  let data = normalizeHousingData(getData ? await getData() : {});",
    to: "  let data = normalizeHousingData(getData ? getData() : {});",
    expect: "await 回呼",
  },
  {
    name: "🚨 refreshHousingData 不 await writeData（寫入還沒完成就回報成功）",
    file: HOUSING_FETCH_SRC,
    from: "  if (writeData) await writeData(data);",
    to: "  if (writeData) writeData(data);",
    expect: "await 回呼",
  },
  {
    name: "raw 版本誤用 public 形狀（語意不同，排程更新會拿到錯的資料）",
    file: HOUSING_SRC,
    from: "  return normalizeHousingData(stored ?? defaultHousingData());",
    to: "  return publicHousingData(stored ?? defaultHousingData());",
    expect: "getHousingDataRawAsync",
  },
  {
    name: "writeHousingData 不做 normalize（落地值與同步版不同）",
    file: HOUSING_SRC,
    from: "  await setSiteSettingAsync(HOUSING_KEY, normalizeHousingData(data), options);",
    to: "  await setSiteSettingAsync(HOUSING_KEY, data, options);",
    expect: "落地的 settings 位元組",
  },
  // 刻意**沒有**「非 postgres 不回退」這一條：實測是**等價變異**（第三個同類案例）。
  // 拿掉外層 guard 之後，委派的 `getSiteSettingAsync()` 自己會判斷 driver 並回退，
  // `driver:"sqlite"` 時仍然讀磁碟。回退**行為**有測試（第 5 項，兩邊種不同的值），
  // 只是殺不掉這個冗餘的 guard。
];

const SELFLIST_SRC = "v3/src/selfListingsAsync.js";

// 站內刊登讀取的變異集（v3/test/self-listings-async.test.js）。
const SELFLIST_MUTATIONS = [
  {
    name: "過期清理用 IFNULL（PostgreSQL 直接拋錯，且被 catch 吞掉 ⇒ 永遠清不掉）",
    file: SELFLIST_SRC,
    from: "     AND COALESCE(self_expires_at, '') != ''",
    to: "     AND IFNULL(self_expires_at, '') != ''",
    expect: "過期的要變 expired",
  },
  {
    name: "拿掉 self_expires_at 的非空判斷（空字串到期日會被當成已過期）",
    file: SELFLIST_SRC,
    from: "     AND COALESCE(self_expires_at, '') != ''",
    to: "     AND 1=1",
    expect: "空字串",
  },
  {
    name: "拿掉到期日比較（未到期的也會被標成 expired）",
    file: SELFLIST_SRC,
    from: "     AND self_expires_at <= ?",
    to: "     AND 1=1",
    expect: "未到期的不得動",
  },
  {
    name: "拿掉「已關閉且非本人」的 404（別人的已關閉刊登會外洩）",
    file: SELFLIST_SRC,
    from: '  if (status !== "open" && !mine) throw httpError("這則刊登已關閉或隱藏", 404);\n',
    to: "",
    expect: "已關閉且非本人",
  },
  {
    name: "找不到時不回 404 而是回 null",
    file: SELFLIST_SRC,
    // ⚠️ 同一行在 `selfListingsAsync.js` 出現**四次**（四個入口各有一次）⇒ 錨點要含前兩行才唯一。
    // 這一條還原的是舊缺陷：找不到時回 null（呼叫端會把 null 當成「沒有這則」而靜默走錯分支）。
    from: '  await expireOpenSelfListingsAsync(exec, now);\n  const row = await getSelfRowAsync(postId, { ...options, exec });\n  if (!row) throw httpError("找不到這則站內刊登", 404);',
    to: '  await expireOpenSelfListingsAsync(exec, now);\n  const row = await getSelfRowAsync(postId, { ...options, exec });\n  if (!row) return null;',
    expect: "找不到",
  },
  // 刻意**沒有**「非 postgres 不回退」這一條：實測它是**等價變異**。
  // 把外層 guard 拿掉之後，內層的 `getSelfRowAsync()` **自己也有** `isPg()` 判斷並回退，
  // 所以 sqlite 模式照樣讀磁碟、行為不變（與 adminSettingsAsync 那批同一類）。
  // 回退**行為**有測試（第 7 項，兩邊刻意種不同的值），只是殺不掉這個冗餘的 guard。
];

const SUPPORT_SRC = "v3/src/supportAsync.js";

// Support 後台列表的變異集（v3/test/support-async.test.js）。
const SUPPORT_MUTATIONS = [
  {
    name: "transactions 的 from 條件寫成 <=（篩選悄悄失效）",
    file: SUPPORT_SRC,
    from: '    sql += " AND received_at>=?";',
    to: '    sql += " AND received_at<=?";',
    expect: "from／to 篩選",
  },
  {
    name: "tiers 不做 activeOnly 過濾（停用的也回傳）",
    file: SUPPORT_SRC,
    from: '  return sortSupportTiers(activeOnly ? rows.filter((row) => row.is_active) : rows);',
    to: '  return sortSupportTiers(rows);',
    expect: "activeOnly",
  },
  {
    name: "sponsors 忘了把 now 傳進 sponsorRow（會用系統時鐘）",
    file: SUPPORT_SRC,
    from: '  return (await exec(SPONSORS_SQL, [])).map((row) => sponsorRow(row, now));',
    to: '  return (await exec(SPONSORS_SQL, [])).map((row) => sponsorRow(row));',
    expect: "now",
  },
  {
    name: "costs 不套列對應（回傳原始資料列）",
    file: SUPPORT_SRC,
    from: '  return (await exec(COSTS_SQL, [])).map(costRow);',
    to: '  return await exec(COSTS_SQL, []);',
    expect: "listSupportCostsAsync",
  },
  {
    name: "非 postgres 不回退（sqlite 站會去讀傳入的 exec）",
    file: SUPPORT_SRC,
    from: '  if (!isPg(options)) return listCtaRulesSync(sqliteHandle());',
    to: '  if (false) return listCtaRulesSync(sqliteHandle());',
    expect: "非 postgres",
  },
];

const ADMSET_SRC = "v3/src/adminSettingsAsync.js";

// 關閉站內刊登 PG 分支的變異集（v3/test/close-self-listing-async.test.js）。
const CLOSE_SELF_SRC = "v3/src/selfListingsAsync.js";
const CLOSESELF_MUTATIONS = [
  {
    // ⚠️ 這一條的殺手在 `close-self-listing-async.test.js`（不是 report 那一支的測試檔）：
    // 「本機也要追上」那一行是 2026-09-28 補的（`listings` 的狀態是本機同步瀏覽路徑在讀）。
    name: "關閉站內刊登只寫 PG（本機清單還看得到已關閉的）",
    file: "v3/src/selfListingsAsync.js",
    from: "  sqliteHandle().prepare(CLOSE_SELF_LISTING_SQL).run(stamp, row.post_id);\n",
    to: "",
    // 殺手是第二條測試（「PG 分支自己就要把本機那一列關掉」）：第一條測試裡本機的 closed
    // 是**同步版**寫的，所以那一條對這個變異沒有鑑別力。
    expect: "PG 分支自己就要把本機那一列關掉",
  },
  {
    name: "不驗擁有權（別人的刊登也能關）",
    file: CLOSE_SELF_SRC,
    from: '  if (!admin && Number(row.listed_by_user_id) !== Number(userId)) {\n    throw httpError("只能關閉自己的刊登", 403);\n  }\n',
    to: "",
    expect: "別人的刊登",
  },
  {
    name: "找不到時不擋（會去 UPDATE 不存在的列）",
    file: CLOSE_SELF_SRC,
    // ⚠️ 錨點要含下一行：`if (!row) throw httpError("找不到這則站內刊登", 404);` 在
    // `selfListingsAsync.js` 裡出現**兩次**（`getSelfListingAsync` 也有），
    // 工具的前置檢查會擋下來（正確行為：寧可中止也不要改錯地方）。
    from: '  if (!row) throw httpError("找不到這則站內刊登", 404);\n  if (!admin && Number(row.listed_by_user_id) !== Number(userId)) {',
    to: "  if (!admin && Number(row.listed_by_user_id) !== Number(userId)) {",
    expect: "找不到刊登",
  },
  {
    name: "狀態寫錯（closed 寫成 hidden）",
    file: CLOSE_SELF_SRC,
    from: '  "UPDATE listings SET self_status = \'closed\', last_event = \'offline\', last_seen_at = ? WHERE post_id = ?";',
    to: '  "UPDATE listings SET self_status = \'hidden\', last_event = \'offline\', last_seen_at = ? WHERE post_id = ?";',
    expect: "關閉自己的刊登",
  },
];

// 許願房範例 PG 分支的變異集（v3/test/wish-example-async.test.js）。
const WEX_SRC = "v3/src/wishExampleAsync.js";
const WISHEXAMPLE_MUTATIONS = [
  {
    name: "payload 壞掉時直接丟錯（端點會 500）",
    file: WEX_SRC,
    from: '  try {\n    return { ...JSON.parse(row.payload || "{}"), updated_at: row.updated_at };\n  } catch {\n    return { updated_at: row.updated_at };\n  }',
    to: '  return { ...JSON.parse(row.payload || "{}"), updated_at: row.updated_at };',
    expect: "payload 壞掉",
  },
  {
    name: "刪除不帶 user_id（會刪到別人的範例）",
    file: WEX_SRC,
    from: 'export const WISH_EXAMPLE_DELETE_SQL = "DELETE FROM wish_room_example WHERE user_id = ?";',
    to: 'export const WISH_EXAMPLE_DELETE_SQL = "DELETE FROM wish_room_example WHERE ? IS NOT NULL";',
    expect: "只刪自己那一列",
  },
  {
    name: "讀取不查 PG（永遠回 null）",
    file: WEX_SRC,
    from: "    const rows = rowsOf(await exec(WISH_EXAMPLE_SELECT_SQL, [uid]));\n    return exampleFromRow(rows[0] || null);",
    to: "    return null;",
    expect: "有範例",
  },
  {
    name: "未登入也放行（應該 401）",
    file: WEX_SRC,
    from: '  if (!uid) throw httpError("請先登入", 401);\n',
    to: "",
    expect: "未登入丟 401",
  },
];

// 許願房生命週期寫入（更新／刊登／重開）＋範例寫入的變異集
// （v3/test/wish-room-lifecycle-async.test.js）。
const WISHLIFECYCLE_SRC = "v3/src/demandAsync.js";
const WISHLIFECYCLE_SYNC_SRC = "v3/src/demand.js";
const WISHLIFECYCLE_MUTATIONS = [
  {
    name: "更新不檢查所有權（可以改別人的許願房）",
    file: WISHLIFECYCLE_SRC,
    from: '    if (Number(row.user_id) !== uid) throw httpError("只能修改自己的許願房", 403);\n',
    to: "",
    expect: "所有權／不存在的錯誤形狀",
  },
  {
    name: "更新不擋已隱藏的許願房",
    file: WISHLIFECYCLE_SRC,
    from: '    if (row.status === "hidden") throw httpError("已隱藏的許願房不能再改", 400);\n',
    to: "",
    expect: "所有權／不存在的錯誤形狀",
  },
  {
    name: "更新 open 的許願房時不驗刊登條件（可以改成空殼）",
    file: WISHLIFECYCLE_SRC,
    from: '    if (row.status === "open") assertPublishable(fields);\n',
    to: "",
    expect: "所有權／不存在的錯誤形狀",
  },
  {
    name: "更新只寫 PG，不讓本機 handle 追上（還沒搬完的讀取會看到舊資料）",
    file: WISHLIFECYCLE_SRC,
    from: "    writeRow(sqliteHandle(), row.id, fields, extra);\n",
    to: "",
    expect: "正規化的欄位與落地狀態",
  },
  {
    name: "刊登的容量檢查不排除自己（永遠撞上限）",
    file: WISHLIFECYCLE_SRC,
    from: "    if (await countMutableAsync(run, uid, row.id) >= DEMAND_MAX_OPEN) throwActiveLimit();\n    try {\n      await applyPublishInPlaceAsync(run, row, fields, now);",
    to: "    if (await countMutableAsync(run, uid, 0) >= DEMAND_MAX_OPEN) throwActiveLimit();\n    try {\n      await applyPublishInPlaceAsync(run, row, fields, now);",
    expect: "刊登：draft → open",
  },
  {
    name: "刊登不蓋 lifecycle（PG 上的那一列不會變 active）",
    file: WISHLIFECYCLE_SYNC_SRC,
    from: "  await run(PUBLISH_OPEN_SQL, [expires, row.id]);\n  await run(LIFECYCLE_UPDATE_SQL, lifecyclePatchParams(row.id, publishLifecyclePatch(row, stamp)));",
    to: "  await run(PUBLISH_OPEN_SQL, [expires, row.id]);",
    expect: "刊登：draft → open",
  },
  {
    name: "刊登的 23505 不轉成 wish_active_limit（競態時丟出 PG 的原始錯誤）",
    file: WISHLIFECYCLE_SRC,
    from: "function rethrowActiveLimit(error) {\n  if (isUniqueUserConstraintError(error)) throwActiveLimit();\n  throw error;\n}",
    to: "function rethrowActiveLimit(error) {\n  throw error;\n}",
    expect: "PG 的競態",
  },
  {
    name: "所有 PG 錯誤都當成 wish_active_limit（把連線中斷也吞掉）",
    file: WISHLIFECYCLE_SRC,
    from: "function rethrowActiveLimit(error) {\n  if (isUniqueUserConstraintError(error)) throwActiveLimit();\n  throw error;\n}",
    to: "function rethrowActiveLimit(error) {\n  throwActiveLimit();\n}",
    expect: "PG 的競態",
  },
  {
    name: "重開不擋已封存的舊草稿",
    file: WISHLIFECYCLE_SRC,
    from: "    assertNotCollapsed(row);\n",
    to: "",
    expect: "重開：closed → open",
  },
  {
    name: "重開不擋 lifecycle=blocked",
    file: WISHLIFECYCLE_SRC,
    from: '    if (mapLegacyLifecycle(row) === "blocked") throw httpError("已封鎖的許願房不能重開", 400, "wish_blocked");\n',
    to: "",
    expect: "重開：closed → open",
  },
  {
    name: "不先用 PG 的 settings 灌行程內快取（拿空目錄正規化）",
    file: WISHLIFECYCLE_SRC,
    from: "    await getWishConditionsAsync(options);\n    const id = Number(postId) || 0;\n    const row = one((await run(POST_OWNER_ROW_SQL, [id])).rows);\n    if (!row) throw httpError(\"找不到這則許願房\", 404);\n    if (Number(row.user_id) !== uid) throw httpError(\"只能修改自己的許願房\", 403);",
    to: "    const id = Number(postId) || 0;\n    const row = one((await run(POST_OWNER_ROW_SQL, [id])).rows);\n    if (!row) throw httpError(\"找不到這則許願房\", 404);\n    if (Number(row.user_id) !== uid) throw httpError(\"只能修改自己的許願房\", 403);",
    expect: "行程內快取必須先用 PG",
  },
  {
    name: "範例用 SQLite 的 ON CONFLICT 寫 PG（PG 沒有那個約束）",
    file: WEX_SRC,
    from: "    const existing = rowsOf(await exec(WISH_EXAMPLE_SELECT_SQL, [uid]));\n    if (existing[0]) await exec(WISH_EXAMPLE_UPDATE_SQL, [payload, stamp, uid]);\n    else await exec(WISH_EXAMPLE_INSERT_SQL, [uid, payload, stamp, stamp]);",
    to: "    await exec(WISH_EXAMPLE_UPSERT_SQL, [uid, payload, stamp, stamp]);",
    expect: "第一次寫入是 INSERT",
  },
  {
    name: "範例只寫 PG，不讓本機 handle 追上",
    file: WEX_SRC,
    from: "    if (local.prepare(WISH_EXAMPLE_LOCAL_USER_SQL).get(uid)) {",
    to: "    if (false) {",
    expect: "兩個 store 的 payload",
  },
  {
    name: "注入式 exec 的形狀只認一種（另一種會靜默回 null）",
    file: WEX_SRC,
    from: "const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));",
    to: "const rowsOf = (raw) => raw;",
    expect: "兩種形狀",
  },
  {
    name: "本機沒有這個帳號也硬寫本機那一份（PG 寫成功卻回 500：本機 FK）",
    file: WEX_SRC,
    from: "    const local = sqliteHandle();\n    if (local.prepare(WISH_EXAMPLE_LOCAL_USER_SQL).get(uid)) {\n      local.prepare(WISH_EXAMPLE_UPSERT_SQL).run(uid, payload, stamp, stamp);\n    }",
    to: "    sqliteHandle().prepare(WISH_EXAMPLE_UPSERT_SQL).run(uid, payload, stamp, stamp);",
    expect: "本機沒有這個帳號時仍要成功",
  },
  {
    name: "範例的聯絡人快照不查 PG（用自己的聯絡人會變空白）",
    file: WEX_SRC,
    from: "    const rows = rowsOf(await exec(WISH_CONTACT_PROFILE_SQL, [profileId]));\n    row = rows[0] || null;",
    to: "    row = null;",
    expect: "未登入與別人的聯絡人",
  },
];

// 完成問卷（survey）PG 分支的變異集（v3/test/rental-survey-async.test.js）。
const SURVEY_SRC = "v3/src/rentalSurveyAsync.js";
const SURVEY_SYNC_SRC = "v3/src/rentalSurvey.js";
const SURVEY_MUTATIONS = [
  {
    name: "不補『一則許願房一則問卷』的 unique index（PG 上去重整個失效）",
    file: SURVEY_SRC,
    from: '  "CREATE UNIQUE INDEX IF NOT EXISTS rental_survey_wish_unique ON rental_completion_surveys(wish_id)",\n',
    to: "",
    expect: "索引清單",
  },
  {
    name: "不補 public_token 的 unique index",
    file: SURVEY_SRC,
    from: '  "CREATE UNIQUE INDEX IF NOT EXISTS rental_survey_token_unique ON rental_completion_surveys(public_token)",\n',
    to: "",
    expect: "索引清單",
  },
  {
    name: "讀取不查 PG（永遠回 submitted:false）",
    file: SURVEY_SRC,
    from: '    const row = one((await run(SURVEY_BY_WISH_SQL, [Number(wish.id) || 0, uid])).rows);\n    return publicSurvey(row);',
    to: "    return publicSurvey(null);",
    expect: "讀取：沒有問卷回",
  },
  {
    name: "不檢查許願房是不是自己的（可以替別人填問卷）",
    file: SURVEY_SRC,
    from: "    if (!raw || Number(raw.user_id) !== uid) {\n      throw rentalNotifyHttpError(\"找不到這則許願房\", 404, \"wish_not_found\");\n    }\n",
    to: "    if (!raw) {\n      throw rentalNotifyHttpError(\"找不到這則許願房\", 404, \"wish_not_found\");\n    }\n",
    expect: "生命週期不是 completed",
  },
  {
    name: "不檢查生命週期是不是 completed（沒找到房也能填）",
    file: SURVEY_SRC,
    from: '    if (String(raw.lifecycle || "") !== "completed") {\n      throw rentalNotifyHttpError("完成找房後才能填回饋", 409, "survey_not_due");\n    }\n',
    to: "",
    expect: "生命週期不是 completed",
  },
  {
    name: "不安全標記不擋（detail 直接落地）",
    file: SURVEY_SYNC_SRC,
    from: '  if (containsUnsafeMarkup(detail)) throw rentalNotifyHttpError("內容包含不安全標記", 400, "unsafe_markup");\n',
    to: "",
    expect: "不安全標記",
  },
  {
    name: "只寫 PG，不讓本機 handle 追上（admin 的 drill-down 看不到）",
    file: SURVEY_SRC,
    from: "    const local = sqliteHandle();\n    if (!local.prepare(SURVEY_BY_WISH_SQL).get(Number(raw.id), uid)) {\n      local.prepare(SURVEY_INSERT_SQL).run(token, Number(raw.id), uid, found, via, helpful, detail, stamp);\n    }\n",
    to: "",
    expect: "送出：寫入 PG 與本機 handle",
  },
  {
    name: "本機的計數不記（admin 的營運數字少一筆）",
    file: SURVEY_SRC,
    from: '    bumpAnalytics(sqliteHandle(), surveyMetric(found), now);\n',
    to: "",
    expect: "送出：寫入 PG 與本機 handle",
  },
  {
    name: "PG 與本機的計數鍵用錯（跳過也記成 submitted）",
    file: SURVEY_SYNC_SRC,
    from: 'export function surveyMetric(found) {\n  return found === "skipped" ? "survey_skipped" : "survey_submitted";\n}',
    to: 'export function surveyMetric() {\n  return "survey_submitted";\n}',
    expect: "送出：跳過要記成",
  },
  {
    name: "彙總的 COUNT 不正規化（PG 會回字串 \"3\"）",
    file: SURVEY_SRC,
    from: "    return rows.map((row) => ({ ...row, n: Number(row.n) || 0 }));",
    to: "    return rows;",
    expect: "彙總：逐列相同",
  },
  {
    name: "23505 以外的寫入錯誤也當成 already（把連線中斷吞掉）",
    file: SURVEY_SRC,
    from: 'function isUniqueViolation(error) {\n  if (String(error?.code || "") === "23505") return true;\n  return /UNIQUE constraint failed/i.test(String(error?.message || ""));\n}',
    to: "function isUniqueViolation() {\n  return true;\n}",
    expect: "送出：競態",
  },
  {
    name: "非 postgres 模式也走 PG 分支（SQLite 站會壞）",
    file: SURVEY_SRC,
    from: "  if (!isPg(options)) return runSqlite();\n",
    to: "",
    expect: "非 postgres 模式必須走同步路徑",
  },
];

// Admin 營運分析（rental ops）PG 分支的變異集（v3/test/rental-ops-async.test.js）。
const OPS_SRC = "v3/src/rentalOpsAnalyticsAsync.js";
const OPS_SYNC_SRC = "v3/src/rentalOpsAnalytics.js";
const OPS_MUTATIONS = [
  {
    name: "中位數用 SQLite 的 julianday 送 PG（真 PG 會說函式不存在）",
    file: OPS_SYNC_SRC,
    from: "  medianOrderPg: `SELECT (EXTRACT(EPOCH FROM (accepted_at::timestamptz - created_at::timestamptz))) AS secs",
    to: "  medianOrderPg: `SELECT (julianday(accepted_at) - julianday(created_at)) * 86400 AS secs",
    expect: "彙總：整包逐鍵相同",
  },
  {
    name: "中位數的奇數分支寫成偶數（取中間兩個的平均）",
    file: OPS_SRC,
    from: "    if (n % 2 === 1) {\n      const row = one((await run(sql, [start, end, 1, Math.floor((n - 1) / 2)])).rows);\n      return { median: Math.round(Number(row?.secs) || 0), n };\n    }",
    to: "    if (false) {\n      const row = one((await run(sql, [start, end, 1, Math.floor((n - 1) / 2)])).rows);\n      return { median: Math.round(Number(row?.secs) || 0), n };\n    }",
    expect: "母體中位數是奇數",
  },
  {
    name: "中位數的母體取樣偏移少 1（OFFSET 從 0 開始）",
    file: OPS_SRC,
    from: "      const row = one((await run(sql, [start, end, 1, Math.floor((n - 1) / 2)])).rows);",
    to: "      const row = one((await run(sql, [start, end, 1, 0])).rows);",
    expect: "母體中位數是奇數",
  },
  {
    name: "期間篩選忽略迄日（把整個月之後的也算進來）",
    file: OPS_SYNC_SRC,
    from: 'export const DAY_END = (day) => `${day}T23:59:59.999Z`;',
    to: 'export const DAY_END = (day) => `${day.slice(0, 4)}-12-31T23:59:59.999Z`;',
    expect: "彙總：整包逐鍵相同",
  },
  {
    name: "報價狀態的存量查不到（pending 永遠 0）",
    file: OPS_SRC,
    from: '      pending: await countWhere(run, OFFER_STATUS_COUNT_SQL, ["pending"]),',
    to: "      pending: 0,",
    expect: "彙總：整包逐鍵相同",
  },
  {
    name: "growth 的鍵接錯（confirm_after_reminder 接到 share_cta）",
    file: OPS_SRC,
    from: '      confirm_after_reminder: await sumMetric(run, "wish_confirmed", range.from, range.to),',
    to: '      confirm_after_reminder: await sumMetric(run, "share_cta", range.from, range.to),',
    expect: "彙總：整包逐鍵相同",
  },
  {
    name: "通知計數的鍵接錯（digest 接到 notify_delivered）",
    file: OPS_SRC,
    from: '      digest: await sumMetric(run, "digest_count", range.from, range.to),',
    to: '      digest: await sumMetric(run, "notify_delivered", range.from, range.to),',
    expect: "彙總：整包逐鍵相同",
  },
  {
    name: "接受率的分母用 accepted（自己除自己，永遠 1）",
    file: OPS_SRC,
    from: "      acceptance_rate: offerCreated ? Number((offerAccepted / offerCreated).toFixed(4)) : 0,",
    to: "      acceptance_rate: offerAccepted ? Number((offerAccepted / offerAccepted).toFixed(4)) : 0,",
    expect: "彙總：整包逐鍵相同",
  },
  {
    name: "查詢失敗不轉錯誤碼（admin 分不出哪一類查詢壞掉）",
    file: OPS_SRC,
    from: '    throw analyticsQueryError(error, "analytics_metric_failed");',
    to: "    throw error;",
    expect: "錯誤碼",
  },
  {
    name: "明細的分頁游標不看『還有下一頁』（永遠給空字串）",
    file: OPS_SRC,
    from: '        next_cursor: rows.length > size ? offset + size : "",\n      };\n    }',
    to: '        next_cursor: "",\n      };\n    }',
    expect: "明細：offers 與 surveys",
  },
  {
    name: "非 postgres 模式也走 PG 分支（SQLite 站會壞）",
    file: OPS_SRC,
    from: "  if (!isPg(options)) return runSqlite();\n",
    to: "",
    expect: "非 postgres 模式必須走同步路徑",
  },
];

// 租屋通知偏好／訂閱／取消訂閱 PG 分支的變異集
// （v3/test/rental-notify-prefs-async.test.js）。
const NPREFSWRITE_SRC = "v3/src/rentalNotifyPrefsAsync.js";
const NPREFSWRITE_SYNC_SRC = "v3/src/rentalNotify.js";
const NPREFSWRITE_MUTATIONS = [
  {
    name: "PG 不補訂閱的唯一索引（同一刊登會出現多列）",
    file: NPREFSWRITE_SRC,
    from: '  "CREATE UNIQUE INDEX IF NOT EXISTS rental_match_subscriptions_owner_listing_key ON rental_match_subscriptions(owner_user_id, listing_id)",\n',
    to: "",
    expect: "常數：PG 缺這三句",
  },
  {
    name: "PG 不補 DROP IDENTITY（user_id 是使用者帶來的，健檢會永遠紅）",
    file: NPREFSWRITE_SRC,
    from: 'export const PREFS_DROP_IDENTITY_SQL =\n  "ALTER TABLE rental_notify_prefs ALTER COLUMN user_id DROP IDENTITY IF EXISTS";',
    to: 'export const PREFS_DROP_IDENTITY_SQL = "SELECT 1";',
    expect: "常數：PG 缺這三句",
  },
  {
    name: "讀取不先灌行程內快取（caps 會拿到本機的舊旗標）",
    file: NPREFSWRITE_SRC,
    from: "export async function getRentalNotifyPrefsForAsync(userId, options = {}) {\n  await getWishConditionsAsync(options);\n",
    to: "export async function getRentalNotifyPrefsForAsync(userId, options = {}) {\n",
    expect: "prefs 讀取",
  },
  {
    name: "寫入不先灌行程內快取（站上關閉通知時仍寫得進去）",
    file: NPREFSWRITE_SRC,
    from: "export async function saveRentalNotifyPrefsForAsync(userId, patch = {}, options = {}) {\n  await getWishConditionsAsync(options);\n",
    to: "export async function saveRentalNotifyPrefsForAsync(userId, patch = {}, options = {}) {\n",
    expect: "PG 說通知關閉",
  },
  {
    name: "prefs 只寫 PG，不讓本機 handle 追上（同步的投遞規劃看到舊值）",
    file: NPREFSWRITE_SRC,
    from: "  sqliteHandle().prepare(PREFS_UPSERT_SQL).run(...params);\n",
    to: "",
    expect: "prefs 寫入：兩個 store",
  },
  {
    name: "本機的計數不記（admin 的營運數字少一筆）",
    file: NPREFSWRITE_SRC,
    from: '  bumpAnalytics(sqliteHandle(), "pref_updated", now);\n',
    to: "",
    expect: "prefs 寫入：兩個 store",
  },
  {
    name: "訂閱不檢查所有權（可以訂閱別人的刊登）",
    file: NPREFSWRITE_SRC,
    from: "    if (!(await listingOwnedAsync(run, uid, lid))) {\n      throw rentalNotifyHttpError(\"找不到這則刊登\", 404, \"listing_not_found\");\n    }\n",
    to: "",
    expect: "訂閱：不是自己的刊登",
  },
  {
    name: "訂閱的 mode 不驗證（任意字串直接寫進去）",
    file: NPREFSWRITE_SRC,
    from: "    const next = RENTAL_MATCH_MODES.includes(mode) ? mode : \"off\";",
    to: "    const next = mode;",
    expect: "訂閱：不是自己的刊登",
  },
  {
    name: "取消連結可以重複使用（不看 used_at）",
    file: NPREFSWRITE_SRC,
    from: "    if (row.used_at) return { ok: true, already: true };\n",
    to: "",
    expect: "取消訂閱：四種 scope",
  },
  {
    name: "取消連結不檢查過期",
    file: NPREFSWRITE_SRC,
    from: "    if (Date.parse(row.expires_at) <= now.getTime()) {\n      throw rentalNotifyHttpError(\"取消連結已過期\", 400, \"unsub_expired\");\n    }\n",
    to: "",
    expect: "取消訂閱：過期",
  },
  {
    name: "取消訂閱不暫時打開閘門（站上關閉通知時取消連結會 404）",
    file: NPREFSWRITE_SRC,
    from: "    await withNotificationsForcedEnabledAsync(async () => {",
    to: "    await (async () => {",
    expect: "取消訂閱：過期",
  },
  {
    name: "取消訂閱忘記標記 token 已用（連結可以一直用）",
    file: NPREFSWRITE_SRC,
    from: "    await run(UNSUB_MARK_USED_SQL, [stamp, raw]);\n",
    to: "",
    expect: "取消訂閱：四種 scope",
  },
  {
    name: "非 postgres 模式也走 PG 分支（SQLite 站會壞）",
    file: NPREFSWRITE_SRC,
    from: "  if (!isPg(options)) return runSqlite();\n",
    to: "",
    expect: "非 postgres 模式必須走同步路徑",
  },
  {
    name: "同步版的取消連結忘記標記 token 已用",
    file: NPREFSWRITE_SYNC_SRC,
    from: "  db.prepare(UNSUB_MARK_USED_SQL).run(iso(now), raw);\n",
    to: "",
    expect: "取消訂閱：四種 scope",
  },
];

// 站台設定讀取（系統爬蟲＋目錄快照）與後台搜尋的變異集
// （v3/test/system-crawl-async.test.js）。
const SYSCRAWL_SRC = "v3/src/siteContentAsync.js";
const SYSCRAWL_DB_SRC = "v3/src/db.js";
const SYSCRAWL_ADMIN_SRC = "v3/src/adminOverviewAsync.js";
const SYSCRAWL_ADMIN_SYNC_SRC = "v3/src/adminOverview.js";
const SYSCRAWL_SHARE_SRC = "v3/src/rentalShareGrowthAsync.js";
const SYSCRAWL_MUTATIONS = [
  {
    name: "系統爬蟲設定整包覆蓋（後台只切一個開關就把其他設定洗掉）",
    file: SYSCRAWL_DB_SRC,
    from: "    systemCrawlIntervalMinutes: has(\"intervalMinutes\")\n      ? clampIntervalMinutes(src.intervalMinutes, { admin: true, fallback: current.intervalMinutes })\n      : current.intervalMinutes,",
    to: "    systemCrawlIntervalMinutes: 30,",
    expect: "partial patch 只覆蓋有給的鍵",
  },
  {
    name: "明確給 false 被當成沒給（showMrt 關不掉）",
    file: SYSCRAWL_DB_SRC,
    from: "    systemShowMrt: has(\"showMrt\") ? src.showMrt !== false : current.showMrt !== false,",
    to: "    systemShowMrt: current.showMrt !== false,",
    expect: "partial patch 只覆蓋有給的鍵",
  },
  {
    name: "PG 只寫不讓本機追上（爬蟲繼續用舊設定跑）",
    file: SYSCRAWL_SRC,
    from: "  const local = sqliteHandle();\n  for (const [key, value] of Object.entries(nextValues)) {\n    local.prepare(SETTINGS_UPSERT_SQL).run(key, JSON.stringify(value));\n  }\n",
    to: "",
    expect: "partial patch 只覆蓋有給的鍵",
  },
  {
    name: "目錄快照不寫回 settings（readSiteCatalogStats 永遠是舊的）",
    file: SYSCRAWL_SRC,
    from: "  await setSiteSettingAsync(SITE_CATALOG_STATS_KEY, snapshot, options);\n",
    to: "",
    expect: "partial patch 只覆蓋有給的鍵",
  },
  {
    name: "目錄快照不過濾監看區（全部刊登都算進來）",
    file: SYSCRAWL_DB_SRC,
    from: "    if (!listingMatchesDistrictKeys(row, keySet, nameSet)) continue;\n",
    to: "",
    expect: "目錄快照：只算監看區",
  },
  {
    name: "分享頁 extras 讀本機旗標而不是 PG（PG 站會顯示錯的開關）",
    file: SYSCRAWL_SHARE_SRC,
    from: "  await getWishConditionsAsync(options);\n  return sharePageExtras(currentRentalMarketplaceFlags());",
    to: "  return sharePageExtras(currentRentalMarketplaceFlags());",
    expect: "分享頁 extras",
  },
  {
    name: "後台搜尋用 IFNULL 送 PG（PG 沒有這個函式）",
    file: SYSCRAWL_ADMIN_SYNC_SRC,
    from: "     WHERE title LIKE ? OR COALESCE(address, '') LIKE ?",
    to: "     WHERE title LIKE ? OR IFNULL(address, '') LIKE ?",
    expect: "後台刊登搜尋",
  },
  {
    name: "後台搜尋不看上限（limit 1000 就真的查 1000 筆）",
    file: SYSCRAWL_ADMIN_SYNC_SRC,
    from: "  const cap = Math.max(1, Math.min(40, Number(limit) || 20));",
    to: "  const cap = Math.max(1, Number(limit) || 20);",
    expect: "後台刊登搜尋",
  },
  {
    name: "非 postgres 模式也走 PG 分支（SQLite 站會壞）",
    file: SYSCRAWL_ADMIN_SRC,
    from: '  if ((options.driver || resolveDbDriver()) !== "postgres") return searchAdminListingsSync(q, limit);\n',
    to: "",
    expect: "非 postgres 模式必須走同步路徑",
  },
];

// 匯入清單（listing imports）PG 分支的變異集（v3/test/listing-imports-async.test.js）。
const IMPORTS_SRC = "v3/src/listingImportAsync.js";
const IMPORTS_SYNC_SRC = "v3/src/listingImport.js";
const IMPORTS_MUTATIONS = [
  {
    name: "會員清單不篩 user_id（看得到別人的匯入）",
    file: IMPORTS_SRC,
    from: "    const rows = (await run(IMPORT_MINE_SQL, [uid, importListLimit(limit, { cap: 50, fallback: 20 })])).rows || [];",
    to: "    const rows = (await run(\"SELECT * FROM listing_import ORDER BY id DESC LIMIT ?\", [importListLimit(limit, { cap: 50, fallback: 20 })])).rows || [];",
    expect: "會員清單",
  },
  {
    name: "後台清單拿掉 LEFT JOIN（member_email 永遠空）",
    file: IMPORTS_SYNC_SRC,
    from: "export const IMPORT_ADMIN_SQL = `SELECT i.*, u.email AS member_email\n     FROM listing_import i\n     LEFT JOIN users u ON u.id = i.user_id\n     ORDER BY i.id DESC LIMIT ?`;",
    to: "export const IMPORT_ADMIN_SQL = `SELECT i.*, '' AS member_email\n     FROM listing_import i\n     ORDER BY i.id DESC LIMIT ?`;",
    expect: "後台清單",
  },
  {
    name: "後台清單不回傳 member_email 欄位",
    file: IMPORTS_SYNC_SRC,
    from: "export function importAdminView(row) {\n  return { ...rowToImport(row), member_email: row.member_email || \"\" };\n}",
    to: "export function importAdminView(row) {\n  return rowToImport(row);\n}",
    expect: "後台清單",
  },
  {
    name: "清單順序反過來（舊到新）",
    file: IMPORTS_SYNC_SRC,
    from: "export const IMPORT_MINE_SQL = \"SELECT * FROM listing_import WHERE user_id=? ORDER BY id DESC LIMIT ?\";",
    to: "export const IMPORT_MINE_SQL = \"SELECT * FROM listing_import WHERE user_id=? ORDER BY id ASC LIMIT ?\";",
    expect: "會員清單",
  },
  {
    name: "會員清單的上限被放寬到 5000",
    file: IMPORTS_SYNC_SRC,
    from: "export function importListLimit(limit, { cap, fallback }) {\n  return Math.min(cap, Number(limit) || fallback);\n}",
    to: "export function importListLimit(limit, { fallback }) {\n  return Number(limit) || fallback;\n}",
    expect: "上限是共用政策",
  },
  {
    name: "沒給 limit 時的預設值寫錯（20 變 200）",
    file: IMPORTS_SYNC_SRC,
    from: "export function importListLimit(limit, { cap, fallback }) {\n  return Math.min(cap, Number(limit) || fallback);\n}",
    to: "export function importListLimit(limit, { cap }) {\n  return Math.min(cap, Number(limit) || 200);\n}",
    expect: "上限是共用政策",
  },
  {
    name: "非 postgres 模式也走 PG 分支（SQLite 站會壞）",
    file: IMPORTS_SRC,
    from: "  if (!isPg(options)) return runSqlite();\n",
    to: "",
    expect: "非 postgres 模式必須走同步路徑",
  },
];

// 檢舉站內刊登／後台隱藏 PG 分支的變異集（v3/test/self-listing-report-async.test.js）。
const SELFREPORT_SRC = "v3/src/selfListingsAsync.js";
const SELFREPORT_SYNC_SRC = "v3/src/selfListings.js";
const SELFREPORT_MUTATIONS = [
  {
    name: "達門檻不隱藏（檢舉再多都不會下架）",
    file: SELFREPORT_SYNC_SRC,
    from: "export const SELF_REPORT_HIDE_AFTER = 2;",
    to: "export const SELF_REPORT_HIDE_AFTER = 9999;",
    expect: "第一筆只寫檢舉不隱藏",
  },
  {
    name: "第一筆就隱藏（門檻寫成 1）",
    file: SELFREPORT_SYNC_SRC,
    from: "export const SELF_REPORT_HIDE_AFTER = 2;",
    to: "export const SELF_REPORT_HIDE_AFTER = 1;",
    expect: "第一筆只寫檢舉不隱藏",
  },
  {
    name: "重複檢舉不先查（同一人會多一列）",
    file: SELFREPORT_SRC,
    from: "  const already = await exec(REPORT_EXISTS_SQL, [row.post_id, uid]);\n  const alreadyRows = Array.isArray(already) ? already : (already?.rows || []);\n  if (alreadyRows[0]) return { ok: true, already: true };\n",
    to: "",
    expect: "同一人重複檢舉",
  },
  {
    name: "不檢查『不能檢舉自己的刊登』",
    file: SELFREPORT_SRC,
    from: '  if (Number(row.listed_by_user_id) === uid) throw httpError("不能檢舉自己的刊登");\n',
    to: "",
    expect: "自己的刊登",
  },
  {
    name: "隱藏只寫 PG，不讓本機 handle 追上（本機清單還看得到）",
    file: SELFREPORT_SRC,
    from: "  sqliteHandle().prepare(HIDE_SELF_LISTING_SQL).run(stamp, row.post_id);\n",
    to: "",
    expect: "第一筆只寫檢舉不隱藏",
  },
  {
    name: "停權只寫 PG（換一台節點就又能上傳）",
    file: SELFREPORT_SRC,
    from: "  try { sqliteHandle().prepare(BAN_SELF_PUBLISHER_SQL).run(until, row.listed_by_user_id); } catch { /* 本機可能還沒有這一欄 */ }\n",
    to: "",
    expect: "停權之後",
  },
  {
    name: "停權時間的字串解析寫錯（餵 ISO 字串時退回當下）",
    file: SELFREPORT_SYNC_SRC,
    from: "  const ms = now instanceof Date ? now.getTime() : Date.parse(now);\n  const base = Number.isFinite(ms) ? ms : Date.now();",
    to: "  const base = now instanceof Date ? now.getTime() : Number(now) || Date.now();",
    expect: "後台隱藏",
  },
  {
    name: "非 postgres 模式也走 PG 分支（SQLite 站會壞）",
    file: SELFREPORT_SRC,
    from: '  if ((options.driver || resolveDbDriver()) !== "postgres") {\n    return (await import("./db.js")).reportSelfListing(userId, postId, reason);\n  }\n',
    to: "",
    expect: "非 postgres 模式必須走同步路徑",
  },
];

// 匯入生命週期（讀取／修改／取消）PG 分支的變異集
// （v3/test/listing-import-lifecycle-async.test.js）。
const IMPLIFE_SRC = "v3/src/listingImportAsync.js";
const IMPLIFE_SYNC_SRC = "v3/src/listingImport.js";
const IMPLIFE_MUTATIONS = [
  {
    name: "讀取不檢查所有權（可以看別人的匯入）",
    file: IMPLIFE_SRC,
    from: "    const row = assertImportOwner(await readImportRow(run, id), userId);\n    return publicImportAsync(row, {}, options, run);",
    to: "    const row = await readImportRow(run, id);\n    return publicImportAsync(row, {}, options, run);",
    expect: "讀取：公開形狀逐鍵相同",
  },
  {
    // 📌 原本想驗「沒有草稿時 listing 是 null 不是 undefined」，實測**殺不死**：
    // `publicImportShape(row, { listing = null } = {})` 的**預設參數**對「顯式傳 undefined」
    // 一樣生效 ⇒ `listing: undefined` 進到函式裡還是 `null`，那個變異是等價的。
    // 照紀律：不為了殺它而發明測試，改成驗「PG 版根本沒去查草稿」這個**有鑑別力**的變異。
    name: "PG 版不做草稿查詢（listing 永遠 null）",
    file: IMPLIFE_SRC,
    from: "  const resolved = listing === undefined ? await safeListingAsync(row, options, exec) : listing;",
    to: "  const resolved = listing === undefined ? null : listing;",
    expect: "讀取：公開形狀逐鍵相同",
  },
  {
    name: "修改不檢查狀態（已確認的也能改）",
    file: IMPLIFE_SRC,
    from: "    if (row.status !== IMPORT_STATUSES.READY_FOR_REVIEW) {\n      throw httpError(\"這筆匯入目前不能修改\", 409, row.status);\n    }\n",
    to: "",
    expect: "修改：狀態不是 ready_for_review",
  },
  {
    name: "修改只寫 PG，不讓本機追上",
    file: IMPLIFE_SRC,
    from: "    sqliteHandle().prepare(IMPORT_TITLE_TEXT_UPDATE_SQL).run(title, text, row.id);\n",
    to: "",
    expect: "修改：標題與內容會淨化",
  },
  {
    name: "標題不淨化（PG 版原樣寫入，頭尾空白留著）",
    file: IMPLIFE_SRC,
    from: "    const title = input.title != null ? sanitizeImportedTitle(input.title) : row.imported_title;",
    to: "    const title = input.title != null ? String(input.title) : row.imported_title;",
    expect: "修改：標題與內容會淨化",
  },
  {
    name: "取消不擋已確認的匯入",
    file: IMPLIFE_SRC,
    from: '    if (row.status === IMPORT_STATUSES.CONFIRMED) throw httpError("已確認的匯入不能取消", 409);\n',
    to: "",
    expect: "取消：已取消是 idempotent",
  },
  {
    name: "取消不把草稿一起收掉",
    file: IMPLIFE_SRC,
    from: "      await abandonImportedDraftListingAsync(userId, row.listing_id, { now, ...IMPORT_ROW_OPTIONS(rest, run) });\n",
    to: "",
    expect: "取消：匯入變 cancelled",
  },
  {
    name: "非 postgres 模式也走 PG 分支（SQLite 站會壞）",
    file: IMPLIFE_SRC,
    from: "  if (!isPg(options)) return runSqlite();\n",
    to: "",
    expect: "非 postgres 模式必須走同步路徑",
  },
];

// 變更紀錄（data revision）PG 分支的變異集（v3/test/data-revision-async.test.js）。
const DATAREV_SRC = "v3/src/dataRevisionAsync.js";
const DATAREV_SYNC_SRC = "v3/src/dataRevision.js";
const DATAREV_MUTATIONS = [
  {
    name: "currentRevision 用 COUNT(*) 而不是 MAX(id)",
    file: DATAREV_SRC,
    from: 'export const CURRENT_REVISION_SQL = "SELECT MAX(id) AS n FROM data_revision";',
    to: 'export const CURRENT_REVISION_SQL = "SELECT COUNT(*) AS n FROM data_revision";',
    expect: "currentRevision：是 MAX(id)",
  },
  {
    name: "changesSince 用 >= 而不是 >（同一筆會重複送）",
    file: DATAREV_SRC,
    from: "export const CHANGES_SINCE_SQL =\n  \"SELECT id, entity_type, entity_id, event_type, created_at FROM data_revision WHERE id > ? ORDER BY id ASC LIMIT ?\";",
    to: "export const CHANGES_SINCE_SQL =\n  \"SELECT id, entity_type, entity_id, event_type, created_at FROM data_revision WHERE id >= ? ORDER BY id ASC LIMIT ?\";",
    expect: "changesSince：嚴格大於",
  },
  {
    name: "changesSince 排序反過來（客戶端會倒著套用）",
    file: DATAREV_SRC,
    from: "ORDER BY id ASC LIMIT ?\";",
    to: "ORDER BY id DESC LIMIT ?\";",
    expect: "changesSince：嚴格大於",
  },
  {
    name: "changesSince 不夾上限（limit 999999 直接送進 SQL）",
    file: DATAREV_SRC,
    from: "  const cap = Math.max(1, Math.min(Number(limit) || 500, CHANGES_SINCE_MAX));",
    to: "  const cap = Math.max(1, Number(limit) || 500);",
    expect: "changesSince：上限是共用政策",
  },
  {
    name: "同步版的 MAX(id) 改成 COUNT(*)",
    file: DATAREV_SYNC_SRC,
    from: '  const row = db.prepare("SELECT MAX(id) AS n FROM data_revision").get();',
    to: '  const row = db.prepare("SELECT COUNT(*) AS n FROM data_revision").get();',
    expect: "currentRevision：是 MAX(id)",
  },
  {
    name: "非 postgres 模式也走 PG 分支（SQLite 站會壞）",
    file: DATAREV_SRC,
    from: "  if (!isPg(options)) return runSqlite();\n",
    to: "",
    expect: "非 postgres 模式必須走同步路徑",
  },
  {
    // 少了這一句，全新節點（本機 SQLite 還沒有 `data_revision`）會被鏡射出**零欄表**，
    // 之後每一句都 42703。CI 的拋棄式資料庫上實際中過。
    name: "ensure 不先補來源表（會建出零欄表，症狀是 42703）",
    file: DATAREV_SRC,
    from: "  ensureDataRevisionTable(sqlite);\n",
    to: "",
    expect: "ensureDataRevisionStoreOnce：本機還沒有那張表時",
  },
];

// 會員同意紀錄 ＋ 匯入確認 PG 分支的變異集（v3/test/member-consents-async.test.js）。
const CONSENTS_SRC = "v3/src/memberConsentsAsync.js";
const CONSENTS_SYNC_SRC = "v3/src/memberConsents.js";
const CONFIRM_SRC = "v3/src/listingImportAsync.js";
const CONSENTS_MUTATIONS = [
  {
    name: "同意紀錄不比對既有列（同一份文件會一直寫新列）",
    file: CONSENTS_SRC,
    from: "    const existing = one((await run(CONSENT_EXISTS_SQL, [uid, documentId, hash])).rows);\n",
    to: "    const existing = null;\n",
    expect: "同意紀錄：列表、idempotent",
  },
  {
    name: "同意紀錄不鏡射本機（同步的註冊流程看不到）",
    file: CONSENTS_SRC,
    // ⚠️ 錨點跟著實作更新（`mirror()` 在第四十八批之後多了 `LOCAL_USER_SQL` 守衛與 try/catch）。
    from: "    mirror({ document_type: type, version, source, agreed_at: isoOf(now) }, version);",
    to: "    void mirror;",
    expect: "同意紀錄：列表、idempotent",
  },
  {
    name: "待同意文件只比 document_id（換版本也當成已同意）",
    file: CONSENTS_SRC,
    from: "  const row = one((await run(CONSENT_EXISTS_SQL, [Number(userId), Number(doc.id), doc.content_hash])).rows);\n  return Boolean(row);",
    to: "  const row = (await run(CONSENTS_BY_USER_SQL, [Number(userId)])).rows.find((r) => Number(r.document_id) === Number(doc.id));\n  return Boolean(row);",
    expect: "待同意文件",
  },
  {
    name: "requires_reacceptance 被忽略（legacy 同意永遠算數）",
    file: CONSENTS_SRC,
    from: "    if (doc.requires_reacceptance) return false;\n",
    to: "",
    expect: "待同意文件",
  },
  {
    name: "批次同意不檢查缺件（少送也照樣放行）",
    file: CONSENTS_SRC,
    from: '      if (!hit) throw httpError("請先閱讀並同意更新後的條款", 400);\n',
    to: "",
    expect: "批次同意",
  },
  {
    name: "歷史文件不檢查狀態（草稿也回得出去）",
    file: CONSENTS_SRC,
    from: '    if (!doc || doc.status !== "published") return null;',
    to: "    if (!doc) return null;",
    expect: "歷史文件",
  },
  {
    name: "匯入確認不比對 content_hash（舊版聲明也能確認）",
    file: CONFIRM_SRC,
    from: "      || submitted.content_hash !== current.content_hash\n",
    to: "",
    expect: "匯入確認：寫入同意",
  },
  {
    name: "匯入確認不寫同意紀錄（沒有留痕）",
    file: CONFIRM_SRC,
    from: "    await recordConsentAsync(userId, {\n      document_type: IMPORT_DECLARATION_TYPE,\n      document_id: current.id,\n      version: current.version,\n      content_hash: current.content_hash,\n      source: \"import\",\n    }, { now, ...IMPORT_ROW_OPTIONS(rest, run) });\n",
    to: "",
    expect: "匯入確認：寫入同意",
  },
  {
    name: "同步版的同意紀錄不比對既有列（同一份文件會一直寫新列）",
    file: CONSENTS_SYNC_SRC,
    from: "  const existing = db.prepare(\n    \"SELECT id FROM member_consents WHERE user_id=? AND document_id=? AND content_hash=? LIMIT 1\",\n  ).get(uid, documentId, hash);\n",
    to: "  const existing = null;\n",
    expect: "同意紀錄：列表、idempotent",
  },
  {
    name: "非 postgres 模式也走 PG 分支（SQLite 站會壞）",
    file: CONSENTS_SRC,
    from: "  if (!isPg(options)) return runSqlite();\n",
    to: "",
    expect: "非 postgres 模式必須走同步路徑",
  },
];

// CRM 開關 PG 分支的變異集（v3/test/crm-module-async.test.js）。
const CRMMOD_SRC = "v3/src/crmAsync.js";
const CRMMOD_MUTATIONS = [
  {
    name: '落地改成 JSON 字串（isCrmEnabled 永遠 true ⇒ 開關失效）',
    file: CRMMOD_SRC,
    from: '    await exec(CRM_ENABLED_UPSERT_SQL, [repo.CRM_ENABLED_KEY, enabled ? "1" : "0"]);',
    to: '    await exec(CRM_ENABLED_UPSERT_SQL, [repo.CRM_ENABLED_KEY, JSON.stringify(enabled ? "1" : "0")]);',
    expect: "落地必須是原始字串",
  },
  {
    name: "開關值反了（true 寫 0）",
    file: CRMMOD_SRC,
    from: '    await exec(CRM_ENABLED_UPSERT_SQL, [repo.CRM_ENABLED_KEY, enabled ? "1" : "0"]);',
    to: '    await exec(CRM_ENABLED_UPSERT_SQL, [repo.CRM_ENABLED_KEY, enabled ? "0" : "1"]);',
    expect: "關閉",
  },
  {
    name: "寫入後不回讀（回傳舊狀態）",
    file: CRMMOD_SRC,
    from: "    await exec(CRM_ENABLED_UPSERT_SQL, [repo.CRM_ENABLED_KEY, enabled ? \"1\" : \"0\"]);\n    return crmModuleAsync(options);",
    to: '    await exec(CRM_ENABLED_UPSERT_SQL, [repo.CRM_ENABLED_KEY, enabled ? "1" : "0"]);\n    return crmModuleSync(sqliteFor(options));',
    expect: "關閉",
  },
  {
    name: "注入式 exec 不經 rowsOf 正規化（{rows} 形狀會靜默少讀）",
    file: "v3/src/crmAsync.js",
    from: "    if (options.exec) return await runPostgres(injectedExec(options.exec));",
    to: "    if (options.exec) return await runPostgres(options.exec);",
    expect: "注入式 exec 的形狀不影響結果",
  },
];

// reconciliation 進度狀態 PG 分支的變異集（v3/test/same-house-backfill-status.test.js）。
const SHB_SRC = "v3/src/sameHouseAsync.js";
const BACKFILL_MUTATIONS = [
  {
    name: "last 不再 parse（回傳 JSON 字串而不是物件）",
    file: SHB_SRC,
    from: '    const last = JSON.parse((await read(BACKFILL_STATUS_KEY)) || "{}");',
    to: '    const last = (await read(BACKFILL_STATUS_KEY)) || "{}";',
    expect: "兩層編碼都要處理",
  },
  {
    name: "cursor 不轉數字（回傳字串）",
    file: SHB_SRC,
    from: "  const cursor = Number((await read(BACKFILL_SETTING_KEY)) || 0);",
    to: "  const cursor = (await read(BACKFILL_SETTING_KEY)) || 0;",
    expect: "兩層編碼都要處理",
  },
  {
    name: "讀錯鍵（cursor 與 last 對調）",
    file: SHB_SRC,
    from: "  const cursor = Number((await read(BACKFILL_SETTING_KEY)) || 0);",
    to: "  const cursor = Number((await read(BACKFILL_STATUS_KEY)) || 0);",
    expect: "兩層編碼都要處理",
  },
  {
    name: "last 壞掉時直接把例外往外丟（端點會 500）",
    file: SHB_SRC,
    from: "  } catch {\n    return { cursor, batch: RECONCILE_BATCH, last: {} };\n  }",
    to: "  } catch (error) {\n    throw error;\n  }",
    expect: "last 壞掉時回空物件",
  },
];

// 匯入功能說明 PG 分支的變異集（v3/test/listing-import-async.test.js）。
const LI_SRC = "v3/src/listingImportAsync.js";
const LISTINGIMPORT_MUTATIONS = [
  {
    // ⚠️ 第一版寫成「加一句 `void doc;`」——那是**無效變異**（完全沒改變行為），
    // 殺不死是必然的、不是測試的錯。改成真的會改行為的：把草稿也當成生效版本。
    name: "草稿也被當成生效版本",
    file: LI_SRC,
    from: '  const doc = await getEffectiveDocumentAsync(IMPORT_DECLARATION_TYPE, { now, ...options });',
    to: '  const doc = (await getEffectiveDocumentAsync(IMPORT_DECLARATION_TYPE, { now, ...options }))\n    || (await getDocumentByIdAsync((await listDocumentsAsync({ type: IMPORT_DECLARATION_TYPE, includeDrafts: true }, options))[0]?.id, options));',
    expect: "草稿不算數",
  },
  {
    name: "plan 沒有傳進組裝（sponsor 與 free 的 quota 會一樣）",
    file: LI_SRC,
    from: "  return importMetaShape(doc, { plan });",
    to: '  return importMetaShape(doc, { plan: "free" });',
    expect: "有已發布的聲明",
  },
  // 刻意**沒有**「拿掉 `if (!isPg(options)) return listingImportMeta(...)`」這一條：
  // 實測是**等價變異**——`getEffectiveDocumentAsync()` 自己就是 driver-aware 的
  // （內部有同樣的 `if (!isPg(options))` 回同步版），所以拿掉這一層的 early return，
  // SQLite 站仍然拿到磁碟那一份。那個 early return 是短路不是正確性守衛。
  // 留一條永遠 SURVIVED 的變異只會讓報告失去意義（本檔案前面已有同樣的前例）。
];

// 遠端客服開關 PG 分支的變異集（v3/test/site-command-async.test.js）。
const SC_SRC = "v3/src/siteCommandAsync.js";
const SITECOMMAND_MUTATIONS = [
  {
    name: "落地改成 JSON.stringify（存成 \"1\" 含引號 ⇒ isRemoteCsStopped 永遠 false）",
    file: SC_SRC,
    from: '    await exec(STOP_UPSERT_SQL, [REMOTE_CS_STOP_KEY, flag ? "1" : "0"]);',
    to: '    await exec(STOP_UPSERT_SQL, [REMOTE_CS_STOP_KEY, JSON.stringify(flag ? "1" : "0")]);',
    expect: "落地格式必須是原始字串",
  },
  {
    name: "讀取不查 PG（永遠當成沒有存值 ⇒ 開關永遠關不掉）",
    file: SC_SRC,
    from: "  const rows = await exec(STOP_SELECT_SQL, [REMOTE_CS_STOP_KEY]);\n  const raw = rows?.[0]?.value;\n  return raw == null ? null : String(raw);",
    to: "  return null;",
    expect: '有存值（"1"）',
  },
  {
    name: "讀取把任何非空值都當成停止（\"0\" 也會變停止）",
    file: SC_SRC,
    from: "  return raw == null ? null : String(raw);",
    to: '  return raw == null ? null : "1";',
    expect: '存值 "0" 也要是 false',
  },
  {
    name: "寫入不再 fail-closed（PG 失敗就無聲寫進沒人讀的 SQLite）",
    file: SC_SRC,
    from: "    if (!sqliteFallbackAllowed(options, { write: true })) throw error;\n    return runSqlite();",
    to: "    return runSqlite();",
    // ⚠️ 殺手是**新的 strict 測試**，不是「非 postgres 模式」那一條（那條只走成功路徑）。
    // 這已經是第三次 expect 指錯測試名而報成假 SURVIVED——改測試名或補測試時要一起看。
    expect: "strict：PG 失敗時必須往上丟",
  },
];

// 推播訂閱 PG 分支的變異集（v3/test/web-push-async.test.js）。
// 這批很小，但每一條都對應一個「壞掉會直接 42P10 或寫錯人」的地方。
const WP_SRC = "v3/src/webPushAsync.js";
const PUSH_MUTATIONS = [
  {
    name: "不補建 UNIQUE(endpoint)（正式站只有 pkey ⇒ ON CONFLICT 直接 42P10）",
    file: WP_SRC,
    // ⚠️ 刻意**不是**「刪掉這個 const」：那會讓整個模組載入失敗，工具只看到
    // 「整個檔案失敗」而抓不到任何測試名 ⇒ 變成假 SURVIVED。改成換成 no-op 語句。
    from: '  "CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_key ON push_subscriptions(endpoint)";',
    to: '  "SELECT 1";',
    expect: "bootstrap：先清重複再建 UNIQUE",
  },
  {
    name: "先建唯一索引才清重複（有重複時 CREATE UNIQUE INDEX 直接失敗）",
    file: WP_SRC,
    from: "    const dupes = await pgDriver.query(PG_DUPLICATE_ENDPOINTS_SQL);\n    for (const row of dupes.rows) {\n      await pgDriver.query(toPostgresSql(PG_DROP_DUPLICATE_ENDPOINT_SQL), [row.endpoint, row.keep_id]);\n    }\n    await pgDriver.exec(PG_CREATE_ENDPOINT_INDEX_SQL);",
    to: "    await pgDriver.exec(PG_CREATE_ENDPOINT_INDEX_SQL);",
    expect: "bootstrap：先清重複再建 UNIQUE",
  },
  {
    name: "schema bootstrap 不快取（每次訂閱都重建一次）",
    file: WP_SRC,
    from: "  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);\n",
    to: "",
    expect: "只做一次",
  },
  {
    name: "upsert 的衝突目標拿掉（同一支手機每次訂閱都新增一列）",
    file: WP_SRC,
    from: "   ON CONFLICT(endpoint) DO UPDATE SET\n     user_id = excluded.user_id,\n     p256dh = excluded.p256dh,\n     auth = excluded.auth,\n     last_seen_at = excluded.last_seen_at`;",
    to: "   `;",
    expect: "同一個 endpoint 再訂一次",
  },
  {
    name: "格式驗證不再共用（PG 分支放行任何 endpoint）",
    file: WP_SRC,
    from: "  const { endpoint, p256dh, auth } = pushSubscriptionFields(sub);",
    to: '  const { endpoint, p256dh, auth } = { endpoint: String(sub.endpoint || ""), p256dh: String(sub.p256dh || ""), auth: String(sub.auth || "") };',
    expect: "格式驗證",
  },
  {
    name: "取消訂閱不驗擁有者（會刪到別人的訂閱）",
    file: WP_SRC,
    from: 'export const PUSH_DELETE_SQL = "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?";',
    to: 'export const PUSH_DELETE_SQL = "DELETE FROM push_subscriptions WHERE endpoint = ? AND ? IS NOT NULL";',
    expect: "取消訂閱",
  },
  {
    // ⚠️ 刻意**沒有**「拿掉 `if (!uid || !url) return {ok:true}`」那一條：實測是**等價變異**
    // ——那個 early return 只是短路，刪除語句本身就按 `user_id` 過濾，拿掉之後仍然刪不掉東西，
    // 所以沒有任何測試該為它變紅。留一條永遠 SURVIVED 的變異只會讓報告失去意義。
    // 真正會壞的是「刪除不比對 endpoint」：
    name: "取消訂閱不比對 endpoint（同一使用者的其他裝置會被一起刪掉）",
    file: WP_SRC,
    from: 'export const PUSH_DELETE_SQL = "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?";',
    to: 'export const PUSH_DELETE_SQL = "DELETE FROM push_subscriptions WHERE user_id = ? AND ? IS NOT NULL";',
    expect: "取消訂閱",
  },
  {
    name: "寫入不再 fail-closed（PG 失敗就無聲寫進沒人讀的 SQLite）",
    file: WP_SRC,
    from: "    if (!sqliteFallbackAllowed(options, { write: true })) throw error;\n    return runSqlite();",
    to: "    return runSqlite();",
    expect: "strict：PG 失敗時必須往上丟",
  },
];

// 租屋目錄 PG 分支的變異集（v3/test/rental-catalog-async.test.js）。
// 這一組的重點是**行程內快取的一致性**：PG 寫完只改 DB 不改快取，同步路徑就會拿到舊目錄。
const RC_SRC = "v3/src/rentalCatalogAsync.js";
const RENTALCAT_MUTATIONS = [
  {
    name: "寫入目錄後不更新行程內快取（後台改完、前台沒變）",
    file: RC_SRC,
    from: "    await writePg(KEYS.draft, null, options);\n    hydrateCaches(next, await readFlagsPg(options));\n    return publicAdminCatalog(next);",
    to: "    await writePg(KEYS.draft, null, options);\n    return publicAdminCatalog(next);",
    expect: "寫入目錄",
  },
  {
    name: "讀取目錄時不把快取收斂到 PG（節點會一直用開機時那一份）",
    file: RC_SRC,
    from: "  hydrateCaches(catalog, flags);\n  return { catalog, flags };",
    to: "  return { catalog, flags };",
    expect: "讀取：沒有 stored 值時回預設目錄",
  },
  {
    name: "發布草稿後不更新快取（前台繼續用舊目錄）",
    file: RC_SRC,
    from: "    await writePg(KEYS.draft, null, options);\n    hydrateCaches(draft, await readFlagsPg(options));\n    return publicAdminCatalog(draft);",
    to: "    await writePg(KEYS.draft, null, options);\n    return publicAdminCatalog(draft);",
    expect: "草稿：儲存／讀回／發布",
  },
  {
    name: "發布草稿時不清掉草稿鍵（會一直停在「有待確認草稿」）",
    file: RC_SRC,
    from: "    await writePg(KEYS.catalog, draft, options);\n    await writePg(KEYS.draft, null, options);",
    to: "    await writePg(KEYS.catalog, draft, options);",
    expect: "草稿：儲存／讀回／發布",
  },
  {
    name: "沒有草稿時不擋（回傳 null 而不是 400）",
    file: RC_SRC,
    from: '    if (!draft) throw badRequest("沒有待確認的目錄草稿");\n',
    to: "",
    expect: "發布沒有草稿時",
  },
  {
    name: "草稿沒有先過安全檢查就落地",
    file: RC_SRC,
    from: "  const next = normalizeCatalog(catalogInput);\n  assertCatalogSafe(next);\n  return withFallback(options, {}, async () => {",
    to: "  const next = normalizeCatalog(catalogInput);\n  return withFallback(options, {}, async () => {",
    expect: "安全檢查",
  },
  {
    name: "目錄寫入沒有先過安全檢查就落地",
    file: RC_SRC,
    from: "  const next = normalizeCatalog(src.catalog || src);\n  assertCatalogSafe(next);\n  return withFallback(options, {}, async () => {",
    to: "  const next = normalizeCatalog(src.catalog || src);\n  return withFallback(options, {}, async () => {",
    expect: "安全檢查",
  },
  {
    name: "mutate 不支援的動作不再擋（靜靜寫回原目錄）",
    file: RC_SRC,
    from: '      throw badRequest("不支援的目錄操作");\n',
    to: "",
    expect: "mutate：不支援的動作",
  },
  {
    name: "delete_condition 不看引用數（有引用的條件被硬刪）",
    file: RC_SRC,
    from: "      const refs = await catalogConditionReferencesAsync(payload.id, options);\n      const result = deleteOrDisableCondition(catalog, payload.id, refs);",
    to: "      const result = deleteOrDisableCondition(catalog, payload.id, {});",
    expect: "mutate：upsert",
  },
  {
    name: "系統範本不再受保護（可以改名／覆寫／刪除）",
    file: RC_SRC,
    from: '    if (isSystemCatalogTemplate(next.id) || isSystemCatalogTemplate(input.id)) {\n      throw badRequest("系統範本只能套用，不能改名或覆寫");\n    }\n',
    to: "",
    expect: "範本：列表、新增、改名、刪除",
  },
  {
    name: "改名範本時不驗系統範本",
    file: RC_SRC,
    from: '    if (isSystemCatalogTemplate(id)) throw badRequest("系統範本不能改名稱");\n',
    to: "",
    expect: "範本：列表、新增、改名、刪除",
  },
  {
    name: "刪除範本時不驗系統範本",
    file: RC_SRC,
    from: '    if (isSystemCatalogTemplate(id)) throw badRequest("系統範本不能刪除");\n',
    to: "",
    expect: "範本：列表、新增、改名、刪除",
  },
  {
    name: "套用範本時找不到也不擋（回 undefined）",
    file: RC_SRC,
    from: '    if (!template) throw Object.assign(new Error("找不到這個範本"), { status: 404 });\n',
    to: "",
    expect: "找不到範本時",
  },
  {
    name: "許願條件讀取不查 PG（永遠回預設清單）",
    file: RC_SRC,
    from: "  return stored == null ? DEFAULT_WISH_CONDITIONS : mergeWishConditions(stored);",
    to: "  return DEFAULT_WISH_CONDITIONS;",
    expect: "許願條件：有存值時",
  },
  {
    name: "許願條件落地成裸陣列（不是 { items: [...] }）",
    file: RC_SRC,
    from: "  const next = { items: normalizeWishConditionItems(src.reset === true ? DEFAULT_WISH_CONDITIONS : src.items) };",
    to: "  const next = normalizeWishConditionItems(src.reset === true ? DEFAULT_WISH_CONDITIONS : src.items);",
    expect: "落地成 { items:",
  },
  {
    name: "開關讀取不查 PG（永遠回預設值）",
    file: RC_SRC,
    from: "  return normalizeRentalMarketplaceFlags((await readPg(KEYS.flags, options)) || {});",
    to: "  return normalizeRentalMarketplaceFlags({});",
    expect: "開關（rental-marketplace-flags）",
  },
  {
    name: "寫入不再 fail-closed（PG 失敗就無聲寫進沒人讀的 SQLite）",
    file: RC_SRC,
    from: "    if (!sqliteFallbackAllowed(options, { write: !read })) throw error;\n    return runSqlite();",
    to: "    return runSqlite();",
    expect: "strict：PG 失敗時必須往上丟",
  },
  // 第六十三批：`PUT /api/admin/rental-marketplace-flags`（開關寫入 ＋ 啟用時的許願遷移）。
  {
    name: "開關寫入不讀現值（部分更新把其他旗標全關掉）",
    file: RC_SRC,
    from: "  const prev = await readFlagsPg(options);\n  const next = normalizeRentalMarketplaceFlags({",
    to: "  const prev = normalizeRentalMarketplaceFlags({});\n  const next = normalizeRentalMarketplaceFlags({",
    expect: "部分更新不得關掉其他旗標",
  },
  {
    name: "開關寫入不逐段合併 wish 區塊（其他許願旗標被換掉）",
    file: RC_SRC,
    from: "    wish: { ...prev.wish, ...(src.wish || {}) },",
    to: "    wish: { ...(src.wish || {}) },",
    expect: "部分更新不得關掉其他旗標",
  },
  {
    name: "啟用生命週期時不遷移既有許願（遠期到期永遠不會到期）",
    file: RC_SRC,
    from: "        if (hasLifecycle) await migrateOpenWishesOnActivationAsync(tx, now, { hasMarker });\n",
    to: "",
    expect: "既有許願要在 PG 交易內遷移",
  },
  {
    name: "沒有 lifecycle 欄位時仍然硬跑遷移（對不存在的欄位寫入）",
    file: RC_SRC,
    from: "        if (hasLifecycle) await migrateOpenWishesOnActivationAsync(tx, now, { hasMarker });",
    to: "        await migrateOpenWishesOnActivationAsync(tx, now, { hasMarker });",
    expect: "沒有 lifecycle 欄位時",
  },
  {
    // 注意兩個**等價變異**（殺不死，已刪除並留下理由）：
    //   * 拿掉 SELECT 的 `WHERE status = 'open'`：純判斷第一行就檢查 status。
    //   * 在純判斷裡把 `status` 硬改成 "open"：那些列根本不會被 SELECT 選進來。
    // 真正會改錯資料的是「不看遷移標記」——已遷移過的列會被再遷一次（TTL 被往後推）。
    name: "遷移不看標記（已遷移過的許願每次啟用都被再遷一次）",
    file: RC_SRC,
    from: "    const patch = migrateOpenWishOnActivation(row, now);\n    if (!patch) continue;",
    to: '    const patch = migrateOpenWishOnActivation({ ...row, lifecycle_migrated_at: null }, now);\n    if (!patch) continue;',
    expect: "逐列重用純判斷",
  },
  {
    name: "本機 handle 不追上遷移（還沒搬完的讀取繼續顯示遠期到期）",
    file: RC_SRC,
    from: "      migrateOpenWishesOnActivation((await syncDb()).sqliteHandle(), now);\n",
    to: "",
    expect: "本機 handle 也要追上",
  },
  {
    name: "欄位探測忽略標記欄位（對沒有標記欄位的舊庫用含標記的 UPDATE）",
    file: RC_SRC,
    from: '    const hasMarker = hasLifecycle && (await hasColumnAsync(exec, "lifecycle_migrated_at"));',
    to: "    const hasMarker = hasLifecycle;",
    expect: "只有標記欄位缺席時",
  },
  {
    name: "欄位探測一律當成有（真的失敗也被吞成「有這個欄位」）",
    file: RC_SRC,
    from: "    if (isMissingRelation(error)) return false;\n    throw error;",
    to: "    return true;",
    expect: "沒有 lifecycle 欄位時",
  },
  {
    name: "開關寫入後不更新行程內快取（同步路徑還是舊開關）",
    file: RC_SRC,
    from: "      await readStatePg(txOptions);\n    };",
    to: "    };",
    expect: "部分更新不得關掉其他旗標",
  },
  {
    name: "開關寫入直接回內部形狀（跳過 publicRentalMarketplaceFlags）",
    file: RC_SRC,
    from: "    return publicRentalMarketplaceFlags(next);",
    to: "    return next;",
    expect: "部分更新不得關掉其他旗標",
  },
];

// comms（公告／贊助活動）PG 分支的變異集（v3/test/comms-async.test.js）。
const COMMS_SRC = "v3/src/commsAsync.js";
const COMMS_SYNC_SRC = "v3/src/comms.js";
const COMMS_MUTATIONS = [
  {
    name: "關閉公告時不再保留原本的已讀時間（COALESCE 拿掉）",
    file: COMMS_SRC,
    from: "ON CONFLICT(announcement_id, user_id) DO UPDATE SET dismissed_at=excluded.dismissed_at, read_at=COALESCE(announcement_member_state.read_at, excluded.read_at)",
    to: "ON CONFLICT(announcement_id, user_id) DO UPDATE SET dismissed_at=excluded.dismissed_at, read_at=excluded.read_at",
    expect: "upsert 語意",
  },
  {
    name: "已讀改成整列覆蓋（會清掉 dismissed_at）",
    file: COMMS_SRC,
    from: "ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at=excluded.read_at",
    to: "ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at=excluded.read_at, dismissed_at=NULL",
    expect: "upsert 語意",
  },
  {
    name: "公告更新不再遞增 version",
    file: COMMS_SRC,
    from: "      updated_at=?, version=version+1",
    to: "      updated_at=?",
    expect: "更新公告：version 遞增",
  },
  {
    name: "建立公告不寫稽核",
    file: COMMS_SRC,
    from: '      entity_type: "announcement", entity_id: doc.id, action: "create",\n      actor_id: actorId, detail: data.status, now: asDate(now),\n',
    to: "",
    expect: "建立公告",
  },
  {
    name: "生效窗判斷拿掉（過期公告照樣出現）",
    file: COMMS_SYNC_SRC,
    from: "    .filter((row) => isWithinWindow(row, now));\n}\n\nexport function publicActiveAnnouncements",
    to: "    ;\n}\n\nexport function publicActiveAnnouncements",
    expect: "生效窗",
  },
  {
    name: "未登入也去寫公告狀態（訪客會被寫進 announcement_member_state）",
    file: COMMS_SRC,
    from: '  if (!userId) return { ok: true, anonymous: true }; // 未登入：不動 DB（同步版同義）\n',
    to: "",
    expect: "未登入",
  },
  {
    name: "贊助活動更新時頻道整包取代（不是合併）",
    file: COMMS_SRC,
    from: "      channels: { ...current.channels, ...(input.channels || {}) },",
    to: "      channels: { ...(input.channels || {}) },",
    // ⚠️ expect 比對的是**測試名稱**，不是斷言訊息。第一版寫「頻道要合併」，但測試名是
    // 「建立／更新活動：頻道**合併**、落地列與稽核…」——殺手其實有跑出來，卻因為字串對不上
    // 而被報成假 SURVIVED。這已經是第二次（上一次是改名後忘了同步改 expect）。
    expect: "頻道合併",
  },
  {
    name: "曝光／點擊不再檢查活動是否已發布（草稿也會被計數）",
    file: COMMS_SRC,
    from: '    if (!campaign || !campaign.enabled || campaign.status !== "published") return { ok: false };\n',
    to: "",
    expect: "曝光／點擊事件",
  },
  {
    name: "曝光只寫事件列不推計數（數字永遠 0）",
    file: COMMS_SRC,
    from: '    await exec(kind === "impression" ? IMPRESSION_BUMP_SQL : CLICK_BUMP_SQL, [Number(campaignId)]);\n',
    to: "",
    expect: "曝光／點擊事件",
  },
  {
    name: "事件類型不驗證（view 這種亂傳的值也會落地）",
    file: COMMS_SRC,
    from: '  if (!allowed) throw httpError("事件類型不正確");\n',
    to: "",
    expect: "曝光／點擊事件",
  },
  {
    name: "listing 版位不再看 listing_placement（下架的活動仍會出現）",
    file: COMMS_SRC,
    from: "  return rows.filter((row) => row.listing_placement);",
    to: "  return rows;",
    expect: "活動的生效窗與 master",
  },
  {
    name: "master 開關失效（關掉贊助主開關仍然投放）",
    file: COMMS_SRC,
    from: "      if (config.sponsored_master_enabled === false) return [];\n",
    to: "",
    expect: "活動的生效窗與 master",
  },
  {
    name: "公開整包忘了拿掉 created_by（後台欄位外洩到公開 API）",
    file: COMMS_SRC,
    from: "    announcements: announcements.map((row) => ({ ...row, created_by: undefined })),",
    to: "    announcements,",
    expect: "publicCommsBundleAsync",
  },
  {
    name: "公開整包不再過濾 channel_inapp（沒開站內通道的也進通知）",
    file: COMMS_SRC,
    from: "      notify: notify.filter((row) => row.channels.inapp).map((row) => publicCampaignView(row)),",
    to: "      notify: notify.map((row) => publicCampaignView(row)),",
    expect: "publicCommsBundleAsync",
  },
  {
    name: "comms 的三個索引不補建（訪客端點退化成全表掃描）",
    file: COMMS_SRC,
    from: '  "CREATE INDEX IF NOT EXISTS idx_announcements_active ON system_announcements(enabled, status, start_at, end_at)",\n',
    to: "",
    expect: "ensureCommsStoreOnce",
  },
  {
    name: "announcement_member_state 的複合主鍵拿掉（ON CONFLICT 會找不到目標）",
    file: COMMS_SRC,
    from: "     dismissed_at TEXT,\n     PRIMARY KEY (announcement_id, user_id)\n   )`,",
    to: "     dismissed_at TEXT\n   )`,",
    expect: "ensureCommsStoreOnce",
  },
  {
    // 注入式 exec 若不經 rowsOf 正規化，`{ rows, rowCount }` 形狀會被當成「沒有資料列」。
    name: "注入式 exec 不經正規化（{rows} 形狀會靜默少讀）",
    file: "v3/src/commsAsync.js",
    from: "  if (options.exec) {\n    const injected = options.exec;\n    return async (sql, params = []) => rowsOf(await injected(sql, params));\n  }",
    to: "  if (options.exec) return options.exec;",
    expect: "注入式 exec 的形狀不影響結果",
  },
];

// 內容文件 PG 分支的變異集（v3/test/content-documents-async.test.js）。
// 這一組的重點是「不可變性」——那是用 PG trigger 實作的業務規則，不是加固。
const CD_SRC = "v3/src/contentDocumentsAsync.js";
const CD_SYNC_SRC = "v3/src/contentDocuments.js";
const CONTENTDOCS_MUTATIONS = [
  {
    // 注入式 exec 不經 `pgExec()` 正規化 ⇒ `{ rows, rowCount }` 形狀會被當成「沒有資料列」，
    // 版本算成 1 而撞唯一鍵（live PG 測試抓到；「exec 形狀」第六次）。
    name: "注入式 exec 不經正規化（{rows} 形狀會把版本算成 1）",
    file: CD_SRC,
    from: "    if (options.exec) return await runPostgres(await pgExec(options));",
    to: "    if (options.exec) return await runPostgres(options.exec);",
    expect: "注入式 exec 的兩種形狀都要吃得下",
  },
  {
    name: "PG trigger 寫回 SQLite 語法 IS NOT OLD.body（PG 直接語法錯誤）",
    file: CD_SRC,
    from: "       NEW.body IS DISTINCT FROM OLD.body",
    to: "       NEW.body IS NOT OLD.body",
    expect: "PG 的觸發器 SQL 必須用 IS DISTINCT FROM",
  },
  {
    name: "PG trigger 寫回 RAISE(ABORT)（那是 SQLite 的寫法）",
    file: CD_SRC,
    from: "       RAISE EXCEPTION 'published_document_immutable';",
    to: "       RAISE(ABORT, 'published_document_immutable');",
    expect: "PG 的觸發器 SQL 必須用 IS DISTINCT FROM",
  },
  {
    name: "不可變清單漏掉 content_hash（已發布文件的指紋可以被改）",
    file: CD_SRC,
    from: "       OR NEW.content_hash IS DISTINCT FROM OLD.content_hash\n",
    to: "",
    expect: "PG 的觸發器 SQL 必須用 IS DISTINCT FROM",
  },
  {
    name: "bootstrap 先建 trigger 才建函式（PG 會找不到函式而失敗）",
    file: CD_SRC,
    from: "    await pgDriver.exec(PG_IMMUTABLE_FUNCTION_SQL);\n    await pgDriver.exec(PG_DROP_TRIGGER_SQL);\n    await pgDriver.exec(PG_CREATE_TRIGGER_SQL);",
    to: "    await pgDriver.exec(PG_CREATE_TRIGGER_SQL);\n    await pgDriver.exec(PG_IMMUTABLE_FUNCTION_SQL);\n    await pgDriver.exec(PG_DROP_TRIGGER_SQL);",
    expect: "PG 的觸發器 SQL 必須用 IS DISTINCT FROM",
  },
  {
    name: "schema bootstrap 不快取（每次呼叫都重建一次）",
    file: CD_SRC,
    from: "  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);\n",
    to: "",
    expect: "PG 的觸發器 SQL 必須用 IS DISTINCT FROM",
  },
  {
    name: "拿掉應用層的「已發布不可改本文」檢查（只剩 DB trigger 擋，回傳變成 500）",
    file: CD_SRC,
    from: '      if (input.title != null || input.body != null || input.format != null || input.check_label != null) {\n        throw httpError("已發布版本不可改本文；請建立新版本", 409);\n      }\n',
    to: "",
    expect: "已發布的文件：改本文必須被擋",
  },
  {
    name: "拿掉重複版本號的檢查（同一版可以寫兩次）",
    file: CD_SRC,
    from: '    if (await readByTypeVersion(exec, type, version)) throw httpError("這個版本號已存在", 409);\n',
    to: "",
    expect: "同一個版本號第二次要被擋",
  },
  {
    name: "生效判定不看 enabled（停用的版本仍會生效）",
    file: CD_SYNC_SRC,
    from: '  if (!doc || doc.status !== "published" || !doc.enabled) return false;',
    to: '  if (!doc || doc.status !== "published") return false;',
    expect: "目前生效版本",
  },
  {
    name: "生效判定不看 effective_from（未到生效日就生效）",
    file: CD_SYNC_SRC,
    from: "  if (doc.effective_from && String(doc.effective_from) > nowIso) return false;\n",
    to: "",
    expect: "目前生效版本",
  },
  {
    name: "開新版本不記 supersedes_id（版本鏈斷掉）",
    file: CD_SRC,
    from: "    supersedes_id: doc.id,",
    to: "    supersedes_id: null,",
    expect: "從已發布版本開新草稿",
  },
  {
    name: "重複發布不再提前回（會多寫一筆 publish 稽核）",
    file: CD_SRC,
    from: '    if (doc.status === "published") return doc; // 已發布 ⇒ 直接回，不重複寫稽核（同步版同義）\n',
    to: "",
    expect: "發布：狀態、published_at",
  },
  {
    name: "旗標的三態判斷壞掉（沒帶的欄位會被重設成 0）",
    file: CD_SRC,
    from: "  return current ? 1 : 0;",
    to: "  return 0;",
    expect: "更新草稿：只改帶到的欄位",
  },
  {
    name: "拿掉不安全標記的檢查（可以存進 script 標籤）",
    file: CD_SYNC_SRC,
    from: '  if (containsUnsafeMarkup(body) || containsUnsafeMarkup(title) || containsUnsafeMarkup(check_label)) {\n    throw httpError("內容含有不安全標記，已拒絕儲存", 400);\n  }\n',
    to: "",
    expect: "建立草稿：未知文件類型、空標題、不安全標記",
  },
  {
    name: "稽核事件的 limit 不再夾範圍（可以一次拉整張表）",
    file: CD_SRC,
    from: "  const n = Math.min(200, Math.max(1, Number(limit) || 50));",
    to: "  const n = Number(limit) || 50;",
    expect: "稽核事件列表",
  },
  {
    name: "legalCopy 不再退回預設文案（沒有文件時條款變空字串）",
    file: CD_SRC,
    from: "    disclaimer: terms?.body || defaults.disclaimer,",
    to: "    disclaimer: terms?.body,",
    expect: "註冊必要文件與 legalCopy",
  },
];

// 會員照片素材庫 PG 分支的變異集（v3/test/member-media-async.test.js）。
const MM_SRC = "v3/src/memberMediaAsync.js";
const MM_SYNC_SRC = "v3/src/memberMedia.js";
const MEMBERMEDIA_MUTATIONS = [
  {
    name: "排序寫回 COLLATE NOCASE（PG 沒有這個 collation ⇒ 語法錯誤）",
    file: MM_SRC,
    from: '"SELECT id, name, created_at FROM media_tags WHERE user_id=? ORDER BY lower(name)"',
    to: '"SELECT id, name, created_at FROM media_tags WHERE user_id=? ORDER BY name COLLATE NOCASE"',
    expect: "不得出現 COLLATE NOCASE",
  },
  {
    name: "不補建 media_tags 的 UNIQUE(user_id,name)（同名標籤會重複）",
    file: MM_SRC,
    from: "    await pgDriver.exec(PG_CREATE_TAG_NAME_INDEX_SQL);\n  })();",
    to: "  })();",
    expect: "ensureMemberMediaStoreOnce",
  },
  {
    name: "不補建 storage_key 的唯一索引（同一張圖可以寫兩列）",
    file: MM_SRC,
    from: "    await pgDriver.exec(PG_CREATE_MEDIA_KEY_INDEX_SQL);\n",
    to: "",
    expect: "ensureMemberMediaStoreOnce",
  },
  {
    name: "先建標籤唯一索引才清重複（有重複時 CREATE UNIQUE INDEX 直接失敗）",
    file: MM_SRC,
    from: "    await dedupeTags(pgDriver);\n    await pgDriver.exec(PG_CREATE_TAG_NAME_INDEX_SQL);",
    to: "    await pgDriver.exec(PG_CREATE_TAG_NAME_INDEX_SQL);\n    await dedupeTags(pgDriver);",
    expect: "ensureMemberMediaStoreOnce",
  },
  {
    name: "清重複標籤時不把對應改指到保留者（使用者的分類直接消失）",
    file: MM_SRC,
    from: "      await q(PG_REPOINT_TAG_MAP_SQL, [row.keep_id, dup.id]);\n",
    to: "",
    expect: "ensureMemberMediaStoreOnce",
  },
  {
    // 🚨 這一條是 2026-09-27 **live PG 才炸出來**的那個 bug：`pgDriver.query()` 不翻譯
    // SQLite 方言，dedupe 忘了 `toPostgresSql` ⇒ `?` 直接送 PG ⇒ `syntax error at or near "AND"`。
    // 離線夾具當時抓不到（沒有重複資料所以迴圈沒跑）；現在假 driver 會拒絕 `?`，離線就擋得住。
    name: "dedupe 忘了翻譯方言（? 直接送 PG ⇒ 語法錯誤）",
    file: MM_SRC,
    from: "  const q = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params);\n  const dupes = await q(PG_DUPLICATE_TAGS_SQL);",
    to: "  const q = (sql, params = []) => pgDriver.query(sql, params);\n  const dupes = await q(PG_DUPLICATE_TAGS_SQL);",
    expect: "ensureMemberMediaStoreOnce",
  },
  {
    name: "schema bootstrap 不快取（每次呼叫都重建一次）",
    file: MM_SRC,
    from: "  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);\n",
    to: "",
    expect: "只做一次",
  },
  {
    name: "重複判斷放寬成「什麼錯都算重複」（連線斷了會被報成 409 tag_exists）",
    file: MM_SRC,
    from: '  return error?.code === "23505" || /UNIQUE constraint failed|duplicate key/i.test(String(error?.message || ""));',
    to: "  return true;",
    expect: "非重複的錯誤不得被誤報成 409",
  },
  {
    name: "used 改成過濾後的列數（配額會隨著 tag 篩選而變）",
    file: MM_SRC,
    from: "        used: countOf(await exec(COUNT_ACTIVE_MEDIA_SQL, [uid])),",
    to: "        used: rows.length,",
    expect: "列出素材：免費配額",
  },
  {
    name: "tagIds 篩選失效（所有照片都會被列出來）",
    file: MM_SRC,
    from: "        rows = rows.filter((row) => matched.has(Number(row.id)));\n",
    to: "",
    expect: "列出素材：免費配額",
  },
  {
    name: "設定標籤時不驗標籤擁有權（可以把別人的標籤掛到自己的照片）",
    file: MM_SRC,
    from: `    for (const tagId of ids) {
      const tag = firstRow(await exec(TAG_ID_OWNED_SQL, [tagId, uid]));
      if (!tag) throw httpError("找不到標籤或無權限", 404);
    }
`,
    to: "",
    expect: "設定照片標籤：照片或標籤不是自己的",
  },
  {
    name: "刪除時不看有沒有被刊登引用（一律清檔 ⇒ 歷史頁面破圖）",
    file: MM_SRC,
    from: "    const referenced = Boolean(firstRow(await exec(IS_MEDIA_REFERENCED_SQL, [url, `%${url}%`])));",
    to: "    const referenced = false;",
    expect: "被站內刊登引用時保留實體檔",
  },
  {
    name: "軟刪除改成硬刪除（列直接消失，歷史引用查不到）",
    file: MM_SRC,
    from: "    await exec(SOFT_DELETE_MEDIA_SQL, [ts, Number(id), uid]);",
    to: '    await exec("DELETE FROM member_media WHERE id=? AND user_id=?", [Number(id), uid]);',
    expect: "刪除素材：軟刪除",
  },
  {
    name: "標籤名稱不去空白（前後空白會變成不同的標籤）",
    file: MM_SYNC_SRC,
    // 錨點刻意不含反斜線：第一版寫了 `\\s+` 這種多層跳脫，結果 Python 的 heredoc 把反斜線吃掉，
    // 錨點變成 `.replace(/s+/g, " ")` 找不到（工具的前置檢查正確地擋下、沒有留下半變異狀態）。
    from: '" ").trim().slice(0, 40);',
    to: '" ").slice(0, 40);',
    expect: "建立標籤：同名會重用既有的",
  },
  {
    // 第六十二批：上傳＝「配額檢查 ＋ INSERT」必須在同一個交易裡。把配額查在交易外，
    // 兩個並行上傳會各自通過檢查 ⇒ 超過方案上限。
    name: "上傳不檢查配額（可以無限上傳）",
    file: "v3/src/memberMediaAsync.js",
    from: "      const used = countOf(await exec(COUNT_ACTIVE_MEDIA_SQL, [uid]));\n      if (used >= quota) {",
    to: "      const used = 0;\n      if (used >= quota) {",
    expect: "配額滿了回 409",
  },
  {
    name: "上傳失敗時不清掉剛寫的檔（留下孤兒檔）",
    file: "v3/src/memberMediaAsync.js",
    from: "  } catch (error) {\n    await cleanup();\n    throw error;\n  }",
    to: "  } catch (error) {\n    throw error;\n  }",
    expect: "交易失敗時檔案與 CDN 物件都要清掉",
  },
  {
    name: "上傳不回讀剛建立的那一列（回 id 而不是完整物件）",
    file: "v3/src/memberMediaAsync.js",
    from: "    return await getOwnedMediaAsync(uid, id, options);",
    to: "    return { id };",
    expect: "配額沒滿就寫入 PG",
  },
];

// 刊登生產力工具（說明範本／聯絡人）PG 分支的變異集
// （v3/test/listing-tools-async.test.js）。這一組每一條都對應一個「壞掉會怎樣」。
const LT_SRC = "v3/src/listingToolsAsync.js";
const LT_SYNC_SRC = "v3/src/listingTools.js";
const LISTINGTOOLS_MUTATIONS = [
  {
    name: "把 COALESCE 寫回 IFNULL（PG 不接受 IFNULL，且注入式 exec 不經轉譯）",
    file: LT_SRC,
    from: '  "SELECT * FROM listing_contact_profile WHERE user_id=? ORDER BY COALESCE(is_account,0) DESC, id";',
    to: '  "SELECT * FROM listing_contact_profile WHERE user_id=? ORDER BY IFNULL(is_account,0) DESC, id";',
    expect: "PG 分支的語句不得出現 IFNULL",
  },
  {
    name: "拿掉說明範本的上限判斷（免費使用者可以建無限多則）",
    file: LT_SRC,
    from: '    if (n >= limit) throw httpError(`說明範本最多 ${limit} 則`, 409, "template_limit");\n',
    to: "",
    expect: "免費上限 2 則",
  },
  {
    name: "同名不再合併（每次建立都新增一列）",
    file: LT_SRC,
    from: "    const same = firstRow(await exec(TEMPLATE_BY_NAME_SQL, [uid, name]));",
    to: "    const same = null;",
    expect: "同名是「更新既有那一筆」",
  },
  {
    name: "拿掉範本的擁有權檢查（別人的範本也能讀到）",
    file: LT_SRC,
    from: '  if (Number(row.user_id) !== Number(uid)) throw httpError("只能使用自己的說明範本", 403);\n',
    to: "",
    expect: "擁有權",
  },
  {
    name: "更新時不沿用舊值（只改內文會把名稱清空）",
    file: LT_SRC,
    from: "    const { name, body } = templateFields(rawInput, row); // 沒帶的欄位沿用舊值（同步版同義）",
    to: "    const { name, body } = templateFields(rawInput);",
    expect: "只帶 body 時名稱要沿用舊值",
  },
  {
    name: "拿掉聯絡人的上限判斷（可以建無限多個手動聯絡人）",
    file: LT_SRC,
    from: '    if (n >= CONTACT_PROFILE_LIMIT) {\n      throw httpError(`聯絡人最多 ${CONTACT_PROFILE_LIMIT} 則`, 409, "contact_limit");\n    }\n',
    to: "",
    expect: "手動聯絡人",
  },
  {
    name: "帳號聯絡人改成可以修改（鎖定失效）",
    file: LT_SRC,
    from: '    if (Number(row.is_account) === 1) {\n      throw httpError("此帳號聯絡人會跟著個人資料更新，不能改這裡", 403, "account_contact_locked");\n    }\n',
    to: "",
    expect: "不可改、不可刪",
  },
  {
    name: "帳號聯絡人改成可以刪除（鎖定失效）",
    file: LT_SRC,
    from: '    if (Number(row.is_account) === 1) throw httpError("此帳號聯絡人不能刪除", 403, "account_contact_locked");\n',
    to: "",
    expect: "不可改、不可刪",
  },
  {
    name: "聯絡人輸入不驗證（電話太短、缺 label 都放行）",
    file: LT_SRC,
    from: "  const fields = sanitizeContactInput(rawInput); // 純驗證，兩邊共用同一份",
    to: "  const fields = { label: rawInput.label, contact_name: rawInput.contact_name || '', phone: rawInput.phone || '', line_url: rawInput.line_url || '' };",
    expect: "聯絡人驗證",
  },
  {
    name: "帳號聯絡人欄位不再從 users 推導（contact_name 永遠是空的）",
    file: LT_SYNC_SRC,
    from: "    contact_name: name.slice(0, SELF_CONTACT_MAX),",
    to: '    contact_name: "",',
    expect: "帳號聯絡人：第一次列出時自動建立",
  },
  {
    name: "先建唯一索引才清重複（有重複資料時 CREATE UNIQUE INDEX 直接失敗）",
    file: LT_SRC,
    from: "    await dedupeAccountContacts(pgDriver);\n    await pgDriver.exec(PG_CREATE_ACCOUNT_INDEX_SQL);",
    to: "    await pgDriver.exec(PG_CREATE_ACCOUNT_INDEX_SQL);\n    await dedupeAccountContacts(pgDriver);",
    expect: "先清重複、才建部分唯一索引",
  },
  {
    // 同一個 bug 的另一個現場：listingToolsAsync 的 dedupe 也曾經漏了翻譯，
    // 而它的 live PG 測試照樣通過（正式站的帳號聯絡人沒有重複）。
    name: "dedupe 忘了翻譯方言（? 直接送 PG ⇒ 語法錯誤）",
    file: LT_SRC,
    from: "  const q = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params);\n  const dupes = await q(PG_DUPLICATE_ACCOUNT_SQL);",
    to: "  const q = (sql, params = []) => pgDriver.query(sql, params);\n  const dupes = await q(PG_DUPLICATE_ACCOUNT_SQL);",
    expect: "先清重複、才建部分唯一索引",
  },
  {
    name: "schema bootstrap 不快取（每次呼叫都重建一次）",
    file: LT_SRC,
    from: "  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);\n",
    to: "",
    expect: "只做一次",
  },
  {
    name: "寫入不再 fail-closed（PG 寫失敗就無聲寫進沒人讀的 SQLite）",
    file: LT_SRC,
    from: "    if (!sqliteFallbackAllowed(options, { write: true })) throw error;\n    return runSqlite();",
    to: "    return runSqlite();",
    expect: "strict：PG 寫入失敗時必須往上丟",
  },
  {
    name: "注入式 exec 不經 rowsOf 正規化（{rows} 形狀會靜默少讀）",
    file: "v3/src/listingToolsAsync.js",
    from: "  if (options.exec) {\n    const injected = options.exec;\n    return async (sql, params = []) => rowsOf(await injected(sql, params));\n  }",
    to: "  if (options.exec) return options.exec;",
    expect: "注入式 exec 的形狀不影響結果",
  },
];

// Session 改成 PG 解析的變異集（v3/test/session-async.test.js）。
//
// 這一組每一條都對應一個「壞掉會怎樣」：快取失效（每請求 N 次查詢／退回本機）、
// 驗簽失效（過期或竄改的 token 放行）、刪除判斷失效（已刪除使用者仍登入）、
// fail-open 失效（PG 一抖就全站登出）、靜態跳過失效（每個圖檔都查一次 users）。
const AUTH_SRC = "v3/src/auth.js";
const SESSION_MUTATIONS = [
  {
    name: "readSession 不讀快取（退回同步路徑 ⇒ 又變成讀節點本機 SQLite）",
    file: AUTH_SRC,
    from: "  if (req && Object.prototype.hasOwnProperty.call(req, SESSION_SLOT)) return req[SESSION_SLOT];\n",
    to: "",
    expect: "同一請求內讀快取",
  },
  {
    name: "中介層解析完不寫進快取（做白工，身分還是來自本機）",
    file: AUTH_SRC,
    from: "      req[SESSION_SLOT] = await readSessionAsync(req, options);",
    to: "      await readSessionAsync(req, options);",
    expect: "核心：PG 有、節點本機沒有的使用者",
  },
  {
    name: "PG 分支改成一律走 SQLite（改動等於沒做）",
    file: AUTH_SRC,
    from: '  if (driver !== "postgres") return sessionFromUser(findUserByEmail(claim.email));',
    to: '  if (true) return sessionFromUser(findUserByEmail(claim.email));',
    expect: "核心：PG 有、節點本機沒有的使用者",
  },
  {
    name: "sessionFromUser 不檢查 deleted_at（已刪除的使用者照樣登入）",
    file: AUTH_SRC,
    from: '  if (!user || String(user.deleted_at || "").trim()) return null;',
    to: "  if (!user) return null;",
    expect: "已刪除的使用者",
  },
  {
    name: "sessionClaim 不檢查到期（過期 token 永遠有效）",
    file: AUTH_SRC,
    from: "    if (!data?.exp || Date.now() > Number(data.exp)) return null;",
    to: "    if (!data?.exp) return null;",
    expect: "過期的 token",
  },
  {
    name: "sessionClaim 不比對 MAC（簽章形同虛設）",
    file: AUTH_SRC,
    from: "  if (!payload || !mac || !safeEqual(sign(payload), mac)) return null;",
    to: "  if (!payload || !mac) return null;",
    expect: "MAC 被竄改",
  },
  {
    name: "fail-open 拿掉（PG 讀不到就等於全站登出）",
    file: AUTH_SRC,
    from: "    if (!sqliteFallbackAllowed(options)) throw error;\n",
    to: "",
    expect: "fail-open",
  },
  {
    name: "靜態資產不再跳過（帶 cookie 載入 30 個圖檔 = 30 次 users 查詢）",
    file: AUTH_SRC,
    from: "    if (!cookie.includes(`${COOKIE}=`) || isStaticAssetPath(req.path)) {",
    to: "    if (!cookie.includes(`${COOKIE}=`)) {",
    expect: "靜態資產即使帶 cookie",
  },
  {
    name: "靜態判斷退回四個前綴（public 根目錄的 .js／.css 每個檔案都查一次 users）",
    file: AUTH_SRC,
    from: "  return !DYNAMIC_ASSET_PATHS.includes(p);",
    to: '  return ["/vendor/", "/icons/", "/brand/", "/media/"].some((prefix) => p.startsWith(prefix));',
    expect: "isStaticAssetPath：靜態檔要跳過",
  },
  {
    name: "isStaticAssetPath 不比對副檔名（/media/self 這種動態路徑被當成靜態）",
    file: AUTH_SRC,
    from: "  if (!STATIC_EXT.test(p)) return false;\n",
    to: "",
    // 測試名在 2026-09-27 改過（合併成「靜態檔要跳過、動態路由不得被誤判」），
    // 這裡的 expect 也要跟著改——不然會變成「有殺手卻指名不到」的假 SURVIVED。
    expect: "isStaticAssetPath：靜態檔要跳過",
  },
  {
    name: "身分欄位漏掉 plan（形狀與舊版不一致）",
    file: AUTH_SRC,
    from: '  return { email: user.email, userId: Number(user.id), role: user.role || "member", plan: user.plan || "free" };',
    to: '  return { email: user.email, userId: Number(user.id), role: user.role || "member" };',
    expect: "PG 與本機兩條路的 session 形狀逐欄相同",
  },
];

// 後台設定 PG 分支的變異集（v3/test/admin-settings-async.test.js）。
// 這一組的 port 都很短，所以每一條都要證明「拿掉就失敗」，不能靠「看起來一樣」。
const ADMSET_MUTATIONS = [
  {
    // 第六十一批：`GET /api/admin/maps` 的開關必須讀 PG（讀本機就會顯示別的節點的狀態）。
    name: "後台地圖設定改讀本機的開關（PG 站顯示別的節點）",
    file: "v3/src/adminSettingsAsync.js",
    from: "    getSiteSettingAsync(GOOGLE_DIRECTIONS_KEY, options),\n    getSiteSettingAsync(COMMUTE_RUSH_KEY, options),",
    to: "    getSiteSettingAsync(\"__none__\", options),\n    getSiteSettingAsync(\"__none__\", options),",
    expect: "getAdminMapsSettingsAsync：開關、用量與 provider",
  },
  {
    name: "後台地圖設定不讀 PG 的用量（用量永遠 0）",
    file: "v3/src/adminSettingsAsync.js",
    from: "  const daily = await withMapsExec(options, (exec) => exec(MAPS_USAGE_SQL, []));",
    to: "  const daily = [];",
    expect: "getAdminMapsSettingsAsync：開關、用量與 provider",
  },
  {
    name: "後台地圖設定忽略預算為 0 的提示",
    file: "v3/src/adminSettingsAsync.js",
    from: "    warning: mapsBudgetWarning(baseWarning, { googleEnabled, dailyLimitMinor: cfg?.daily_limit_minor }),",
    to: "    warning: baseWarning,",
    expect: "getAdminMapsSettingsAsync：開關、用量與 provider",
  },
  {
    name: "品牌上傳不驗位置（任何 slot 都會被接受）",
    file: ADMSET_SRC,
    from: '  if (!BRAND_SLOTS.includes(key)) {\n    const err = new Error("請選擇要套用的位置");\n    err.status = 400;\n    throw err;\n  }\n',
    to: "",
    expect: "不合法／空白的位置要擋下",
  },
  {
    name: "品牌上傳一律走 clips（mark 位置改不動 markUrl）",
    file: ADMSET_SRC,
    from: '  if (key === "mark") {\n    return saveBrandMascotAsync({ ...current, markUrl: upload.url }, options);\n  }\n',
    to: "",
    expect: "mark 位置寫 markUrl",
  },
  {
    name: "廣告設定不查 PG（永遠回預設值）",
    file: ADMSET_SRC,
    from: '  return adminSiteAdsView(normalizeSiteAds(await getSiteSettingAsync("siteAds", options)));',
    to: "  return adminSiteAdsView(normalizeSiteAds(undefined));",
    expect: "有存值時要用存的那一份",
  },
  {
    name: "廣播設定不查 PG（永遠回預設值）",
    file: ADMSET_SRC,
    from: '  return adminBroadcastsView(normalizeBroadcasts(await getSiteSettingAsync("broadcasts", options)));',
    to: "  return adminBroadcastsView(normalizeBroadcasts(undefined));",
    expect: "getAdminBroadcastsSettingsAsync",
  },
  {
    name: "拿掉 getStoredSmtp 的環境變數 fallback（未設定 SMTP 的站台會寄不出信）",
    file: ADMSET_SRC,
    from: '  return smtpFromEnv();',
    to: '  return normalizeSmtp(stored);',
    expect: "環境變數的 fallback",
  },
  {
    // 注意：這條的殺手是**讀取**那條測試，不是「存的是公開形狀」那條。
    // 在儲存路徑上它是等價的（normalize 會再正規化一次），是變異測試讓我去補讀取測試的。
    name: "getBrandMascot 不套 publicBrandMascot（讀回來的形狀會少 productName）",
    file: ADMSET_SRC,
    from: '  return publicBrandMascot(stored || defaultBrandMascot());',
    to: '  return stored || defaultBrandMascot();',
    expect: "productName",
  },
  {
    name: "getSponsorConfig 不做 normalize（少掉預設欄位）",
    file: ADMSET_SRC,
    from: '  return normalizeSponsorConfig(await getSiteSettingAsync(SPONSOR_KEY, options));',
    to: '  return await getSiteSettingAsync(SPONSOR_KEY, options);',
    expect: "getSponsorConfigAsync",
  },
  {
    name: "configured 永遠 false（後台會顯示未設定）",
    file: ADMSET_SRC,
    from: '    configured: Boolean(smtp.host && (smtp.from || smtp.user)),',
    to: '    configured: false,',
    expect: "configured",
  },
  {
    name: "saveAdminSponsorSettings 不寫入（存了等於沒存）",
    file: ADMSET_SRC,
    from: '  await setSiteSettingAsync(SPONSOR_KEY, next, options);\n',
    to: '',
    expect: "落地的 key/value",
  },
  // 刻意**沒有**「非 postgres 不回退」這一條：實測它是**等價變異**。
  // 這些 wrapper 的 `if (!isPg(options)) return sync()` 是**防禦性**的——
  // 它們委派的 `getSiteSettingAsync()`／`setSiteSettingAsync()` 自己就會判斷 driver 並回退，
  // 所以把 wrapper 的 guard 拿掉，行為完全不變（`driver:"sqlite"` 時仍然讀磁碟）。
  // 回退**行為**本身有測試（第 10 項，兩邊刻意種不同的值），只是殺不掉這個冗餘的 guard。
  // 保留 guard 是為了與其他島嶼的形狀一致；留一條永遠 SURVIVED 的變異只會稀釋報告。
  {
    // 第五十五批：設定進 PG，但**本機落地不能省**（auth.env 是節點啟動時套用的檔案，
    // 而本機的同步讀者 getStoredSmtp()/getMailTemplates() 還在）。
    name: "郵件設定只寫 PG、不做本機落地（auth.env 與同步讀者看不到）",
    file: "v3/src/adminSettingsAsync.js",
    from: "    applyAdminMailSettingsLocally({ smtp, templates });",
    to: "    void applyAdminMailSettingsLocally;",
    expect: "saveAdminMailSettingsAsync：PG 落地",
  },
  {
    name: "郵件設定只寫 smtp、不寫 mailTemplates",
    file: "v3/src/adminSettingsAsync.js",
    from: "  await setSiteSettingAsync(MAIL_TEMPLATES_KEY, templates, options);",
    to: "  void templates;",
    expect: "saveAdminMailSettingsAsync：PG 落地",
  },
  {
    // 把「公開形狀」寫進 store：密碼／secret 會消失（後台看起來存好了，實際上寄不出去）。
    name: "郵件設定把公開形狀寫進 PG（掉了密碼）",
    file: "v3/src/adminSettingsAsync.js",
    from: "  await setSiteSettingAsync(SMTP_KEY, smtp, options);",
    to: "  await setSiteSettingAsync(SMTP_KEY, publicSmtp(smtp), options);",
    expect: "saveAdminMailSettingsAsync：PG 落地",
  },
  {
    name: "OAuth 設定只寫 PG、不做本機落地",
    file: "v3/src/adminSettingsAsync.js",
    from: "    applyAdminOauthSettingsLocally(oauth);",
    to: "    void applyAdminOauthSettingsLocally;",
    expect: "saveAdminOauthSettingsAsync：PG 落地",
  },

];

const MAP_SRC = "v3/scripts/route-data-map.mjs";

// 進度量尺的變異集（v3/test/route-data-map.test.js）。
// 這一組要證明的是「每個缺陷真的被鎖住了」——把修正還原，對應的路由就必須被判錯。
//
// ⚠️ 2026-09-27：舊的 `expect` 值**整批換過**，因為它們指向的路由已經移植掉了
// （`/api/support/public` 變 PG），拿「還沒移植」當殺手的變異會變成永遠殺不掉。
// 現在一律改挑「**這個缺陷本身才會造成的可觀察差異**」，與該路由是否已移植無關。
const MAP_MUTATIONS = [
  {
    // 缺陷 (9)：字串裡的名字不是引用（`res.setHeader("Server-Timing", `… stats;dur=…`)`）。
    name: "還原缺陷 (9)：字串裡的函式名被當成引用",
    file: "v3/scripts/route-data-map.mjs",
    from: '  .replace(/`(?:[^`\\\\]|\\\\.)*`/g, "``");',
    to: '  .replace(/__never__/g, "`");',
    expect: "缺陷 (1)(2)(7)(8)(9) 的守衛（合成來源樹）",
  },
  {
    // 缺陷 (8)：driver-aware wrapper 把 driver 判斷放在**同模組 helper** 裡
    //（`write(options, pg, () => syncFallback())`）⇒ 舊尺規把 fallback 算成 SQLite 卡點。
    name: "還原缺陷 (8)：driver-aware 委派的同步 fallback 被算成 SQLite 卡點",
    file: "v3/scripts/route-data-map.mjs",
    from: "    if (delegated.size && onlyInsideDriverCalls(body, local, delegated)) continue;",
    to: "    if (false) continue;",
    expect: "缺陷 (1)(2)(7)(8)(9) 的守衛（合成來源樹）",
  },
  {
    name: "還原缺陷 (1)：函式本文切到下一個 function 宣告（會吞掉整段路由）",
    file: MAP_SRC,
    from: "  for (const hit of text.matchAll(re)) fns.set(hit[1], sliceFunctionBody(text, hit.index));",
    to: "  const hits = [...text.matchAll(re)];\n  for (let i = 0; i < hits.length; i += 1) fns.set(hits[i][1], text.slice(hits[i].index, i + 1 < hits.length ? hits[i + 1].index : text.length));",
    // 殺手刻意挑**被污染到的路由**，不是污染源自己：實測缺陷 (1) 對 `/api/demo`
    // 完全沒有影響（它的本文本來就在被吞的範圍裡），但 `/api/support/public`
    // 會從 `PG / sqlite=[]` 變成 `MIXED / sqlite=132 個`。
    expect: "/api/support/public",

  },
  {
    name: "還原缺陷 (1) 的錯誤修法：從簽名後第一個 { 起算（被 destructured default 截斷）",
    file: MAP_SRC,
    from: `  let i = text.indexOf("(", start);
  if (i === -1) return text.slice(start);
  let parenDepth = 0;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "\u0060") { i = skipString(text, i) - 1; continue; }
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { i += 1; break; }
    }
  }
  const open = text.indexOf("{", i);`,
    to: `  let i = start;
  const open = text.indexOf("{", i);`,
    // ⚠️ 這條變異的殺手換過三次：舊斷言拿「當時還沒移植的 /api/admin/members」當真值，
    // 第五十四批把它搬上 PG 之後就失效了。現在由**合成來源樹**守衛負責（它自己造一個
    // 簽名含 destructured default 的 helper，套回缺陷 (1) 之後必須看不到）。
    expect: "缺陷 (1)(2)(7)(8)(9) 的守衛（合成來源樹）",
  },
  {
    // 缺陷 (7)：方法呼叫不是函式呼叫。舊版 `callsIn()` 用 `\bname\s*\(`，
    // 會把 `store().saveSiteBudget()` 當成呼叫了 budgetGuard.js 的同名同步函式
    // ⇒ `PUT /api/admin/providers/site-budget` 明明已經 driver-aware，卻永遠留在缺口裡。
    name: "還原缺陷 (7)：方法呼叫也算成函式呼叫（同名方法造成假陽性）",
    file: MAP_SRC,
    from: "const callsIn = (body, name) => {\n  const escaped = name.replace(/\\$/g, \"\\\\$\");",
    to: "const callsIn = (body, name) => {\n  const escaped = name.replace(/\\$/g, \"\\\\$\");\n  if (true) return new RegExp(`\\\\b${escaped}\\\\s*\\\\(`).test(body);",
    expect: "缺陷 (1)(2)(7)(8)(9) 的守衛（合成來源樹）",
  },
  {
    name: "還原缺陷 (2)：sqlite 歸屬只看 db.js（吃 handle 參數的 helper 隱形）",
    file: MAP_SRC,
    from: "    if (sqliteNodes.has(nodeKey(target.to, target.orig))) sqlite.add(target.orig);",
    to: "    if (target.to === \"db.js\" && touches.has(target.orig)) sqlite.add(target.orig);",
    // 這一條的歷史殺手就是「被低估的那一批」：`listCampaignsAdmin` 住在 comms.js、
    // 接收 handle 參數，所以限制成「只認 db.js」時它一定會消失。
    // ⚠️ 曾經想改指 `/api/media` 的 `listMemberMedia`，實測**殺不死**——`/api/media` 是
    // 經 db.js 的 `listMemberMediaFor()` 進去的，仍然算得到，所以那個標的沒有鑑別力。
    expect: "缺陷 (1)(2)(7)(8)(9) 的守衛（合成來源樹）",
  },
  {
    name: "剝註解改回 regexp 版（不辨識正規表達式 ⇒ 本文被截斷、純函式被誤判成 SQLite）",
    file: MAP_SRC,
    from: 'function stripComments(text) {\n  let out = "";',
    to: 'function stripComments(text) {\n  return text.replace(/\\/\\*[\\s\\S]*?\\*\\//g, " ").replace(/(^|[^:])\\/\\/[^\\n]*/g, "$1");\n  let out = "";',
    expect: "normalizeLineUrl",
  },
  {
    name: "還原缺陷 (6)：傳參考的函式／中介層看不到（只認 `name(`）",
    file: MAP_SRC,
    from: "    if (!mentionsIn(body, local)) continue;",
    to: "    if (!callsIn(body, local)) continue;",
    // 這一個變異同時會殺掉「傳參考的中介層」那一條（requireAdminApi 也是 import），
    // 取比較具體的「傳參考的函式」當指名殺手。
    expect: "傳參考的函式必須被看見",
  },
  {
    name: "還原缺陷 (6) 的物件鍵誤判：`stats:` 被當成 db.js 的 stats()",
    file: MAP_SRC,
    from: "  if (!new RegExp(`(?<![\\\\w$.])${n}(?![\\\\w$])(?!\\\\s*:)`).test(stripStrings(body))) return false;",
    to: "  if (!new RegExp(`(?<![\\\\w$.])${n}(?![\\\\w$])`).test(stripStrings(body))) return false;",
    // reject-match 的 `res.json({ stats: await listingStatsAsync(…) })` 會把 db.js 的
    // `stats()` 整條鏈拉進來（countWatched／loadFlagMap／sqlExcludeFixtureRows…）。
    expect: "已完全移植的路由必須是 PG",
  },
  {
    name: "session 已由 PG 解析這條規則失效（把掛載點判成在路由之後）",
    file: MAP_SRC,
    from: "const sessionResolvedByPg = sessionMountIndex !== -1\n  && (firstRouteIndex === -1 || sessionMountIndex < firstRouteIndex);",
    to: "const sessionResolvedByPg = sessionMountIndex !== -1\n  && (firstRouteIndex === -1 || sessionMountIndex > firstRouteIndex);",
    // 這一條測的是「那個掛載點真的被檢查了」：條件一反轉，readSession 就回到 SQLite，
    // findUserByEmail 立刻回來。把 `app.use(resolveSession())` 真的移走也會有一樣的效果。
    expect: "session 改由 PG 解析",
  },
  // 刻意**沒有**「接收者改成萬用字元」這一條：實測它是**等價變異**。
  // 改成 `\w+\.(prepare|exec|…)` 確實多算了 52 個命中（1178 vs 1126，全是 re.exec() 之類），
  // 但 288 條的判定**完全沒變**（189/47/26/26）——那些 parser 函式從路由不可達。
  // 所以白名單是**防禦性**的（保護 sqliteNodes 的正確性），不是靠測試守住的；
  // 留一條永遠 SURVIVED 的變異只會讓報告失去意義。
  //
  // 也刻意**沒有**「還原循環處理（resolving 回空集合）」這一條：實測在**現有輸入**下
  // 是等價變異（舊版 5 輪也會收斂到同一組判定，0 條差異）。循環修正是**穩健性**修正
  // ——它保證「加邊只會增加、不會減少」（拿掉之後，加一條邊曾讓 4 條路由的 sqlite
  // 集合反而變小）——但沒有可重跑的失敗可以指名，所以不假裝它被測試守住。
];

// geo_cache（地理編碼快取）PG 分支的變異集（v3/test/geo-cache-async.test.js，第六十四批）。
const GEOCACHE_SRC = "v3/src/geoCacheAsync.js";
const GEOCACHE_MUTATIONS = [
  {
    name: "快取讀取不查 PG（永遠當成沒命中，每次都要重新地理編碼）",
    file: GEOCACHE_SRC,
    from: "        const rows = rowsOf(await exec(sql, [key]));\n        return rows[0] || null;",
    to: "        return null;",
    expect: "讀取：正規化過的變體會命中同一列",
  },
  {
    name: "讀取鍵不經 addressVersion（正規化過的地址查不到同一列）",
    file: GEOCACHE_SRC,
    from: "  const key = addressVersion(address);\n  if (!key) return null;",
    to: '  const key = String(address || "");\n  if (!key) return null;',
    expect: "讀取：正規化過的變體會命中同一列",
  },
  {
    name: "落地值不經共用的純函式（meta 推導全部丟掉）",
    file: GEOCACHE_SRC,
    from: "  const row = geoCacheRow(address, lat, lng, meta, options.now || new Date());",
    to: "  const row = geoCacheRow(address, lat, lng, {}, options.now || new Date());",
    expect: "寫入：落地值與同步版逐欄相同",
  },
  {
    name: "座標不是有限數時仍然落地（快取寫進 NaN）",
    file: "v3/src/geoQueue.js",
    from: "  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;",
    to: "  if (!key) return null;",
    expect: "沒有可用的鍵或座標不是有限數",
  },
  {
    name: "PG 建表時不補那九個額外欄位（新庫少欄位）",
    file: GEOCACHE_SRC,
    from: "    for (const column of GEO_CACHE_EXTRA_COLUMNS) {",
    to: "    for (const column of []) {",
    expect: "ensureGeoCacheOnce",
  },
  {
    // ⚠️ 原本寫成「`tables: []`」是**等價變異**：`ensurePgSchema()` 的 `tables: []` 代表
    // 「鏡射全部表」，geo_cache 照樣被建出來（實測 SURVIVED）。要驗的是「乾脆不建表」。
    name: "PG 不建 geo_cache（只補欄位，新庫直接 42P01）",
    file: GEOCACHE_SRC,
    from: '    await ensurePgSchema(pgDriver, sqlite, { tables: ["geo_cache"], indexes: false });\n',
    to: "",
    expect: "ensureGeoCacheOnce",
  },
  {
    name: "讀取不往下一層 fallback（舊庫少欄位就整個讀不到）",
    file: GEOCACHE_SRC,
    from: "        if (!isMissingRelation(error)) throw error;\n      }\n    }\n    return null;",
    to: "        throw error;\n      }\n    }\n    return null;",
    expect: "舊形狀的表",
  },
  {
    name: "寫入不往最小語句 fallback（舊庫少欄位就寫不進去）",
    file: GEOCACHE_SRC,
    from: "      if (!isMissingRelation(error)) throw error;\n      await exec(GEO_CACHE_UPSERT_MINIMAL_SQL, [row.address, row.lat, row.lng, row.updated_at]);",
    to: "      throw error;\n      await exec(GEO_CACHE_UPSERT_MINIMAL_SQL, [row.address, row.lat, row.lng, row.updated_at]);",
    expect: "舊形狀的表",
  },
  {
    name: "geocodeAddress 的 lookup 回到同步呼叫（非同步快取永遠當成命中 Promise）",
    file: "v3/src/geo.js",
    from: "  const cached = await firstCachedGeo(lookup, [address, text, houseKey, streetKey]);",
    to: "  const cached = lookup?.(address) || lookup?.(text) || (houseKey && lookup?.(houseKey)) || (streetKey && lookup?.(streetKey));",
    expect: "非同步的 lookup 也要命中快取",
  },
  {
    name: "候選鍵不 await（非同步 lookup 一律 miss）",
    file: "v3/src/geo.js",
    from: "    const hit = await lookup(key);",
    to: "    const hit = lookup(key);",
    // 殺手是「候選鍵的順序」那一條：`firstCachedGeo()` 是 async，回傳的 Promise 會被外層
    // `await` 解掉，所以單一鍵的命中測試**不會**紅；但候選鍵 miss 時 `if (hit)`（Promise 恆真）
    // 會提早結束整條鏈 ⇒ 路段鍵永遠問不到。
    expect: "候選鍵的順序不變",
  },
  {
    name: "boxFromRoadDescription 不 await lookup（非同步快取查不到路名）",
    file: "v3/src/geo.js",
    from: "    const cached = (await options.lookup?.(road)) || (await options.lookup?.(geoKey(road)));",
    to: "    const cached = options.lookup?.(road) || options.lookup?.(geoKey(road));",
    expect: "boxFromRoadDescription",
  },
  {
    name: "boxFromRoadDescription 不 await save（新座標還沒落地就回傳）",
    file: "v3/src/geo.js",
    from: "      await options.save?.(road, geo.lat, geo.lng);",
    to: "      options.save?.(road, geo.lat, geo.lng);",
    expect: "boxFromRoadDescription",
  },
];

// 爬蟲的 listings 狀態寫入（v3/test/listing-state-writes.test.js，第六十七／六十八批）。
const CRAWLER_WRITES_SRC = "v3/src/crawlerWrites.js";
const STATEWRITE_MUTATIONS = [
  {
    name: "逾期下線掃描不看 RETURNING 的列數（永遠回報 0）",
    file: CRAWLER_WRITES_SRC,
    from: "    async (exec) => (await exec(`${EXPIRED_OFFLINE_SQL} RETURNING 1`, [stamp, cutoff])).length,",
    to: "    async (exec) => { await exec(`${EXPIRED_OFFLINE_SQL} RETURNING 1`, [stamp, cutoff]); return 0; },",
    expect: "逾期下線掃描：PG 分支改的列數",
  },
  {
    name: "逾期下線掃描不節流（每個請求都掃一次）",
    file: CRAWLER_WRITES_SRC,
    from: "  if (at - lastExpiredOfflineSweepAt < EXPIRED_OFFLINE_SWEEP_MS) return 0;\n",
    to: "",
    expect: "60 秒內第二次不重掃",
  },
  {
    name: "geo 落點只寫快取、不改 listings（回填的座標站上看不到）",
    file: CRAWLER_WRITES_SRC,
    from: "    const rows = await selectGeoRows(exec, key);\n    let updated = 0;",
    to: "    const rows = [];\n    let updated = 0;",
    expect: "geo 回填落點",
  },
  {
    name: "geo 落點不寫快取（每次回填都要重新地理編碼）",
    file: CRAWLER_WRITES_SRC,
    from: "  await setCachedGeoAsync(address, lat, lng, meta, options);\n",
    to: "",
    expect: "geo 回填落點",
  },
  {
    name: "geo 落點不驗座標（NaN 也照寫）",
    file: CRAWLER_WRITES_SRC,
    from: "  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return 0;\n  // 快取先寫（走第六十四批的 geo_cache 島嶼；PG 模式寫 PG）。",
    to: "  if (!key) return 0;\n  // 快取先寫（走第六十四批的 geo_cache 島嶼；PG 模式寫 PG）。",
    expect: "geo 回填落點",
  },
];

// 管理員「同房源重掃」PG 版（v3/test/admin-same-house-async.test.js，第六十九批）。
const SAMEHOUSE_SRC = "v3/src/sameHouseAsync.js";
const SAMEBACKFILL_MUTATIONS = [
  {
    name: "重掃不讀 PG 的游標（每次都從 0 開始重掃）",
    file: SAMEHOUSE_SRC,
    from: '  const startCursor = cursor == null ? Number((await readSetting(BACKFILL_SETTING_KEY)) || 0) : Number(cursor) || 0;',
    to: "  const startCursor = Number(cursor) || 0;",
    expect: "重掃：PG 分支的摘要",
  },
  {
    name: "重掃不寫回游標（永遠掃同一批）",
    file: SAMEHOUSE_SRC,
    from: "  await writeSetting(BACKFILL_SETTING_KEY, String(nextCursor));\n",
    to: "",
    expect: "重掃：PG 分支的摘要",
  },
  {
    name: "重掃逐列失敗不吞（單列錯誤讓整個批次 500）",
    file: SAMEHOUSE_SRC,
    from: "    } catch (error) {\n      results.push({ post_id: row.post_id, error: error.message });\n    }",
    to: "    } catch (error) {\n      throw error;\n    }",
    // 殺手是「單列失敗要吞掉」那條：摘要那條沒有失敗的列，走不到這個 catch。
    expect: "單列失敗要吞掉",
  },
  {
    name: "重掃不寫狀態鍵（後台列表永遠是舊的）",
    file: SAMEHOUSE_SRC,
    from: '  await writeSetting(BACKFILL_STATUS_KEY, JSON.stringify({',
    to: '  await writeSetting("sameHouseBackfillStatusDisabled", JSON.stringify({',
    expect: "重掃：PG 分支的摘要",
  },
];

// 通知佇列的事件清單（v3/test/notify-queue-parity.test.js，第七十二批）。
const NOTIFYQ_SRC = "v3/src/notifyQueueAsync.js";
const NOTIFYQ_MUTATIONS = [
  {
    name: "事件清單改讀本機（PG 站看不到自己的通知事件）",
    file: NOTIFYQ_SRC,
    from: "  return withFallback(options, async (exec) => {\n    const rows = await exec(RECENT_EVENTS_SQL, [uid, cap]);",
    to: "  return withFallback({ ...options, driver: \"sqlite\" }, async (exec) => {\n    const rows = await exec(RECENT_EVENTS_SQL, [uid, cap]);",
    expect: "PG 分支讀的是 PG 的 user_events",
  },
  {
    name: "事件清單的參數順序顛倒（limit 當 uid）",
    file: NOTIFYQ_SRC,
    from: "    const rows = await exec(RECENT_EVENTS_SQL, [uid, cap]);",
    to: "    const rows = await exec(RECENT_EVENTS_SQL, [cap, uid]);",
    expect: "PG 分支讀的是 PG 的 user_events",
  },
  {
    name: "GET /api/state 的事件清單改回同步版",
    file: "v3/src/server.js",
    from: "    events = await recentEventsAsync(uid, 30);",
    to: "    events = recentEvents(uid, 30);",
    expect: "/api/state 的事件清單走 PG 島嶼",
  },
];

// 「清除物件紀錄／清除全部資料」的 PG 島嶼（v3/test/site-reset-async.test.js，第七十三批）。
const SITERESET_SRC = "v3/src/siteResetAsync.js";
const SITERESET_MUTATIONS = [
  {
    name: "清除只寫本機（PG 站按了卻什麼都沒清）",
    file: SITERESET_SRC,
    from: "  if (!isPg(options)) {\n    const sync = await import(\"./db.js\");\n    return sync[syncName]();\n  }",
    to: "  if (true) {\n    const sync = await import(\"./db.js\");\n    return sync[syncName]();\n  }",
    expect: "PG 分支刪的是 PG 的表",
  },
  {
    name: "清除全部資料漏刪 user_settings（別的會員設定留著）",
    file: "v3/src/db.js",
    from: '  "DELETE FROM user_settings",\n',
    to: "",
    expect: "清除全部資料",
  },
  {
    name: "清除之後不寫回設定補丁（hasBaseline 沒重設）",
    file: SITERESET_SRC,
    from: "    return await saveSettingsAsync({ ...settingsPatch }, uid, { forceAdmin: true, ...options });",
    to: "    void saveSettingsAsync; void uid; void settingsPatch; return {};",
    expect: "清除物件紀錄",
  },
  {
    name: "清除物件紀錄改回同步版（路由仍寫本機）",
    file: "v3/src/server.js",
    from: "  const settings = await resetListingsAsync();",
    to: "  const settings = resetListings();",
    expect: "兩條路由都用 PG 島嶼",
  },
];

// 通知 flush 迴圈的逐會員讀取（v3/test/notify-flush-settings.test.js，第七十四批）。
const NOTIFYFLUSH_SRC = "v3/src/watcher.js";
const NOTIFYFLUSH_MUTATIONS = [
  {
    name: "flush 的逐會員設定改讀本機（暫停通知的會員照樣被通知）",
    file: NOTIFYFLUSH_SRC,
    from: "    const userSettings = userId ? await getSettingsAsync(userId, options) : settings;",
    to: "    const userSettings = userId ? getSettings(userId) : settings;",
    expect: "暫停旗標以 PG 為準",
  },
  {
    name: "flush 的信箱改讀本機（寄到舊的／空的信箱）",
    file: NOTIFYFLUSH_SRC,
    from: '    const mailTo = String((await getUserByIdAsync(userId, options))?.email || "").trim();',
    to: '    const mailTo = String(getUserById(userId)?.email || "").trim();',
    // 殺手是原始碼接線那條（信箱本身在 silent 模式不會真的使用，所以行為面看不到差異）。
    expect: "不得再用同步的",
  },
  {
    name: "flush 不把 options 轉發給佇列（測試／探針注入無效）",
    file: NOTIFYFLUSH_SRC,
    from: "  const pending = await pendingNotifyEventsAsync({ limit: 400 }, options);",
    to: "  const pending = await pendingNotifyEventsAsync({ limit: 400 });",
    expect: "讀注入的 PG runner",
  },
  {
    name: "flush 的站台設定改讀本機（整個迴圈用別台節點的設定決定通知）",
    file: NOTIFYFLUSH_SRC,
    // ⚠️ 第七十七批起 watcher 有三處 worker 預設參數也是這一行 ⇒ 錨點要連下一行才唯一
    // （`v3/test/mutation-anchors.test.js` 會檢查每個錨點恰好出現一次）。
    from: "  settings = settings || await getSettingsAsync(0, options);\n  await bindNotifyJobSnapshotsFor(options);",
    to: "  settings = settings || getSettings();\n  await bindNotifyJobSnapshotsFor(options);",
    // 同上：站台設定的讀取在離線夾具裡的差異由接線那條守住。
    expect: "不得再用同步的",
  },
];

// 註冊（帳號 ＋ 同意 ＋ 開通 token）的 PG 島嶼（v3/test/register-async.test.js，第七十五批）。
//
// ⚠️ 「帳號與同意紀錄包在同一個交易」那一條**只有原始碼斷言殺得掉**：注入式 exec 沒有交易，
// 離線夾具驗不出交易邊界（live PG 那邊也只能驗結果、驗不出邊界）。
const REGISTER_MUTATIONS = [
  {
    name: "新帳號的 INSERT 拿掉 RETURNING id（拿不到 id 就整條註冊掛掉）",
    file: "v3/src/usersAsync.js",
    from: "VALUES (?, ?, 'member', 'free', ?, ?, ?, 1, ?) RETURNING id`;",
    to: "VALUES (?, ?, 'member', 'free', ?, ?, ?, 1, ?)`;",
    expect: "新增帳號：落地欄位與同步版逐鍵相同",
  },
  {
    name: "`emailVerified: false` 被寫成已驗證（註冊完可以直接登入，繞過點信）",
    file: "v3/src/usersAsync.js",
    from: "  const verifiedFlag = emailVerified === false ? 0 : 1;",
    to: "  const verifiedFlag = 1;",
    expect: "新增帳號：落地欄位與同步版逐鍵相同",
  },
  {
    name: "未驗證帳號的重送條件放寬（已驗證的帳號也會被改密碼）",
    file: "v3/src/usersAsync.js",
    from: "    if (!isUserDeleted(existing) && Number(existing.email_verified) === 0 && emailVerified === false) {",
    to: "    if (!isUserDeleted(existing) && Number(existing.email_verified) === 0) {",
    expect: "未驗證帳號可重送",
  },
  {
    name: "已刪除兩次的上限放寬（第三次也能註冊）",
    file: "v3/src/usersAsync.js",
    from: "    if (signups >= 2) throw Object.assign(new Error(",
    to: "    if (signups > 2) throw Object.assign(new Error(",
    expect: "已刪除帳號：復活時 signup_count +1",
  },
  {
    name: "復活不累加 signup_count（兩次上限永遠不會到）",
    file: "v3/src/usersAsync.js",
    from: "[hashPassword(pass), stamp, DISCLAIMER_VERSION, signups + 1, verifiedFlag, id]",
    to: "[hashPassword(pass), stamp, DISCLAIMER_VERSION, signups, verifiedFlag, id]",
    expect: "已刪除帳號：復活時 signup_count +1",
  },
  {
    name: "復活不清 deleted_at（帳號復活了還是被當成刪除）",
    file: "v3/src/usersAsync.js",
    from: "signup_count = ?, deleted_at = NULL, deleted_by = '', deleted_reason = '', deleted_reason_code = '',",
    to: "signup_count = ?, deleted_by = '', deleted_reason = '', deleted_reason_code = '',",
    expect: "已刪除帳號：復活時 signup_count +1",
  },
  {
    name: "復活不把方案降回 free（延續刪除前的 sponsor）",
    file: "v3/src/usersAsync.js",
    from: "       SET password_hash = ?, plan = 'free', accepted_disclaimer_at = ?, disclaimer_version = ?,",
    to: "       SET password_hash = ?, accepted_disclaimer_at = ?, disclaimer_version = ?,",
    expect: "已刪除帳號：復活時 signup_count +1",
  },
  {
    name: "新帳號不寫個資戳記（profile_privacy_at 永遠是空的）",
    file: "v3/src/usersAsync.js",
    from: '  if (!id) throw new Error("註冊寫入沒有回傳 id");\n  await stampPrivacyAsync(exec, id, stamp);',
    to: '  if (!id) throw new Error("註冊寫入沒有回傳 id");',
    expect: "新增帳號：落地欄位與同步版逐鍵相同",
  },
  {
    name: "帳號與同意紀錄不在同一個交易（同意失敗時留下半個帳號）",
    file: "v3/src/usersAsync.js",
    from: "    return runInTransaction(options, async (tx) => {",
    to: "    return (async (tx) => {",
    // 注入式 exec 沒有交易 ⇒ 只有原始碼斷言殺得掉。
    expect: "交易版（含同意紀錄）",
  },
  {
    name: "同意紀錄不寫（帳號建了、同意欄全空）",
    file: "v3/src/usersAsync.js",
    from: "      const recorded = await recordRegistrationConsentsAsync(user.id, docs, { source, now, ...options, exec: tx });\n      void recorded;",
    to: "      const recorded = [];\n      void recorded;",
    expect: "交易版（含同意紀錄）",
  },
  {
    name: "不驗證送來的同意清單（版本過期也照收）",
    file: "v3/src/usersAsync.js",
    from: "    const docs = await assertRegistrationConsentsAsync(input?.consents, { now, ...options });",
    to: "    const docs = input?.consents || [];\n    void assertRegistrationConsentsAsync;",
    expect: "交易版（含同意紀錄）",
  },
  {
    name: "開通 token 只回傳不寫 PG（會員點信裡的連結是 404）",
    file: "v3/src/emailVerifyAsync.js",
    from: "    await exec(USER_ISSUE_VERIFY_SQL, [issued.token, issued.expiresAt, id]);",
    to: "    void exec;",
    expect: "開通 token：PG 版寫進 PG",
  },
  {
    name: "開通 token 不把 email_verified 歸零（重新開通後仍是已驗證）",
    file: "v3/src/emailVerifyAsync.js",
    from: '  "UPDATE users SET email_verified = 0, verify_token = ?, verify_expires_at = ?, verify_expire_notified = 0, verify_used_at = NULL WHERE id = ?";',
    to: '  "UPDATE users SET verify_token = ?, verify_expires_at = ?, verify_expire_notified = 0, verify_used_at = NULL WHERE id = ?";',
    expect: "開通 token：PG 版寫進 PG",
  },
  {
    name: "開通 token 的有效期不算 TTL（立刻過期）",
    file: "v3/src/emailVerify.js",
    from: '  return { token: randomBytes(24).toString("hex"), expiresAt: new Date(now + VERIFY_TTL_MS).toISOString() };',
    to: '  return { token: randomBytes(24).toString("hex"), expiresAt: new Date(now).toISOString() };',
    expect: "開通 token：PG 版寫進 PG",
  },
  {
    name: "開通 token 仍只寫本機（PG 模式的註冊照樣卡死）",
    file: "v3/src/emailVerifyAsync.js",
    from: "  if (!isPg(options)) return issueVerifyTokenSync(sqliteHandle(), id, { now });\n  const issued = newVerifyToken({ now });",
    to: "  if (true) return issueVerifyTokenSync(sqliteHandle(), id, { now });\n  const issued = newVerifyToken({ now });",
    expect: "開通 token：PG 版寫進 PG",
  },
  {
    name: "註冊路由改回同步的 registerUserWithConsents（只寫本機）",
    file: "v3/src/server.js",
    from: "    const user = await registerUserWithConsentsAsync({",
    to: "    const user = registerUserWithConsents({",
    expect: "路由接線",
  },
  {
    name: "註冊路由改回同步的 issueVerifyToken（token 寫本機）",
    file: "v3/src/server.js",
    // ⚠️ 錨點要帶下一行：第八十五批之後 OAuth callback 也有同一句（縮排不同、下一行不同），
    //    只寫那一句會變成 2 次 ⇒ 整套變異會靜靜中止（`mutation-anchors.test.js` 會抓）。
    from: "    const issued = await issueVerifyTokenAsync(user.id);\n    const base = publicBaseUrl(req);",
    to: "    const issued = issueVerifyToken(user.id);\n    const base = publicBaseUrl(req);",
    expect: "路由接線",
  },
  {
    name: "註冊路由的 SMTP 設定改讀本機（PG 站說沒設定、擋掉註冊）",
    file: "v3/src/server.js",
    // ⚠️ 同上：帶上「註冊確認信」那句錯誤訊息，才與 OAuth callback 的兩處區隔開。
    from: "    if (!mailConfigured(await getStoredSmtpAsync())) {\n      const err = new Error(\"尚未設定寄信，無法寄出註冊確認信。",
    to: "    if (!mailConfigured(getStoredSmtp())) {\n      const err = new Error(\"尚未設定寄信，無法寄出註冊確認信。",
    expect: "路由接線",
  },
];

// 通勤快照（`GET /api/commute/snapshot`）的 PG 島嶼（v3/test/commute-snapshot-async.test.js，第七十六批）。
const COMMUTE_MUTATIONS = [
  {
    name: "通勤快照改回同步版（PG 才有的刊登看不到通勤資訊）",
    file: "v3/src/server.js",
    from: "    listings: await listingCommutePatchesAsync(ids, uid, { settings }),",
    to: "    listings: ids.map((id) => listingCommutePatch(id, uid, settings)).filter(Boolean),",
    expect: "路由接線",
  },
  {
    name: "可見性關卡拿掉（Stage 1 夾具列會被畫到地圖上）",
    file: "v3/src/listingCommuteAsync.js",
    from: "      .filter((row) => row && listingVisibleOnSurface(row, { surface: LISTING_SURFACE.MAP, viewerId: uid }));",
    to: "      .filter((row) => Boolean(row));",
    expect: "可見性關卡與順序",
  },
  {
    name: "不套共用投影（少 20 個欄位、前端卡片空白）",
    file: "v3/src/listingCommuteAsync.js",
    from: "    const patchById = new Map(decorated.map((row) => [Number(row.post_id), commutePatchFields(row, settings)]));",
    to: "    const patchById = new Map(decorated.map((row) => [Number(row.post_id), row]));",
    expect: "逐欄位相同",
  },
  {
    name: "投影少掉 fingerprint（前端不會發現設定變了）",
    file: "v3/src/db.js",
    from: "    mrt_walk_km: lite.mrt_walk_km,\n    fingerprint: commuteSettingsFingerprint(settings),",
    to: "    mrt_walk_km: lite.mrt_walk_km,",
    expect: "逐欄位相同",
  },
  {
    name: "同步版不再套投影（兩個 driver 的形狀分岔）",
    file: "v3/src/db.js",
    from: "  const lite = decorateListing(withPersonal(row, uid), settings, uid, { sameHouse: false });\n  return commutePatchFields(lite, settings);",
    to: "  const lite = decorateListing(withPersonal(row, uid), settings, uid, { sameHouse: false });\n  return lite;",
    expect: "逐欄位相同",
  },
  {
    name: "缺 settings 時靜默回退（PG 版會用本機設定算通勤）",
    file: "v3/src/listingCommuteAsync.js",
    from: '    if (!settings) throw new Error("PG 版通勤快照需要 settings（不得回退本機設定）");',
    to: "    if (!settings) return fallback();",
    expect: "fail-closed",
  },
  {
    name: "PG 失敗時無條件回退本機（寫入以外的讀取也不該假裝成功）",
    file: "v3/src/listingCommuteAsync.js",
    from: "    if (!sqliteFallbackAllowed(options, {})) throw error;\n    return fallback();",
    to: "    return fallback();",
    expect: "fail-closed",
  },
  {
    name: "預設帳號改讀本機（userId 為 null 時用本機 id 認人）",
    file: "v3/src/listingCommuteAsync.js",
    from: "    const uid = userId == null ? await defaultUserIdAsync(options) : Number(userId) || 0;",
    to: '    const uid = userId == null ? (await import("./db.js")).defaultUserId() : Number(userId) || 0;',
    expect: "userId: null",
  },
];

// 路線快取／路線工作／全會員通勤設定／推播送出（v3/test/route-cache-async.test.js，第七十七批）。
//
// ⚠️ 「worker 有沒有接上島嶼」那一條只有**原始碼接線**殺得掉（離線夾具跑不動整個補路線 worker：
// 它會打外部路徑服務）。
const ROUTECACHE_MUTATIONS = [
  {
    name: "路線寫入改成 fail-open（PG 壞掉時偷偷改寫本機）",
    file: "v3/src/routeCacheAsync.js",
    from: "  }, () => {\n    setCachedRouteSync(fromLat, fromLng, toLat, toLng, distances, rush, mode, direction);\n    return { ok: true, route_key: plan.key };\n  }, { write: true });",
    to: "  }, () => {\n    setCachedRouteSync(fromLat, fromLng, toLat, toLng, distances, rush, mode, direction);\n    return { ok: true, route_key: plan.key };\n  }, { write: false });",
    expect: "寫入是 fail-closed",
  },
  {
    name: "路線根本沒寫進 PG（卡片路徑永遠算不出通勤）",
    file: "v3/src/routeCacheAsync.js",
    from: "    await exec(plan.sql, plan.params);",
    to: "    void plan;",
    expect: "route_cache：PG 版落地與同步版逐欄位相同",
  },
  {
    name: "尖峰時段的欄位不寫（rush 資料在兩個 driver 分岔）",
    file: "v3/src/db.js",
    from: "  const hasRush = Number.isFinite(rushAm) && Number.isFinite(rushPm);\n  const stamp = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();",
    to: "  const hasRush = false;\n  const stamp = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();",
    expect: "route_cache：PG 版落地與同步版逐欄位相同",
  },
  {
    // ⚠️ 第一版寫「把 mode 換成空字串」→ **等價突變**：`normalizeCommuteMode("")` 會回預設的
    // `scooter`，鍵一模一樣（實測 SURVIVED）。改成動座標（鍵裡真的有它）才有鑑別力。
    name: "job_key 的座標算錯（同一筆會有兩列工作）",
    file: "v3/src/db.js",
    from: "  const jobKey = partial.job_key || makeRouteJobKey(postId, direction, kind, mode, workLat, workLng);",
    to: "  const jobKey = partial.job_key || makeRouteJobKey(postId, direction, kind, mode, workLat, 0);",
    expect: "route_jobs：upsert 的更新語意",
  },
  {
    name: "route_jobs 沒寫進 PG（狀態留在本機、別台節點重複抓）",
    file: "v3/src/routeCacheAsync.js",
    from: "    await exec(ROUTE_JOB_UPSERT_SQL, params);",
    to: "    void params;",
    expect: "route_jobs：upsert 的更新語意",
  },
  {
    name: "markRouteJob 把 attempts 歸零（重試次數永遠是 0）",
    file: "v3/src/routeCacheAsync.js",
    from: "    attempts: Number(prev?.attempts) || 0,\n    ...patch,",
    to: "    attempts: 0,\n    ...patch,",
    expect: "route_jobs：upsert 的更新語意",
  },
  {
    name: "finishRouteAttempt 不累加 attempts（退避重試永遠不會啟動）",
    file: "v3/src/routeCacheAsync.js",
    from: "  const attempts = (Number(prev?.attempts) || 0) + 1;",
    to: "  const attempts = 1;",
    expect: "route_jobs：upsert 的更新語意",
  },
  {
    name: "尖峰時段開關改讀本機（別台節點開的功能等於沒開）",
    file: "v3/src/settingsAsync.js",
    from: "  if ((options.driver || resolveDbDriver()) !== \"postgres\") return commuteRushEnabledSync();",
    to: "  if (true) return commuteRushEnabledSync();",
    expect: "commuteRushEnabled",
  },
  {
    name: "全會員通勤設定改讀本機（PG 才有的會員被漏掉）",
    file: "v3/src/settingsAsync.js",
    from: "  if ((options.driver || resolveDbDriver()) !== \"postgres\") return collectCommuteSettingsSync();",
    to: "  if (true) return collectCommuteSettingsSync();",
    expect: "全會員通勤設定",
  },
  {
    name: "settingsForGeoBackfill 不找 PG 的會員（永遠挑不到需要補的人）",
    file: "v3/src/settingsAsync.js",
    from: "  for (const settings of await collectCommuteSettingsAsync(options)) {\n    if (needsListingGeo(settings)) return settings;\n  }",
    to: "  void needsListingGeo;",
    expect: "全會員通勤設定",
  },
  {
    name: "推播送出改讀本機（別台節點的訂閱收不到通知）",
    file: "v3/src/webPushAsync.js",
    from: "  if (!isPg(options)) {\n    const { sendUserWebPush } = await import(\"./db.js\");",
    to: "  if (true) {\n    const { sendUserWebPush } = await import(\"./db.js\");",
    expect: "推播送出：讀的是 PG 的訂閱",
  },
  {
    name: "補路線 worker 不寫路線快取（整條通勤補齊失效）",
    file: "v3/src/watcher.js",
    from: "  await setCachedRouteAsync(lat, lng, workLat, workLng, distances, null, mode, \"to_work\", options);",
    to: "  void distances;",
    expect: "worker 接線",
  },
  {
    name: "補路線 worker 改回同步的推播（PG 模式的推播全漏）",
    file: "v3/src/watcher.js",
    from: "        await sendUserWebPushAsync(userId, pushPayloadFromEvents(push), options);",
    to: "        void push; void userId;",
    expect: "worker 接線",
  },
  {
    name: "通知廣播改回同步的 stats()（推給瀏覽器的是本機統計）",
    file: "v3/src/server.js",
    from: "    broadcast({ type: \"notify\", events: list, stats: await safeStats(userId) }, userId);",
    to: "    broadcast({ type: \"notify\", events: list, stats: stats(undefined, userId) }, userId);",
    expect: "worker 接線",
  },
];

// 後台地圖開關 ＋ 訪客示範（v3/test/admin-maps-demo-async.test.js，第七十八批）。
const MAPSDEMO_MUTATIONS = [
  {
    name: "後台開關改回同步版（只有按下去的那一台生效）",
    file: "v3/src/adminSettingsAsync.js",
    from: "  if (!isPg(options)) return saveAdminMapsSettingsSync(partial);",
    to: "  if (true) return saveAdminMapsSettingsSync(partial);",
    expect: "後台地圖開關：PG 版寫進 PG",
  },
  {
    name: "clearKey 不清 PG 的兩個開關（別台節點照樣打 Google）",
    file: "v3/src/adminSettingsAsync.js",
    from: "    await setSiteSettingAsync(GOOGLE_DIRECTIONS_KEY, false, options);\n    await setSiteSettingAsync(COMMUTE_RUSH_KEY, false, options);",
    to: "    void options;",
    expect: "後台地圖開關：PG 版寫進 PG",
  },
  {
    name: "Google 開關不寫 PG（後台按了沒用）",
    file: "v3/src/adminSettingsAsync.js",
    from: "    await setSiteSettingAsync(GOOGLE_DIRECTIONS_KEY, Boolean(src.googleEnabled), options);",
    to: "    void src.googleEnabled;",
    expect: "後台地圖開關：PG 版寫進 PG",
  },
  {
    name: "尖峰開關不寫 PG（別台節點照樣算尖峰路線）",
    file: "v3/src/adminSettingsAsync.js",
    from: "    await setSiteSettingAsync(COMMUTE_RUSH_KEY, Boolean(src.enabled), options);",
    to: "    void src.enabled;",
    expect: "後台地圖開關：PG 版寫進 PG",
  },
  {
    name: "會員清單改回同步版（PG 才有的會員看不到）",
    file: "v3/src/usersAsync.js",
    from: "  if ((options.driver || resolveDbDriver()) !== \"postgres\") return listUserIdsSync(sqliteHandle());",
    to: "  if (true) return listUserIdsSync(sqliteHandle());",
    expect: "listUserIds",
  },
  {
    name: "示範來源會員的挑選順序反了（先挑只有行政區的）",
    file: "v3/src/demo.js",
    from: "    if (Number(settings.commuteKm) > 0 && hasWorkPoint(settings) && (settings.watchDistricts || []).length) {\n      return id;\n    }",
    to: "    if ((settings.watchDistricts || []).length) {\n      return id;\n    }",
    expect: "示範來源會員",
  },
  {
    name: "示範來源會員不檢查工作點（沒有工作點的人也被當成示範來源）",
    file: "v3/src/demo.js",
    from: "    if (Number(settings.commuteKm) > 0 && hasWorkPoint(settings) && (settings.watchDistricts || []).length) {",
    to: "    if (Number(settings.commuteKm) > 0 && (settings.watchDistricts || []).length) {",
    expect: "示範來源會員",
  },
  {
    name: "第二輪挑選不看行政區（沒有追蹤的人也被挑中）",
    file: "v3/src/demo.js",
    from: "    const row = await settingsOf(id);\n      if ((row.watchDistricts || []).length) { uid = id; break; }",
    to: "    void settingsOf;\n      { uid = id; break; }",
    // 殺手是「訪客示範」那條（單會員情境下同步版會挑到預設帳號、PG 版挑到該會員 ⇒ 輸出不同）；
    // 純決策那條的案例裡第二輪一定挑得到人，所以不會紅（實測）。
    expect: "訪客示範",
  },
  {
    name: "訪客示範不問預設帳號（挑不到人時 uid 是 0）",
    file: "v3/src/demo.js",
    from: "  if (!uid) uid = await defaultUserIdAsync(options);",
    to: "  if (!uid) uid = 0;",
    expect: "訪客示範",
  },
  {
    name: "訪客示範的行政區不帶（示範只顯示全部）",
    file: "v3/src/demo.js",
    from: "    districts: demoDistrictNames(source),",
    to: "    districts: [],",
    expect: "訪客示範",
  },
  {
    name: "訪客示範的 matched 不算（前端統計對不上清單）",
    file: "v3/src/demo.js",
    from: "    stats: { ...listingStats, matched: listed.totalMatched, shown: (listed.listings || []).length },",
    to: "    stats: { ...listingStats, matched: 0, shown: (listed.listings || []).length },",
    expect: "訪客示範",
  },
  {
    name: "`GET /api/demo` 改回同步的 buildDemoState（只看得到本機資料）",
    file: "v3/src/server.js",
    from: "    res.json(await buildDemoStateAsync({",
    to: "    res.json(buildDemoState({",
    expect: "路由接線",
  },
  {
    name: "`PUT /api/admin/maps` 改回同步的寫入",
    file: "v3/src/server.js",
    from: "    const settings = await saveAdminMapsSettingsAsync(body);",
    to: "    const settings = saveAdminMapsSettings(body);",
    expect: "路由接線",
  },
];

// 需求統計／首頁需求曝險（v3/test/demand-aggregate-async.test.js，第七十九批）。
const DEMANDAGG_MUTATIONS = [
  {
    name: "需求統計改回同步版（PG 才有的許願房不算）",
    file: "v3/src/demandAggregateAsync.js",
    from: "  if (!isPg(options)) return aggregateDemandSync(sqliteHandle(), rawFilters, now);",
    to: "  if (true) return aggregateDemandSync(sqliteHandle(), rawFilters, now);",
    expect: "需求統計：兩個 driver 逐欄位相同",
  },
  {
    name: "統計不回 PG 補水（別的節點關掉配對也照算）",
    file: "v3/src/demandAggregateAsync.js",
    from: "    await getWishConditionsAsync(options);\n    assertMatchingEnabled();",
    to: "    void options;\n    assertMatchingEnabled();",
    expect: "屋主配對關閉",
  },
  {
    name: "行政區索引為空時不重建（舊資料的行政區統計永遠是 0）",
    file: "v3/src/demandAggregateAsync.js",
    from: "    if (filters.districts.length && (await demandMatchDistrictIndexCountAsync(run)) === 0) {\n      await rebuildDemandMatchDistrictsAsync(run);\n    }",
    to: "    void filters;",
    expect: "新建許願房要維護 PG 的行政區索引",
  },
  {
    name: "建立許願房不維護 PG 的行政區索引",
    file: "v3/src/demandAsync.js",
    from: '    if (created && created.status !== "draft") await syncDemandMatchDistrictsAsync(run, created.id);',
    to: "    void created;",
    expect: "新建許願房要維護 PG 的行政區索引",
  },
  {
    name: "修改許願房不搬 PG 的行政區索引（舊行政區多一筆、新行政區少一筆）",
    file: "v3/src/demandAsync.js",
    from: "    await syncDemandMatchDistrictsAsync(run, row.id);\n    // 本機 handle 追上（`writeRow()` 內含 `syncDemandMatchDistricts()`，那一支吃 handle）。",
    to: "    // 本機 handle 追上（`writeRow()` 內含 `syncDemandMatchDistricts()`，那一支吃 handle）。",
    expect: "新建許願房要維護 PG 的行政區索引",
  },
  {
    name: "全量重建索引時什麼都不寫（懶重建變成空轉）",
    file: "v3/src/demandAsync.js",
    from: "      await run(MATCH_DISTRICTS_INSERT_SQL, [Number(row.id) || 0, key, Number(row.id) || 0, key]);\n      written += 1;",
    to: "      void key;",
    expect: "新建許願房要維護 PG 的行政區索引",
  },
  {
    name: "首頁曝險改回同步版（PG 的樣本看不到）",
    file: "v3/src/demandAggregateAsync.js",
    from: "  if (!isPg(options)) return homepageDemandExposureSync(sqliteHandle(), now);",
    to: "  if (true) return homepageDemandExposureSync(sqliteHandle(), now);",
    expect: "首頁需求曝險",
  },
  {
    name: "首頁曝險不看 PG 的配對開關（關掉了還照樣曝光）",
    file: "v3/src/demandAggregateAsync.js",
    from: "    if (!isWishOwnerMatchingEnabled(currentMatchFlags())) return { enabled: false, districts: [] };",
    to: "    void currentMatchFlags;",
    expect: "首頁需求曝險",
  },
  {
    name: "`GET /api/demand/aggregate` 改回同步版",
    file: "v3/src/server.js",
    from: "    res.json(await aggregateDemandAsync({",
    to: "    res.json(aggregateDemand({",
    expect: "路由接線",
  },
  {
    name: "`GET /api/demand/exposure` 改回同步版",
    file: "v3/src/server.js",
    from: "    res.json(await homepageDemandExposureAsync());",
    to: "    res.json(homepageDemandExposure());",
    expect: "路由接線",
  },
];

// 站內刊登的屋主配對讀取（v3/test/self-listing-match-async.test.js，第八十批）。
const SELFLISTING_MATCH_MUTATIONS = [
  {
    name: "自己的刊登改回同步版（別的節點的刊登看不到）",
    file: "v3/src/rentalMatchAsync.js",
    from: '  if (!isPg(options)) {\n    const { listMineSelfListings } = await import("./db.js");',
    to: '  if (true) {\n    const { listMineSelfListings } = await import("./db.js");',
    expect: "自己的刊登：PG 版與同步版逐欄位相同",
  },
  {
    name: "配對摘要改回同步版（候選只算本機的許願房）",
    file: "v3/src/rentalMatchAsync.js",
    from: "  if (!isPg(options)) return ownerListingMatchSummarySync(sqliteHandle(), postId, userId, now);",
    to: "  if (true) return ownerListingMatchSummarySync(sqliteHandle(), postId, userId, now);",
    expect: "工具資訊與 owner_matching",
  },
  {
    name: "附摘要時改回同步版（清單的摘要只算本機）",
    file: "v3/src/rentalMatchAsync.js",
    from: "  if (!isPg(options)) return attachOwnerMatchSummariesSync(sqliteHandle(), listings, userId, now);",
    to: "  if (true) return attachOwnerMatchSummariesSync(sqliteHandle(), listings, userId, now);",
    expect: "自己的刊登：PG 版與同步版逐欄位相同",
  },
  {
    name: "工具資訊改讀本機的會員（方案額度跟著本機跑）",
    file: "v3/src/rentalMatchAsync.js",
    from: "  const user = uid ? await getUserByIdAsync(uid, options) : null;",
    to: '  const user = uid ? (await import("./db.js")).getUserById(uid) : null;',
    expect: "工具資訊與 owner_matching",
  },
  {
    name: "owner_matching 不回 PG 補水（別的節點關掉也照樣配對）",
    file: "v3/src/rentalMatchAsync.js",
    from: "export async function rentalMatchOwnerMetaAsync(options = {}) {\n  await getWishConditionsAsync(options);",
    to: "export async function rentalMatchOwnerMetaAsync(options = {}) {\n  void options;",
    expect: "工具資訊與 owner_matching",
  },
  {
    name: "候選掃描不重建行政區索引（舊資料的配對永遠是 0）",
    file: "v3/src/rentalMatchAsync.js",
    from: "  if ((listing?.districts || []).length && (await demandMatchDistrictIndexCountAsync(run)) === 0) {\n    await rebuildDemandMatchDistrictsAsync(run);\n  }",
    to: "  void listing;",
    expect: "自己的刊登：PG 版與同步版逐欄位相同",
  },
  {
    name: "自己的刊登不裝飾（回傳原始列）",
    file: "v3/src/rentalMatchAsync.js",
    from: "    const rows = rowsOf(await run(SELF_LISTINGS_BY_OWNER_SQL, [uid]))\n      .map((row) => decorateSelfListing(row, { viewerId: uid }));",
    to: "    const rows = rowsOf(await run(SELF_LISTINGS_BY_OWNER_SQL, [uid]));",
    expect: "自己的刊登：PG 版與同步版逐欄位相同",
  },
  {
    name: "摘要文案不給（前端標籤空白）",
    file: "v3/src/rentalMatchQuery.js",
    from: '    label: snapshot.total\n      ? `目前可能符合 ${snapshot.total} 個活躍需求`\n      : "目前沒有符合的活躍需求",',
    to: '    label: "",',
    expect: "自己的刊登：PG 版與同步版逐欄位相同",
  },
  {
    name: "`GET /api/self-listings` 改回同步版",
    file: "v3/src/server.js",
    from: "      listings: await listMineSelfListingsAsync(session.userId),",
    to: "      listings: listMineSelfListings(session.userId),",
    expect: "路由接線",
  },
  {
    name: "`/matches/summary` 改回同步版",
    file: "v3/src/server.js",
    from: "    res.json(await ownerListingMatchSummaryAsync(req.params.id, session.userId));",
    to: "    res.json(ownerListingMatchSummary(req.params.id, session.userId));",
    expect: "路由接線",
  },
];

// 配對清單（v3/test/self-listing-matches-async.test.js，第八十一批）。
const SELFLISTING_MATCHES_MUTATIONS = [
  {
    name: "配對清單改回同步版（別的節點的刊登與心願看不到）",
    file: "v3/src/rentalMatchAsync.js",
    from: '  if (!isPg(options)) {\n    const { ownerListingMatches } = await import("./db.js");',
    to: '  if (true) {\n    const { ownerListingMatches } = await import("./db.js");',
    expect: "配對清單：PG 版與同步版逐欄位相同",
  },
  {
    name: "CTA 改回同步版（PG 的提案狀態不反映在按鈕上）",
    file: "v3/src/wishOffersAsync.js",
    from: '  const list = Array.isArray(items) ? items : [];\n  const enabled = flags ? flags.wish?.offer_enabled === true : isWishOfferEnabled(currentRentalMarketplaceFlags());',
    to: '  const list = Array.isArray(items) ? items : [];\n  return attachOfferCtas(sqliteHandle(), list, { listingId, ownerUserId, now });\n  const enabled = flags ? flags.wish?.offer_enabled === true : isWishOfferEnabled(currentRentalMarketplaceFlags());',
    // 殺手是「配對清單」那條的**列只留在 PG** 段落：同步版讀本機時找不到那些心願與提案，
    // CTA 會全部變成 `unavailable`（實測；「提案功能關閉時」那條反而抓不到，因為兩邊讀的是
    // 同一個行程內 flags 快取）。
    expect: "配對清單：PG 版與同步版逐欄位相同",
  },
  {
    name: "翻頁前不重驗心願生命週期（失效的心願照樣翻得到）",
    file: "v3/src/rentalMatchAsync.js",
    from: "      await assertUpcomingCursorWishesMatchableAsync(run, stored, cursor, limit);",
    to: "      void stored;",
    expect: "游標分頁：兩頁的內容都與同步版相同",
  },
  {
    name: "生命週期查詢的佔位符寫成 `$n`（注入式 exec 會整個失敗）",
    file: "v3/src/rentalMatchAsync.js",
    from: "  for (const chunk of chunkIds(list, chunkSize)) {\n    const marks = placeholders(chunk);",
    to: '  for (const chunk of chunkIds(list, chunkSize)) {\n    const marks = chunk.map((_, i) => `$${i + 1}`).join(",");',
    expect: "游標分頁：兩頁的內容都與同步版相同",
  },
  {
    name: "CTA 的 pending 分支拿掉（等待回覆變成可提供）",
    file: "v3/src/wishOffers.js",
    from: '  if (active?.status === "pending") {',
    to: '  if (false) {',
    expect: "配對清單：PG 版與同步版逐欄位相同",
  },
  {
    name: "配對清單不剝內部評分欄位（把內部分數外洩給屋主）",
    file: "v3/src/rentalMatchAsync.js",
    from: "    const items = page.items.map(ownerPublicMatchItem);\n    return {\n      listing_id: listing.id,\n      total: snapshot.total,",
    to: "    const items = page.items;\n    return {\n      listing_id: listing.id,\n      total: snapshot.total,",
    expect: "配對清單：PG 版與同步版逐欄位相同",
  },
  {
    name: "`GET /api/self-listings/:id/matches` 改回同步版",
    file: "v3/src/server.js",
    from: "    res.json(await ownerListingMatchesAsync(req.params.id, session.userId, {",
    to: "    res.json(ownerListingMatches(req.params.id, session.userId, {",
    expect: "路由接線",
  },
];

// 複製站內刊登（v3/test/self-listing-copy-async.test.js，第八十二批）。
const COPYSELF_MUTATIONS = [
  {
    name: "複製改回同步版（別的節點的刊登複製不到）",
    file: "v3/src/selfListingsAsync.js",
    from: '  if (!isPg(options)) {\n    const { copyOwnListing } = await import("./listingTools.js");',
    to: '  if (true) {\n    const { copyOwnListing } = await import("./listingTools.js");',
    expect: "列／素材只放在 PG 時",
  },
  {
    name: "素材所有權不查（把別人的照片一起複製走）",
    file: "v3/src/selfListingsAsync.js",
    from: "    if (isMemberMediaUrl(url)) {\n      if (await ownsMediaUrlAsync(userId, url, options)) out.push(url);\n      continue;\n    }",
    to: "    if (isMemberMediaUrl(url)) {\n      out.push(url);\n      continue;\n    }",
    expect: "複製：PG 版與同步版的草稿與回傳表單逐欄位相同",
  },
  {
    name: "草稿不寫進 PG（別的節點看不到那份草稿）",
    file: "v3/src/selfListingsAsync.js",
    from: "    await run(SELF_DRAFT_INSERT_SQL, selfDraftInsertParams({",
    to: "    void selfDraftInsertParams; await run(SELF_DRAFT_UPDATE_SQL, selfDraftUpdateParams({\n      uid: id, postId, body, photos, traits, deposit, contactName, roleName, phone, lineUrl,\n    })); if (false) await run(SELF_DRAFT_INSERT_SQL, selfDraftInsertParams({",
    expect: "列／素材只放在 PG 時",
  },
  {
    name: "來源列改讀本機（PG 的刊登找不到）",
    file: "v3/src/selfListingsAsync.js",
    from: "  const source = await getSelfRowAsync(sourceId, { ...options, exec: run, driver: \"postgres\", strict: true });",
    to: "  const source = getSelfRowSync(sqliteHandle(), sourceId);",
    expect: "列／素材只放在 PG 時",
  },
  {
    name: "冪等鍵不查（同一把鍵會產生兩份草稿）",
    file: "v3/src/selfListingsAsync.js",
    from: "    const hit = rowsOf(await run(COPY_IDEMPOTENCY_HIT_SQL, [uid, key]))[0];",
    to: "    const hit = null;",
    expect: "冪等鍵",
  },
  {
    name: "寫入失敗無條件回退本機（複製看起來成功、其實寫在別的地方）",
    file: "v3/src/selfListingsAsync.js",
    from: "    if (!sqliteFallbackAllowed(options, { write: true })) throw error;\n    const { copyOwnListing } = await import(\"./listingTools.js\");",
    to: "    const { copyOwnListing } = await import(\"./listingTools.js\");",
    expect: "寫入是 fail-closed",
  },
  {
    name: "`POST /api/self-listings/:id/copy` 改回同步版",
    file: "v3/src/server.js",
    from: "    res.json(await copyOwnListingAsync(session.userId, req.params.id, req.body || {}));",
    to: "    res.json(copyOwnListingFor(session.userId, req.params.id, req.body || {}));",
    expect: "路由接線",
  },
];

// 公開站內刊登草稿／匯入的確認後刊登（v3/test/self-listing-publish-async.test.js，第八十三批）。
const PUBLISHSELF_MUTATIONS = [
  {
    name: "公開草稿改回同步版（別的節點的草稿公開不了）",
    file: "v3/src/selfListingsAsync.js",
    from: '  if (!isPg(options)) {\n    const { publishImportedDraftListing } = await import("./selfListings.js");',
    to: '  if (true) {\n    const { publishImportedDraftListing } = await import("./selfListings.js");',
    expect: "草稿只放在 PG 時",
  },
  {
    name: "可刊登條件不算停權（被停權的人照樣公開）",
    file: "v3/src/selfListingsAsync.js",
    from: "  if (Number.isFinite(banned) && banned > at) {",
    to: "  if (false) {",
    expect: "可刊登條件讀 PG",
  },
  {
    name: "可刊登條件不算註冊未滿 24 小時",
    file: "v3/src/selfListingsAsync.js",
    from: "  if (!skipWait && Number.isFinite(created) && at - created < SELF_NEW_ACCOUNT_WAIT_MS) {",
    to: "  if (false) {",
    expect: "可刊登條件讀 PG",
  },
  {
    name: "可刊登條件不算同時上限（可以公開無限多則）",
    file: "v3/src/selfListingsAsync.js",
    from: "  if (open >= SELF_MAX_OPEN) {",
    to: "  if (false) {",
    expect: "可刊登條件讀 PG",
  },
  {
    name: "素材所有權不查（可以拿別人的照片公開）",
    file: "v3/src/selfListingsAsync.js",
    from: "    if (!(await ownsMediaUrlAsync(userId, url, options))) {",
    to: "    if (false) {",
    expect: "素材所有權",
  },
  {
    name: "匯入的確認後刊登改回同步版",
    file: "v3/src/listingImportAsync.js",
    from: "    return publishImportedDraftListingAsync(uid, row.listing_id, input, IMPORT_ROW_OPTIONS(options, run));",
    to: "    void IMPORT_ROW_OPTIONS;\n    return (await import(\"./db.js\")).publishConfirmedImportFor(uid, row.id, input);",
    expect: "匯入的確認後刊登",
  },
  {
    name: "寫入失敗無條件回退本機（公開看起來成功、站上沒有）",
    file: "v3/src/selfListingsAsync.js",
    from: "    if (!sqliteFallbackAllowed(options, { write: true })) throw error;\n    const { publishImportedDraftListing } = await import(\"./selfListings.js\");\n    return publishImportedDraftListing(sqliteHandle(), uid, postId, input, now, {\n      matchCandidates: options.matchCandidates,\n    });",
    to: "    const { publishImportedDraftListing } = await import(\"./selfListings.js\");\n    return publishImportedDraftListing(sqliteHandle(), uid, postId, input, now, {\n      matchCandidates: options.matchCandidates,\n    });",
    expect: "寫入是 fail-closed",
  },
  {
    name: "`POST /api/self-listings/:id/publish` 改回同步版",
    file: "v3/src/server.js",
    from: "    res.json(await publishImportedDraftListingAsync(session.userId, req.params.id, body, {",
    to: "    res.json(publishOwnedDraftFor(session.userId, req.params.id, body)); void (({",
    expect: "路由接線",
  },
  {
    name: "`POST /api/listing-imports/:id/publish` 改回同步版",
    file: "v3/src/server.js",
    from: "    res.json(await publishConfirmedImportAsync(session.userId, req.params.id, body, {",
    to: "    res.json(publishConfirmedImportFor(session.userId, req.params.id, body)); void (({",
    expect: "路由接線",
  },
];

// 建立站內刊登（v3/test/self-listing-create-async.test.js，第八十四批）。
const CREATESELF_MUTATIONS = [
  {
    name: "建立改回同步版（新刊登不在站上的清單裡）",
    file: "v3/src/selfListingsAsync.js",
    from: '  if (!isPg(options)) {\n    const { createSelfListing } = await import("./selfListings.js");',
    to: '  if (true) {\n    const { createSelfListing } = await import("./selfListings.js");',
    expect: "建立：PG 版與同步版的落地欄位相同",
  },
  {
    name: "可刊登條件不算停權（PG 停權的人照樣建立）",
    file: "v3/src/selfListingsAsync.js",
    from: "  if (Number.isFinite(banned) && banned > at) {",
    to: "  if (false) {",
    expect: "可刊登條件讀 PG",
  },
  {
    name: "可刊登條件不算同時上限",
    file: "v3/src/selfListingsAsync.js",
    from: "  if (open >= SELF_MAX_OPEN) {",
    to: "  if (false) {",
    expect: "可刊登條件讀 PG",
  },
  {
    name: "新刊登不寫進 PG",
    file: "v3/src/selfListingsAsync.js",
    from: "  await run(SELF_OPEN_INSERT_SQL, selfOpenInsertParams({",
    to: "  void selfOpenInsertParams; if (false) await run(SELF_OPEN_INSERT_SQL, selfOpenInsertParams({",
    expect: "建立：PG 版與同步版的落地欄位相同",
  },
  {
    name: "冪等鍵不查（同鍵會建出兩則）",
    file: "v3/src/selfListingsAsync.js",
    from: "      const hit = rowsOf(await run(SELF_CREATE_IDEMPOTENCY_HIT_SQL, [uid, key]))[0];",
    to: "      const hit = null;",
    expect: "冪等鍵",
  },
  {
    name: "同鍵不同內容不擋（覆蓋成新內容）",
    file: "v3/src/selfListingsAsync.js",
    from: "        if (String(hit.payload_hash) !== payloadHash) {\n          throw httpError(\"同一操作不能改成不同內容\", 409, \"IDEMPOTENCY_CONFLICT\");\n        }",
    to: "        void payloadHash;",
    expect: "冪等鍵",
  },
  {
    name: "寫入失敗無條件回退本機（建立看起來成功、站上沒有）",
    file: "v3/src/selfListingsAsync.js",
    from: "    if (!sqliteFallbackAllowed(options, { write: true })) throw error;\n    const { createSelfListing } = await import(\"./selfListings.js\");",
    to: "    const { createSelfListing } = await import(\"./selfListings.js\");",
    expect: "寫入是 fail-closed",
  },
  {
    name: "`POST /api/self-listings` 改回同步版",
    file: "v3/src/server.js",
    from: "    const created = await createSelfListingAsync(session.userId, body, {",
    to: "    const created = createSelfListing(session.userId, body); void (({",
    expect: "路由接線",
  },
];

// OAuth callback（`GET /auth/:provider/callback`，第八十五批）。
// 這一條的重點是「綁定欄位要寫 PG」與「不得偷偷改成 fail-closed 而擋掉社群登入」。
const OAUTHCB_MUTATIONS = [
  {
    name: "provider 不截斷（與同步版的落地值不同）",
    file: "v3/src/usersAsync.js",
    from: "  const params = [String(provider || \"\").slice(0, 40), String(subject || \"\").slice(0, 120), id];",
    to: "  const params = [String(provider || \"\"), String(subject || \"\").slice(0, 120), id];",
    expect: "逐字相同",
  },
  {
    name: "subject 不截斷（與同步版的落地值不同）",
    file: "v3/src/usersAsync.js",
    from: "  const params = [String(provider || \"\").slice(0, 40), String(subject || \"\").slice(0, 120), id];",
    to: "  const params = [String(provider || \"\").slice(0, 40), String(subject || \"\"), id];",
    expect: "逐字相同",
  },
  {
    name: "provider／subject 寫反（欄位對調）",
    file: "v3/src/usersAsync.js",
    from: "  const params = [String(provider || \"\").slice(0, 40), String(subject || \"\").slice(0, 120), id];",
    to: "  const params = [String(subject || \"\").slice(0, 120), String(provider || \"\").slice(0, 40), id];",
    expect: "逐字相同",
  },
  {
    name: "缺欄位時送 undefined（同步版送空字串）",
    file: "v3/src/usersAsync.js",
    from: "  const params = [String(provider || \"\").slice(0, 40), String(subject || \"\").slice(0, 120), id];",
    to: "  const params = [String(provider).slice(0, 40), String(subject || \"\").slice(0, 120), id];",
    expect: "缺欄位時同步版送空字串",
  },
  {
    name: "沒有 id 也送 UPDATE（WHERE id = 0）",
    file: "v3/src/usersAsync.js",
    from: "  if (!id) return;\n  const params =",
    to: "  if (false) return;\n  const params =",
    expect: "id 0 直接短路",
  },
  {
    name: "綁定失敗改成往外丟（社群登入會整條掛掉）",
    file: "v3/src/usersAsync.js",
    from: "  } catch { /* 與同步版一致：舊庫還沒加欄位時吞掉，不擋登入 */ }",
    to: "  } catch (error) { throw error; }",
    expect: "綁定失敗只吞掉",
  },
  {
    name: "sqlite 模式改走 PG runner（不碰 runner 的契約破掉）",
    file: "v3/src/usersAsync.js",
    from: "  if (!isPg(options)) return linkOauthIdentitySync(sqliteHandle(), id, { provider, subject });",
    to: "  if (false) return linkOauthIdentitySync(sqliteHandle(), id, { provider, subject });",
    expect: "sqlite 模式走同步路徑",
  },
  {
    name: "`/auth/:provider/callback` 的綁定改回同步版",
    file: "v3/src/server.js",
    from: "    await linkOauthIdentityAsync(user.id, { provider, subject: profile.subject });",
    to: "    linkOauthIdentity(user.id, { provider, subject: profile.subject });",
    expect: "路由接線",
  },
  {
    name: "callback 的開通 token 改回同步版",
    file: "v3/src/server.js",
    from: "      const issued = await issueVerifyTokenAsync(user.id);",
    to: "      const issued = issueVerifyToken(user.id);",
    expect: "路由接線",
  },
  {
    name: "callback 的 SMTP 讀取改回本機（PG 站會說「尚未設定寄信」）",
    file: "v3/src/server.js",
    from: "      if (!mailConfigured(await getStoredSmtpAsync())) {\n        const err = new Error(\"尚未設定寄信，無法完成社群註冊開通信。",
    to: "      if (!mailConfigured(getStoredSmtp())) {\n        const err = new Error(\"尚未設定寄信，無法完成社群註冊開通信。",
    expect: "路由接線",
  },
  {
    name: "只刪 import、body 還在呼叫（量尺會誤判成 PG）",
    file: "v3/src/server.js",
    from: "  linkOauthIdentityAsync,\n",
    to: "",
    expect: "路由接線",
  },
];

// 建立匯入（`POST /api/listing-imports`，第八十六批）。
// 重點：匯入列與草稿都要落在 PG、狀態機與失敗落地要一致，而且寫入不得 fail-open。
const IMPORTSTART_MUTATIONS = [
  {
    name: "匯入不建立草稿列（PG 只有匯入列、沒有草稿）",
    file: "v3/src/selfListingsAsync.js",
    from: "    await run(IMPORT_DRAFT_INSERT_SQL, importDraftInsertParams({",
    to: "    void importDraftInsertParams; if (false) await run(IMPORT_DRAFT_INSERT_SQL, importDraftInsertParams({",
    expect: "PG 分支：591 匯入",
  },
  {
    name: "草稿的 source_id 前綴錯（匯入列與草稿對不上）",
    file: "v3/src/selfListings.js",
    from: "  return [`import:${uid}:${postId}`, uid, body, JSON.stringify(photos), postId];",
    to: "  return [`draft:${uid}:${postId}`, uid, body, JSON.stringify(photos), postId];",
    expect: "PG 分支：591 匯入",
  },
  {
    name: "匯入草稿的狀態不是 draft（直接變成已公開）",
    file: "v3/src/selfListings.js",
    from: "export const IMPORT_DRAFT_UPDATE_SQL = `UPDATE listings SET\n      source = 'self',\n      source_id = ?,\n      listed_by_user_id = ?,\n      self_status = 'draft',",
    to: "export const IMPORT_DRAFT_UPDATE_SQL = `UPDATE listings SET\n      source = 'self',\n      source_id = ?,\n      listed_by_user_id = ?,\n      self_status = 'open',",
    expect: "PG 分支：591 匯入",
  },
  {
    name: "匯入列不進 ready_for_review（停在 fetching）",
    file: "v3/src/listingImport.js",
    from: "  return [\n    IMPORT_STATUSES.READY_FOR_REVIEW,\n    title,",
    to: "  return [\n    IMPORT_STATUSES.FETCHING,\n    title,",
    expect: "PG 分支：591 匯入",
  },
  {
    name: "匯入列不指回草稿（listing_id 留 0）",
    file: "v3/src/listingImportAsync.js",
    from: "        postId: listing.post_id,",
    to: "        postId: 0,",
    expect: "PG 分支：591 匯入",
  },
  {
    name: "匯入列掛在錯的會員身上",
    file: "v3/src/listingImport.js",
    from: "  return [uid, parsed.provider, parsed.original, parsed.normalized, parsed.source_listing_id, IMPORT_STATUSES.PENDING, stamp];",
    to: "  return [Number(uid) + 1, parsed.provider, parsed.original, parsed.normalized, parsed.source_listing_id, IMPORT_STATUSES.PENDING, stamp];",
    expect: "PG 分支：591 匯入",
  },
  {
    name: "照片預算歸零（匯入不帶任何照片）",
    file: "v3/src/listingImportAsync.js",
    from: "      const remaining = Math.max(0, mediaQuotaForPlan(plan) - used);",
    to: "      const remaining = 0; void used;",
    expect: "PG 分支：591 匯入",
  },
  {
    name: "同來源不查重（重複匯入會建出第二列）",
    file: "v3/src/listingImportAsync.js",
    from: "    const active = rowToImport(((await run(IMPORT_ACTIVE_BY_SOURCE_SQL, [uid, parsed.normalized, ...ACTIVE_IMPORT_STATUSES])).rows || [])[0]);",
    to: "    const active = null; void IMPORT_ACTIVE_BY_SOURCE_SQL; void ACTIVE_IMPORT_STATUSES;",
    expect: "同來源重複匯入回同一筆",
  },
  {
    name: "不檢查贊助條件（免費用戶也能匯入）",
    file: "v3/src/listingImportAsync.js",
    from: "  assertSponsorMember(plan, role);",
    to: "  if (false) assertSponsorMember(plan, role);",
    expect: "非贊助會員 403",
  },
  {
    // ⚠️ 這一條原本想殺「解析失敗的碼」那個分支，但實測是**等價變異**：
    // `import591.js`／`import5168.js` 的解析器自己就會在標題與說明都空的時候丟
    // `PARSE_FAILED`（同一支 `fetchParsedListing()`），所以抵達島嶼那一行之前就結束了。
    // 島嶼那一行是「與同步版對稱」的防守性重複（同步版也有同一行）；要殺它得先讓某個
    // provider 回「非空字串、但清洗後變空」的內容——目前兩個 provider 都做不到。
    // 依 AGENT-RULES「等價變異要移除並寫明理由」，改成釘住匯入列的 provider 欄位。
    name: "匯入列的 provider 寫錯（591 被記成 5168）",
    file: "v3/src/listingImport.js",
    from: "  return [uid, parsed.provider, parsed.original, parsed.normalized, parsed.source_listing_id, IMPORT_STATUSES.PENDING, stamp];",
    to: "  return [uid, \"5168\", parsed.original, parsed.normalized, parsed.source_listing_id, IMPORT_STATUSES.PENDING, stamp];",
    expect: "PG 分支：591 匯入",
  },
  {
    name: "寫入改成 fail-open（PG 掛掉時偷偷寫本機）",
    file: "v3/src/listingImportAsync.js",
    from: "    if (!sqliteFallbackAllowed(options, { write })) throw error;",
    to: "    if (!sqliteFallbackAllowed(options, {})) throw error;",
    expect: "寫入 fail-closed",
  },
  {
    name: "`POST /api/listing-imports` 改回同步版",
    file: "v3/src/server.js",
    from: "    const row = await startListingImportAsync(session.userId, req.body || {}, { plan: session.plan || \"free\", role: session.role || \"\" });",
    to: "    const row = await startListingImportFor(session.userId, req.body || {}, { plan: session.plan || \"free\", role: session.role || \"\" });",
    expect: "路由接線",
  },
  {
    name: "只刪 import、body 還在呼叫（量尺會誤判成 PG）",
    file: "v3/src/server.js",
    from: "  startListingImportAsync,\n",
    to: "",
    expect: "路由接線",
  },
];

// 建立許願房提案（`POST /api/self-listings/:id/matches/:wishRef/offers`，第八十七批；缺口歸零）。
// 重點：提案／事件／冪等鍵都要落在 PG，閘門與每日上限要讀 PG，而且寫入不得 fail-open。
const OFFERCREATE_MUTATIONS = [
  {
    name: "提案不寫 PG（PG 站上看不到剛送的提案）",
    file: "v3/src/wishOffersAsync.js",
    from: "    const res = await run(`${OFFER_INSERT_SQL} RETURNING id`, offerInsertParams({",
    to: "    const res = { rows: [] }; void OFFER_INSERT_SQL; if (false) await run(`${OFFER_INSERT_SQL} RETURNING id`, offerInsertParams({",
    expect: "PG 建立：落地與投影",
  },
  {
    name: "提案的 tenant 寫成屋主自己（房客收不到）",
    file: "v3/src/wishOffers.js",
    from: "    Number(wishRow.user_id),\n    idempotencyKey || null,",
    to: "    Number(ownerUserId),\n    idempotencyKey || null,",
    expect: "PG 建立：落地與投影",
  },
  {
    name: "事件不落地（沒有 offer_created 痕跡）",
    file: "v3/src/wishOffersAsync.js",
    from: '    await writeOfferEventAsync(run, {\n      offerId: offer.id,\n      actorUserId: ownerUserId,\n      eventType: "offer_created",',
    to: '    if (false) await writeOfferEventAsync(run, {\n      offerId: offer.id,\n      actorUserId: ownerUserId,\n      eventType: "offer_created",',
    expect: "PG 建立：落地與投影",
  },
  {
    name: "冪等鍵不落地（同鍵會建出第二筆）",
    file: "v3/src/wishOffersAsync.js",
    from: "        await run(IDEMPOTENCY_INSERT_SQL, idempotencyParams({",
    to: "        void idempotencyParams; if (false) await run(IDEMPOTENCY_INSERT_SQL, idempotencyParams({",
    expect: "冪等鍵重放",
  },
  {
    name: "冪等鍵不查（同鍵不同目標也放行）",
    file: "v3/src/wishOffersAsync.js",
    from: "      const replay = one((await run(IDEMPOTENCY_BY_KEY_SQL, [Number(ownerUserId), key])).rows);\n      if (replay) {",
    to: "      const replay = null; void IDEMPOTENCY_BY_KEY_SQL;\n      if (replay) {",
    expect: "冪等鍵換目標",
  },
  {
    name: "已有 pending 時不擋（會撞唯一索引或建出第二筆）",
    file: "v3/src/wishOffersAsync.js",
    from: "  const existingPending = one((await run(PENDING_OFFER_SQL, [\n    Number(ownerUserId), Number(listingRow.post_id), Number(wishRow.id),\n  ])).rows);\n  if (existingPending) return { live, existingPending };",
    to: "  const existingPending = null;\n  if (existingPending) return { live, existingPending };",
    expect: "已有 pending",
  },
  {
    name: "擁有者停權不檢查（停權的人照樣提案）",
    file: "v3/src/wishOffersAsync.js",
    from: "  if (await ownerBannedAsync(run, ownerUserId, now)) {",
    to: "  if (false) {",
    expect: "屋主被停權",
  },
  {
    name: "每日上限不查（第 9 筆照樣建立）",
    file: "v3/src/wishOffersAsync.js",
    from: "  if (await sinceCountAsync(run, OWNER_OFFERS_SINCE_SQL, ownerUserId, since) >= OFFER_OWNER_DAILY_CAP) {",
    to: "  if (false) {",
    expect: "每日上限讀 PG 的計數",
  },
  {
    name: "刊登擁有者不驗（別人的刊登也能提案）",
    file: "v3/src/wishOffersAsync.js",
    from: "  if (!listingRow || Number(listingRow.listed_by_user_id) !== Number(ownerUserId)) {",
    to: "  if (!listingRow) {",
    expect: "閘門：不是自己的刊登",
  },
  {
    name: "配對資格不驗（已下架／條件不合也建立）",
    file: "v3/src/wishOffersAsync.js",
    from: "  const live = liveMatchEligible(null, listingRow, wishRow, now);\n  if (!live.eligible) {",
    to: "  const live = { eligible: true };\n  if (!live.eligible) {",
    expect: "刊登已下架",
  },
  {
    name: "旗標／目錄不從 PG 收斂（拿本機過期的目錄判斷配對）",
    file: "v3/src/wishOffersAsync.js",
    from: "    await getRentalCatalogAsync(options);\n    await getWishConditionsAsync(options);",
    to: "    void getWishConditionsAsync;",
    expect: "收斂進行程內快取",
  },
  {
    name: "寫入改成 fail-open（PG 掛掉時偷偷寫本機）",
    file: "v3/src/wishOffersAsync.js",
    from: 'export async function createWishOfferAsync(ownerUserId, listingRef, wishRef, {\n  idempotencyKey,\n  now = new Date(),\n  actorKey = "",\n} = {}, options = {}) {\n  return withFallback(options, { write: true }, async (run) => {',
    to: 'export async function createWishOfferAsync(ownerUserId, listingRef, wishRef, {\n  idempotencyKey,\n  now = new Date(),\n  actorKey = "",\n} = {}, options = {}) {\n  return withFallback(options, { write: false }, async (run) => {',
    expect: "寫入 fail-closed",
  },
  {
    name: "`POST …/offers` 改回同步版",
    file: "v3/src/server.js",
    from: "    const created = await createWishOfferAsync(session.userId, req.params.id, req.params.wishRef, {",
    to: "    const created = createWishOfferFor(session.userId, req.params.id, req.params.wishRef, {",
    expect: "路由接線",
  },
  {
    name: "只刪 import、body 還在呼叫（量尺會誤判成 PG）",
    file: "v3/src/server.js",
    from: "  createWishOfferAsync,\n",
    to: "",
    expect: "路由接線",
  },
];

const REJECT_MUTATIONS = [
  {
    name: "拿掉 user_match_votes 的 upsert（票不會落地）",
    file: SRC,
    from: "    await exec(UPSERT_VOTE_SQL, [uid, lo, hi, pairConfidence(listing, peer), now, now]);\n",
    to: "",
    expect: "首次拆開",
  },
  {
    name: "拿掉 user_match_signals 的 insert（訊號不會落地）",
    file: SRC,
    from: "    await exec(INSERT_SIGNAL_SQL, [uid, lo, hi, now]);\n",
    to: "",
    expect: "首次拆開",
  },
  {
    name: "拿掉 user_events 的寫入（拆開事件不會落地）",
    file: SRC,
    from: "    await addUserEventAsync(exec, {",
    to: "    void (({ user_id: 0 })); await (async () => ({}))({",
    expect: "首次拆開",
  },
  {
    name: "拿掉全站升級的 UPDATE（verdict 永遠不會變 no）",
    file: SRC,
    from: "    await exec(PROMOTE_SPLIT_SQL, [lo, hi]);\n",
    to: "",
    expect: "升級全站拆開",
  },
  {
    name: "把 promote 的 hidden=0 拿掉（拆開後物件仍隱藏）",
    file: SRC,
    from: "   SET match_verdict = 'no', match_rejected = 1, hidden = 0",
    to: "   SET match_verdict = 'no', match_rejected = 1, hidden = hidden",
    expect: "升級全站拆開",
  },
  {
    name: "管理員拆開誤加 hidden=0（覆蓋掉不該動的欄位）",
    file: SRC,
    from: "const ADMIN_SPLIT_SQL = `UPDATE listings\n   SET match_verdict = 'no', match_rejected = 1\n   WHERE post_id IN (?, ?)`;",
    to: "const ADMIN_SPLIT_SQL = `UPDATE listings\n   SET match_verdict = 'no', match_rejected = 1, hidden = 0\n   WHERE post_id IN (?, ?)`;",
    expect: "管理員拆開",
  },
  {
    name: "拿掉『已經投過 split 就不重複寫』的守衛",
    file: SRC,
    from: '  if (existing?.vote !== "split") {\n    const peer = (await exec(PEER_LEVEL_SQL, [otherId]))[0];',
    to: "  if (true) {\n    const peer = (await exec(PEER_LEVEL_SQL, [otherId]))[0];",
    expect: "重複拆開",
  },
  {
    name: "拿掉每日上限的判斷（rate_limit 永遠不觸發）",
    file: SRC,
    from: "  if (existing?.vote !== \"split\" && used >= MATCH_SPLIT_DAILY_LIMIT) {",
    to: "  if (false) {",
    expect: "每日上限",
  },
  {
    name: "每日計數忽略日期條件（昨天的票也算今天）",
    file: SRC,
    from: "   WHERE user_id = ? AND vote = 'split' AND created_at >= ?`;",
    to: "   WHERE user_id = ? AND vote = 'split' AND created_at >= '0000'`;",
    expect: "跨日不計入",
  },
  {
    name: "countPairVotes 不計票（永遠 0 票，不可能升級）",
    file: SRC,
    from: '    if (row.vote === "split") out.split = Number(row.n) || 0;',
    to: '    if (row.vote === "split") out.split = 0;',
    expect: "升級全站拆開",
  },
  {
    name: "管理員拆開不解除群組綁定",
    file: SRC,
    from: "  await unbindListingFromGroup(exec, a, { now });\n  await unbindListingFromGroup(exec, b, { now });\n",
    to: "",
    expect: "管理員拆開",
  },
  {
    name: "管理員拆開不寫 listings 的 verdict",
    file: SRC,
    from: "  await exec(ADMIN_SPLIT_SQL, [a, b]);\n",
    to: "",
    expect: "管理員拆開",
  },
  {
    name: "把 COALESCE 改回 SQLite 的 IFNULL（正式站會拋錯）",
    file: SRC,
    from: "   WHERE match_post_id = ? AND COALESCE(match_verdict, '') != 'no'",
    to: "   WHERE match_post_id = ? AND IFNULL(match_verdict, '') != 'no'",
    expect: "找不到 peer",
  },
  {
    name: "個人拆開：剩 1 人時不刪除（留下孤兒成員）",
    file: USER_SRC,
    from: "  if (remain.length === 1) {\n    await exec(DELETE_ONE_SQL, [uid, remain[0]]);",
    to: "  if (false) {\n    await exec(DELETE_ONE_SQL, [uid, remain[0]]);",
    expect: "剩 1 人時整組刪除",
  },
  {
    name: "個人拆開：剩 2 人以上不重新分組（沿用舊 group_key）",
    file: USER_SRC,
    from: "    const next = newGroupKey();",
    to: "    const next = keyA;",
    expect: "剩 2 人以上",
  },
  {
    name: "非 postgres 不回退、直接走 PG 分支（SQLite 站會壞）",
    file: SRC,
    from: '  if ((options.driver || resolveDbDriver()) !== "postgres") {\n    const { rejectSuspectedMatch } = await import("./db.js");\n    return rejectSuspectedMatch(postId, userId, { peerId, admin });\n  }',
    to: "  if (false) {\n    const { rejectSuspectedMatch } = await import(\"./db.js\");\n    return rejectSuspectedMatch(postId, userId, { peerId, admin });\n  }",
    expect: "非 postgres",
  },
];

// 許願房（檢舉／回覆／關閉／讀取）PG 分支的變異集（v3/test/demand-async.test.js）。
//
// ⚠️ 刻意**沒有**「拿掉 `wishVisibleOnSurface()` 可見性判斷」這一條：那一支只對 stage1
// fixture 列有鑑別力（非 fixture 列一律回 true），而 fixture 隔離由
// `rental-match-isolation`／`stage1-fixture-*` 那幾組測試守著。放了只會得到假 SURVIVED。
const DEMAND_SRC = "v3/src/demandAsync.js";
const DEMAND_EFFECTS_SRC = "v3/src/demand.js";
const DEMAND_MUTATIONS = [
  {
    name: "檢舉計數改成寫入前的門檻（達門檻的那一筆不會隱藏）",
    file: DEMAND_SRC,
    from: "    const count = Number(one((await run(REPORT_COUNT_SQL, [kind, id])).rows)?.n) || 0;\n    const hide = count >= DEMAND_REPORT_HIDE_AFTER;",
    to: "    const count = Number(one((await run(REPORT_COUNT_SQL, [kind, id])).rows)?.n) || 0;\n    const hide = false;",
    expect: "第二筆達門檻要隱藏",
  },
  {
    name: "拿掉『同一人不重複檢舉』的查詢（會一直重複寫入）",
    file: DEMAND_SRC,
    from: "    const already = one((await run(REPORT_DUPLICATE_SQL, [kind, id, uid])).rows);\n    if (already) return { ok: true, already: true };",
    to: "    const already = null;\n    if (already) return { ok: true, already: true };",
    expect: "重複檢舉",
  },
  {
    name: "拿掉檢舉目標的存在檢查（不存在的目標也會被寫入）",
    file: DEMAND_SRC,
    from: "    const exists = one((await run(TARGET_EXISTS_SQL[kind], [id])).rows);\n    if (!exists) throw httpError(\"找不到要檢舉的內容\", 404);",
    to: "    const exists = true;\n    if (!exists) throw httpError(\"找不到要檢舉的內容\", 404);",
    expect: "目標不存在",
  },
  {
    name: "靜默吞掉 PG 的錯誤（寫入失敗會變成無聲的分歧）",
    file: DEMAND_SRC,
    from: "  } catch (error) {\n    if (!sqliteFallbackAllowed(options, { write })) throw error;\n    return runSqlite();\n  }",
    to: "  } catch (error) {\n    if (!sqliteFallbackAllowed(options, { write })) return null;\n    return runSqlite();\n  }",
    expect: "fail-closed",
  },
  {
    name: "回覆不擋 20 秒間隔（洗版防線失效）",
    file: DEMAND_SRC,
    from: "    if (last && now.getTime() - Date.parse(last.created_at) < DEMAND_REPLY_MIN_GAP_MS) {",
    to: "    if (false && last && now.getTime() - Date.parse(last.created_at) < DEMAND_REPLY_MIN_GAP_MS) {",
    expect: "間隔與每小時上限",
  },
  {
    name: "關閉不檢查擁有者（任何人可關別人的許願房）",
    file: DEMAND_SRC,
    from: "    if (!admin && Number(row.user_id) !== Number(userId)) throw httpError(\"只能關閉自己的許願房\", 403);",
    to: "    if (false) throw httpError(\"只能關閉自己的許願房\", 403);",
    expect: "非本人",
  },
  {
    name: "關閉不寫 lifecycle（收尾狀態不會落地）",
    file: DEMAND_EFFECTS_SRC,
    from: "  writeLifecycle(db, id, { lifecycle: \"paused\", closed_reason: \"paused\" });\n  syncDemandMatchDistricts(db, id);",
    to: "  syncDemandMatchDistricts(db, id);",
    expect: "lifecycle",
  },
  {
    // CI 的 live PG 就是抓到這一條：只寫本機 handle，PG 上那一列還是 open。
    name: "隱藏不寫 PG（只寫本機 handle ⇒ PG 模式下等於沒有隱藏）",
    file: DEMAND_SRC,
    from: "      await applyReportHideEffectsAsync(run, kind, id, now);\n      applyReportHideEffects(sqliteHandle(), kind, id, now);",
    to: "      applyReportHideEffects(sqliteHandle(), kind, id, now);",
    expect: "兩邊都變成 hidden",
  },
  {
    name: "公開視圖不套洩漏守衛（contacts／replies 會跟著出去）",
    file: DEMAND_SRC,
    from: "      const view = assertPublicFields(publicWishRoomView(decorated));",
    to: "      const view = { ...publicWishRoomView(decorated), replies: decorated.replies };",
    expect: "詳情的形狀與可見性判斷",
  },
  {
    name: "過期掃描只寫 PG（本機 handle 不追 ⇒ 回退路徑看到舊狀態）",
    file: DEMAND_SRC,
    from: "  expireOpenPosts(sqliteHandle(), now);\n",
    to: "",
    expect: "兩個 store 都改",
  },
  {
    name: "公開列表不套公開篩選條件（city／district 篩選失效）",
    file: DEMAND_SRC,
    from: "    const filtered = mine ? rows : rows.filter((row) => matchesFilters(row, rest));",
    to: "    const filtered = rows;",
    expect: "含篩選條件",
  },
  // 第六十五批：`createDemandAsync`（`POST /api/demand` ＋ `POST /api/wish-rooms`）。
  {
    name: "建立不檢查『一人一則』（可以一直開新的公開許願房）",
    file: DEMAND_SRC,
    from: "  if (await idOfAsync(tx, OPEN_ID_SQL, uid)) throwActiveLimit();\n  const draftId = await idOfAsync(tx, DRAFT_ID_SQL, uid);",
    to: "  const draftId = await idOfAsync(tx, DRAFT_ID_SQL, uid);",
    expect: "wish_active_limit",
  },
  {
    name: "草稿不看現有的 open（可以在公開許願房旁邊存草稿）",
    file: DEMAND_SRC,
    from: "    if (await idOfAsync(tx, OPEN_ID_SQL, uid)) throwDraftBesideOpen();\n",
    to: "",
    expect: "wish_mutable_limit",
  },
  {
    name: "草稿不就地改寫（每次存草稿都多一列）",
    file: DEMAND_SRC,
    from: "    const draftId = await idOfAsync(tx, DRAFT_ID_SQL, uid);\n    if (draftId) {\n      const extra = { updated_at: iso(now) };",
    to: "    const draftId = 0;\n    if (draftId) {\n      const extra = { updated_at: iso(now) };",
    expect: "已有草稿時就地改寫",
  },
  {
    name: "建立後不鏡像到本機 handle（還沒搬完的讀取看不到）",
    file: DEMAND_SRC,
    from: "  mirrorInsertLocal(id, uid, fields, status, now, isolation);\n",
    to: "",
    expect: "本機 handle 要有鏡像列",
  },
  {
    name: "建立不驗帳號成熟度（新帳號可以立刻洗版）",
    file: DEMAND_SRC,
    from: "    if (!asDraft && !isFixtureMaturityAuthorized(sqliteHandle(), uid, now, maturity)) {\n      await assertMatureAccountAsync(run, uid, now, \"刊登許願房\");\n    }\n",
    to: "",
    expect: "新帳號未滿 24 小時",
  },
  {
    // 反洗版的門檻不能在 PG 站靜默失效：本機 handle 只是備援，來源必須是 PG 的 `users`。
    name: "成熟度改讀本機（本機沒有那一列時等於完全不擋）",
    file: DEMAND_SRC,
    from: "  const row = one((await run(USER_CREATED_AT_SQL, [uid])).rows);\n  const local = row ? String(row.created_at || \"\") : String(userCreatedAt(sqliteHandle(), uid) || \"\");",
    to: "  const row = null;\n  const local = String(userCreatedAt(sqliteHandle(), uid) || \"\");",
    expect: "成熟度以 PG 的 users 為準",
  },
  {
    name: "回覆不驗帳號成熟度（新帳號可以立刻回覆洗版）",
    file: DEMAND_SRC,
    from: '    await assertMatureAccountAsync(run, uid, new Date(), "回覆");\n',
    to: "",
    expect: "回覆：新帳號未滿 24 小時",
  },
  {
    name: "建立前不掃過期許願（過期的 open 會誤擋新刊登）",
    file: DEMAND_SRC,
    from: "    await expireOpenPostsAsync(run, now);\n    const fields = await wishFieldsAsync(run, uid, input || {}, {});",
    to: "    const fields = await wishFieldsAsync(run, uid, input || {}, {});",
    expect: "過期的舊許願要先被掃掉",
  },
  {
    name: "競態時不接手（直接丟回唯一的錯誤）",
    file: DEMAND_SRC,
    from: "      created = await inDemandTransaction(options, (tx) => recoverCreateRaceAsync(tx, uid, now, options, fields, asDraft, error));",
    to: "      throw error;",
    expect: "競態（插入前先被建立草稿）",
  },
  {
    name: "建立不記 wish_cloned（複製許願的統計永遠 0）",
    file: DEMAND_SRC,
    from: '        if (prior.length) await bumpAnalyticsAsync("wish_cloned", now, 1, nested(options, run));',
    to: '        if (prior.length) await bumpAnalyticsAsync("__none__", now, 1, nested(options, run));',
    expect: "wish_cloned",
  },
  {
    // 2026-09-29 live PG 測試抓到的既有缺陷：`rowsToViews()` 補完 token 後會**再裝飾一次**，
    // 而 `row.public_token` 在記憶體裡仍是空的 ⇒ 每次都生一個新 token，回傳的是「第二個」，
    // 那個從來沒落地（分享連結 404）。
    name: "惰性補 token 每次都生新的（回傳的 token 與落地值不同）",
    file: DEMAND_SRC,
    from: "      const known = cache.tokenByRow.get(id);\n      if (known) return known;",
    to: "      const known = null;\n      if (known) return known;",
    expect: "同一組 token",
  },
  {
    name: "插入不取回 id（新許願房的 id 變成 0）",
    file: DEMAND_SRC,
    from: "  const id = forcedId || Number(one((await tx(`${sql} RETURNING id`, params)).rows)?.id) || 0;",
    to: "  const id = forcedId || 0;",
    expect: "本機 handle 要有鏡像列",
  },
];

// 許願房提案讀取（PG 島嶼）的變異集（v3/test/wish-offers-async.test.js）。
const WOFFERS_SRC = "v3/src/wishOffersAsync.js";
const WOFFERS_QUERIES_SRC = "v3/src/wishOfferQueries.js";
const WOFFERS_MUTATIONS = [
  {
    name: "可見性不檢查當事人（任何人都能看別人的提案）",
    file: WOFFERS_SRC,
    from: "    if (Number(row.owner_user_id) !== uid && Number(row.tenant_user_id) !== uid) return null;",
    to: "    if (false) return null;",
    expect: "非當事人",
  },
  {
    name: "刊登列不從 PG 讀（投影只剩 listing_ref）",
    file: WOFFERS_SRC,
    from: "    const listingRow = offer.listing_id\n      ? await getSelfRowAsync(offer.listing_id, { ...options, driver: \"postgres\" })\n      : null;",
    to: "    const listingRow = null;",
    expect: "投影與同步版逐鍵相同",
  },
  {
    name: "分頁的 LIMIT 少 1（最後一頁會少一筆）",
    file: WOFFERS_SRC,
    from: "      params.push(Number(limit) + 1);",
    to: "      params.push(Number(limit));",
    expect: "分頁、統計、游標兩邊一致",
  },
  {
    name: "列表的 status 篩選只套在 count、沒套在查詢（回傳不符條件的列）",
    file: WOFFERS_SRC,
    from: "      if (status) params.push(String(status));\n      if (keyset)",
    to: "      if (false) params.push(String(status));\n      if (keyset)",
    expect: "status 篩選與空集合",
  },
  {
    name: "檢舉不檢查角色（屋主也能檢舉自己的提案）",
    file: WOFFERS_SRC,
    from: "  if (!offer || Number(offer.tenant_user_id) !== Number(userId)) {\n    throw offerHttpError(\"找不到這筆提案\", 404, \"offer_not_found\");\n  }",
    to: "  if (!offer) {\n    throw offerHttpError(\"找不到這筆提案\", 404, \"offer_not_found\");\n  }",
    expect: "只有房客能檢舉",
  },
  {
    name: "檢舉不檢查重複（同一人可以一直檢舉同一提案）",
    file: WOFFERS_SRC,
    from: "    const existing = one((await run(REPORT_EXISTING_SQL, [Number(offer.id), uid])).rows);\n    if (existing) return { ok: true, already: true, report_ref: existing.public_token };",
    to: "    const existing = null;\n    if (existing) return { ok: true, already: true, report_ref: existing.public_token };",
    expect: "驗證、寫入與稽核事件兩邊一致",
  },
  {
    name: "檢舉不寫稽核事件（事後查不到）",
    file: WOFFERS_SRC,
    from: "    await writeOfferEventAsync(run, {\n      offerId: offer.id, actorUserId: uid, eventType: \"offer_reported\", meta: { reason: code }, now,\n    });",
    to: "    void writeOfferEventAsync;",
    expect: "驗證、寫入與稽核事件兩邊一致",
  },
  {
    name: "解除封鎖不檢查擁有者（可以解除別人的封鎖）",
    file: WOFFERS_SRC,
    from: "  if (!row || Number(row.blocker_user_id) !== Number(userId)) return null;",
    to: "  if (!row) return null;",
    expect: "解除封鎖",
  },
  // ⚠️ 刻意**沒有**「解除封鎖接受數字型 ref」這一條：`newBlockToken()` 產生的 token 永遠不是
  // 純數字，所以拿掉那個守衛在**可觀察行為上是等價的**（數字 ref 一樣查不到、一樣 404）。
  // 放進變異集只會得到假 SURVIVED，所以寧可寫明理由。
  {
    name: "moderation 封鎖可以自行解除（停權處分被繞過）",
    file: WOFFERS_SRC,
    from: "    if (String(row.context || \"\") === \"moderation\") {\n      throw offerHttpError(\"這筆封鎖不能自行解除\", 403, \"block_locked\");\n    }",
    to: "    if (false) {\n      throw offerHttpError(\"這筆封鎖不能自行解除\", 403, \"block_locked\");\n    }",
    expect: "解除封鎖",
  },
  {
    name: "封鎖名單不查刊登標題（清單少一個欄位）",
    file: WOFFERS_SRC,
    from: "      const listing = row.listing_id ? await getSelfRowAsync(row.listing_id, { ...options, driver: \"postgres\" }) : null;",
    to: "      const listing = null;",
    expect: "形狀（含刊登標題）",
  },
  {
    name: "後台清單不套 limit 夾限（負數或爆量都照送）",
    file: WOFFERS_SRC,
    from: "  const size = Math.min(100, Math.max(1, Number(opts?.limit) || 50));",
    to: "  const size = Number(opts?.limit) || 50;",
    expect: "後台檢舉清單",
  },
  {
    name: "後台清單多回傳檢舉人（個資外洩）",
    file: WOFFERS_SRC,
    from: "    const rows = (await run(ADMIN_REPORTS_SQL, [size])).rows || [];\n    return { items: rows.map(publicAdminReportView) };",
    to: "    const rows = (await run(ADMIN_REPORTS_SQL, [size])).rows || [];\n    return { items: rows };",
    expect: "後台檢舉清單",
  },
  {
    name: "聯絡方式不檢查角色（第三人也拿得到聯絡方式）",
    file: WOFFERS_SRC,
    from: "    assertContactReadable(role, offer || {}, blocked);",
    to: "    if (!offer) throw offerHttpError(\"找不到這筆提案\", 404, \"offer_not_found\");",
    expect: "聯絡方式",
  },
  {
    name: "聯絡方式不寫稽核事件（事後查不到誰看過）",
    file: WOFFERS_SRC,
    from: "    await writeOfferEventAsync(run, {\n      offerId: offer.id,\n      actorUserId: userId,\n      eventType: \"contact_projection_accessed\",",
    to: "    await (async () => {})({\n      offerId: offer.id,\n      actorUserId: userId,\n      eventType: \"contact_projection_accessed\",",
    expect: "稽核事件",
  },
  // ⚠️ 刻意**沒有**「聯絡方式不檢查封鎖」這一條：`blockOwnerFromOffer()` 會**同時**把提案
  // 終結成 `blocked`，而 `assertContactReadable()` 先檢查 `status !== 'accepted'` ⇒
  // 拿掉封鎖查詢之後錯誤碼與 status 完全一樣（可觀察行為等價）。放著只會得到假 SURVIVED。
  // 「封鎖之後拿不到」這個**契約**仍有一條測試守著（`wish-offers-async.test.js`）。
  {
    name: "樂觀鎖不帶 version（併發時覆蓋別人的變更）",
    file: WOFFERS_SRC,
    from: "     WHERE id = ? AND status = ? AND version = ?`,\n    [toStatus, stamp, stamp, Number(offerId), fromStatus, Number(version)],",
    to: "     WHERE id = ? AND status = ? AND (? IS NOT NULL)`,\n    [toStatus, stamp, stamp, Number(offerId), fromStatus, Number(version)],",
    expect: "樂觀鎖",
  },
  {
    name: "樂觀鎖用 changes 而不是 rowCount（PG 上永遠是 undefined ⇒ 衝突被誤判）",
    file: WOFFERS_SRC,
    from: "  return Number(res?.rowCount) || 0;\n}\n\n// `expirePendingIfDue()` 的 PG 版。",
    to: "  return Number(res?.changes) || 0;\n}\n\n// `expirePendingIfDue()` 的 PG 版。",
    expect: "樂觀鎖",
  },
  {
    name: "接受提案不檢查租客身分（屋主也能接受自己的提案）",
    file: WOFFERS_SRC,
    from: "    const mine = offer && (role === \"tenant\"\n      ? Number(offer.tenant_user_id) === Number(userId)\n      : Number(offer.owner_user_id) === Number(userId));",
    to: "    const mine = Boolean(offer);",
    expect: "拒絕／撤回",
  },
  {
    name: "終結提案不寫事件（事後查不到）",
    file: WOFFERS_SRC,
    from: "  for (const row of rows) {\n    await writeOfferEventAsync(run, {\n      offerId: row.id,",
    to: "  for (const row of []) {\n    await writeOfferEventAsync(run, {\n      offerId: row.id,",
    expect: "封鎖屋主",
  },
  {
    name: "封鎖不建立封鎖列（只終結提案）",
    file: WOFFERS_SRC,
    from: "    const block = await insertUserBlockAsync(run, {",
    to: "    const block = await (async () => null)({",
    expect: "封鎖屋主",
  },
  {
    name: "非 postgres 不回退（SQLite 站會壞）",
    file: WOFFERS_SRC,
    from: "  if (!isPg(options)) return runSqlite();",
    to: "  if (false) return runSqlite();",
    expect: "非 postgres 必須回退",
  },
  {
    name: "投影不套洩漏守衛（只回原始列）",
    file: WOFFERS_SRC,
    from: "    queries.project = (row, viewerId) => publicOfferViewAsync(row, viewerId, {}, options);",
    to: "    queries.project = (row) => row;",
    expect: "分頁、統計、游標兩邊一致",
  },
];

// 租屋分析（`bumpAnalytics`）PG 分支的變異集（v3/test/rental-analytics-async.test.js）。
const RANALYTICS_SRC = "v3/src/rentalAnalyticsAsync.js";
const RANALYTICS_MUTATIONS = [
  {
    name: "累加改成覆蓋（不是 value + n）",
    file: RANALYTICS_SRC,
    from: "      await run(ANALYTICS_UPDATE_SQL, [Number(existing.value || 0) + value, day, key]);",
    to: "      await run(ANALYTICS_UPDATE_SQL, [value, day, key]);",
    expect: "累加",
  },
  {
    name: "UPDATE 的 WHERE 不帶 metric（不同指標會互相覆蓋）",
    file: RANALYTICS_SRC,
    from: "export const ANALYTICS_UPDATE_SQL = \"UPDATE rental_analytics_daily SET value = ? WHERE day = ? AND metric = ?\";",
    to: "export const ANALYTICS_UPDATE_SQL = \"UPDATE rental_analytics_daily SET value = ? WHERE day = ?\";",
    expect: "同一天的不同指標",
  },
  {
    name: "日界線自己算（不用 taipeiDay ⇒ 跨時區會落在不同天）",
    file: RANALYTICS_SRC,
    from: "  const day = taipeiDay(now);",
    to: "  const day = new Date(now instanceof Date ? now.getTime() : Date.now()).toISOString().slice(0, 10);",
    expect: "日界線",
  },
  {
    name: "n 的邊界改成直接 Number（0 會寫 0，與同步版不同）",
    file: RANALYTICS_SRC,
    from: "  const value = Number(n) || 1;",
    to: "  const value = Number(n);",
    expect: "n 的邊界",
  },
  {
    name: "非 postgres 不回退（SQLite 站會壞）",
    file: RANALYTICS_SRC,
    from: "  if (!isPg(options)) return runSqlite();",
    to: "  if (false) return runSqlite();",
    expect: "非 postgres 必須回退",
  },
  {
    name: "寫入失敗時靜默吞掉（fail-open）",
    file: RANALYTICS_SRC,
    from: "    if (!sqliteFallbackAllowed(options, { write })) throw error;\n    return runSqlite();",
    to: "    if (!sqliteFallbackAllowed(options, { write })) return undefined;\n    return runSqlite();",
    expect: "fail-closed",
  },
];

// 租屋通知 prefs 讀取 PG 分支的變異集（v3/test/rental-notify-reads-async.test.js）。
const NPREFS_SRC = "v3/src/rentalNotifyReadsAsync.js";
const NPREFS_MUTATIONS = [
  {
    name: "布林轉換改成 truthy（'0' 會變成 true ⇒ 通知設定反向）",
    file: NPREFS_SRC,
    from: "    lifecycle_reminder: Number(row.lifecycle_reminder) === 1,",
    to: "    lifecycle_reminder: Boolean(row.lifecycle_reminder),",
    expect: "布林轉換",
  },
  {
    name: "沒有設定列時回 null（呼叫端會爆或走錯分支）",
    file: NPREFS_SRC,
    from: "  if (!row) return defaultRentalNotifyPrefs();",
    to: "  if (!row) return null;",
    expect: "預設",
  },
  {
    name: "timezone 空字串不回退（使用者會拿到空時區）",
    file: NPREFS_SRC,
    from: "    timezone: row.timezone || RENTAL_SITE_TZ,",
    to: "    timezone: row.timezone,",
    expect: "落回站台時區",
  },
  {
    name: "非 postgres 不回退（SQLite 站會壞）",
    file: NPREFS_SRC,
    from: "  if (!isPg(options)) return runSqlite();",
    to: "  if (false) return runSqlite();",
    expect: "非 postgres 必須回退",
  },
  {
    name: "寫入失敗時靜默吞掉（fail-open）",
    file: NPREFS_SRC,
    from: "    if (!sqliteFallbackAllowed(options, { write })) throw error;\n    return runSqlite();",
    to: "    if (!sqliteFallbackAllowed(options, { write })) return null;\n    return runSqlite();",
    expect: "fail-closed",
  },
];

// 租屋通知寫入 PG 分支的變異集（v3/test/rental-notify-write-async.test.js）。
const NWRITE_SRC = "v3/src/rentalNotifyWriteAsync.js";
const NWRITE_MUTATIONS = [
  {
    name: "事件寫入拿掉 ON CONFLICT（撞唯一鍵就整筆交易失敗）",
    file: NWRITE_SRC,
    from: " VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING`;",
    to: " VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;",
    expect: "去重",
  },
  {
    name: "遞送寫入拿掉 ON CONFLICT（同通道會重複寫）",
    file: NWRITE_SRC,
    from: "      VALUES (?, ?, ?, ?, 0, ?, '', ?, ?) ON CONFLICT(event_id, channel) DO NOTHING`;",
    to: "      VALUES (?, ?, ?, ?, 0, ?, '', ?, ?)`;",
    expect: "同一事件同一通道",
  },
  {
    name: "不檢查旗標（關閉時照樣發通知）",
    file: NWRITE_SRC,
    from: "  if (!isRentalNotificationsEnabled(flags)) return { emitted: false, reason: \"flag_off\" };",
    to: "  if (false) return { emitted: false, reason: \"flag_off\" };",
    expect: "旗標關閉",
  },
  {
    name: "不檢查事件白名單（未知型別照樣寫）",
    file: NWRITE_SRC,
    from: "  if (!RENTAL_NOTIFY_EVENT_TYPES.includes(eventType)) return { emitted: false, reason: \"unknown_type\" };",
    to: "  if (false) return { emitted: false, reason: \"unknown_type\" };",
    expect: "未知事件型別",
  },
  {
    name: "queueDeliveries 不套 prefs（被關掉的通知照樣排遞送）",
    file: NWRITE_SRC,
    from: "  if (!preferenceAllows(prefs, event.event_type)) {",
    to: "  if (false) {",
    expect: "prefs 關掉",
  },
  {
    name: "通知 payload 不套 PII 過濾（電話會落庫）",
    file: NWRITE_SRC,
    from: "      JSON.stringify(safePayload(payload)), stamp,",
    to: "      JSON.stringify(payload), stamp,",
    expect: "發通知",
  },
  {
    name: "非 postgres 不回退（SQLite 站會壞）",
    file: NWRITE_SRC,
    from: "  if (!isPg(options)) return runSqlite();",
    to: "  if (false) return runSqlite();",
    expect: "非 postgres 必須回退",
  },
  // ⚠️ 刻意**沒有**「PG 上不補唯一索引」這一條：那個迴圈只在**沒有注入 exec** 時才會跑
  // （它要真的 `pgDriver.exec`），離線夾具碰不到，所以放進變異集只會得到假 SURVIVED。
  // 改由 live PG 測試驗證：`ensureRentalNotifyWriteOnce()` 之後那兩條索引必須真的存在。
];

// 使用者讀取（`getUserById`）PG 分支的變異集（v3/test/users-async.test.js）。
const USERS_SRC = "v3/src/usersAsync.js";
const USERS_MUTATIONS = [
  {
    // 第七十批：PG 模式下改密碼只寫本機 SQLite，而登入讀 PG ⇒ 新密碼根本沒生效。
    name: "改密碼只寫本機（PG 站改了密碼仍只能用舊的登入）",
    file: "v3/src/usersAsync.js",
    from: "    await exec(USER_SET_PASSWORD_SQL, [hashPassword(next), id]);",
    to: "    void USER_SET_PASSWORD_SQL; void hashPassword; void next;",
    expect: "改密碼：PG 分支驗的是 PG 的雜湊",
  },
  {
    name: "改密碼不比對目前密碼（任何人都能改）",
    file: "v3/src/usersAsync.js",
    from: "    if (!verifyPassword(currentPassword, user.password_hash)) {\n      throw Object.assign(new Error(\"目前密碼不對\"), { status: 400 });\n    }\n",
    to: "",
    expect: "改密碼：錯誤情境",
  },
  {
    name: "改密碼不擋『新密碼與目前相同』",
    file: "v3/src/usersAsync.js",
    from: "    if (next === String(currentPassword || \"\")) {\n      throw Object.assign(new Error(\"新密碼不能跟目前密碼一樣\"), { status: 400 });\n    }\n",
    to: "",
    expect: "改密碼：錯誤情境",
  },
  // ⚠️ 刻意**沒有**「查不到人回 undefined」這一條：`one()` 本身就保證回 `null`，
  // 所以在它後面加 `|| null` 是**等價的**（拿掉測試照樣過）。那個多餘的守衛已從原始碼移除。
  {
    name: "沒有 id 時照樣查（送出 id = 0 的查詢）",
    file: USERS_SRC,
    // ⚠️ 錨點要含函式簽章那一行：`if (!id) return null;` 在第五十四批之後出現**兩次**
    // （`getUserByIdAsync` 與 `setUserPlanAsync`），只寫那一行的話前置檢查會中止整套變異。
    from: "export async function getUserByIdAsync(userId, options = {}) {\n  const id = Number(userId) || 0;\n  if (!id) return null;",
    to: "export async function getUserByIdAsync(userId, options = {}) {\n  const id = Number(userId) || 0;\n  if (false) return null;",
    expect: "查不到人",
  },
  {
    name: "SQL 不帶 WHERE id（回傳第一個人 ⇒ 權限判斷全錯）",
    file: USERS_SRC,
    from: "export const USER_BY_ID_SQL = \"SELECT * FROM users WHERE id = ?\";",
    to: "export const USER_BY_ID_SQL = \"SELECT * FROM users LIMIT 1\";",
    expect: "查得到人",
  },
  {
    name: "非 postgres 不回退（SQLite 站會壞）",
    file: USERS_SRC,
    from: "  if (!isPg(options)) return runSqlite();",
    to: "  if (false) return runSqlite();",
    expect: "非 postgres 必須回退",
  },
  {
    name: "寫入失敗時靜默吞掉（fail-open）",
    file: USERS_SRC,
    from: "    if (!sqliteFallbackAllowed(options, {})) throw error;\n    return runSqlite();",
    to: "    if (!sqliteFallbackAllowed(options, {})) return null;\n    return runSqlite();",
    expect: "fail-closed",
  },
  {
    name: "已刪除的帳號也算通過驗證",
    file: USERS_SRC,
    from: "  if (!user || isUserDeleted(user)) return null;",
    to: "  if (!user) return null;",
    expect: "verifyUserPassword：對的密碼回那一列",
  },
  // ⚠️ 刻意**沒有**「ensureUser 先查再寫拿掉」那條變異：它是**等價變異**——
  // 夾具與正式庫的 `users.email` 都有唯一約束，INSERT 撞唯一鍵時會走 catch 重讀，
  // 回傳值完全一樣（實測：單獨跑也殺不死）。要留的是下面這條「不回傳新 id」。
  {
    name: "ensureUser 不回傳新 id（INSERT 少了 RETURNING id）",
    file: USERS_SRC,
    from: "  \"INSERT INTO users(email, password_hash, role, plan, created_at) VALUES (?, '', ?, 'free', ?) RETURNING id\";",
    to: "  \"INSERT INTO users(email, password_hash, role, plan, created_at) VALUES (?, '', ?, 'free', ?)\";",
    expect: "ensureUser：不存在就建",
  },
  {
    name: "defaultUserIdAsync 走本機（拿錯 store 的 id）",
    file: USERS_SRC,
    from: "export async function defaultUserIdAsync(options = {}) {\n  return ensureUserAsync(adminEmailForUser(), { role: \"admin\" }, options);\n}",
    to: "export async function defaultUserIdAsync(options = {}) {\n  return defaultUserIdSync();\n}",
    expect: "defaultUserIdAsync：必須在 PG 建帳號",
  },
  {
    name: "touchLastLogin 不夾間隔（每次都重寫）",
    file: USERS_SRC,
    from: "        if (Number.isFinite(prev) && prev > 0 && now - prev < minIntervalMs) return false;",
    to: "        if (false) return false;",
    expect: "touchLastLogin：寫入 PG",
  },
  {
    name: "resumeIdleIfNeededAsync 讀本機（PG 的暫停旗標看不到）",
    file: USERS_SRC,
    from: "  if (!isPg(options)) return resumeIdleIfNeededSync(userId);",
    to: "  return resumeIdleIfNeededSync(userId);",
    expect: "resumeIdleIfNeededAsync：暫停中的會員會被恢復",
  },
  {
    // 第五十二批又找到一個（settingsAsync）：`{ rows, rowCount }` 會被 `for (const row of rows)` 炸掉。
    name: "settingsAsync 的注入式 exec 不經正規化（{rows} 形狀會炸）",
    file: "v3/src/settingsAsync.js",
    from: "  if (options.exec) return asArrayExec(options.exec);",
    to: "  if (options.exec) return options.exec;",
    expect: "resumeIdleIfNeededAsync：暫停中的會員會被恢復",
  },

];

// 個人旗標讀取（loadFlags／loadFlagMap）PG 分支的變異集。
const PFLAGS_SRC = "v3/src/personalFlagsAsync.js";
const PFLAGS_MUTATIONS = [
  {
    name: "loadFlags 查不到時回 null 而不是 emptyFlags()（呼叫端會讀到 undefined）",
    file: PFLAGS_SRC,
    from: "    return one(await exec(FLAGS_BY_USER_POST_SQL, [uid, pid])) || emptyFlags();",
    to: "    return one(await exec(FLAGS_BY_USER_POST_SQL, [uid, pid]));",
    expect: "查不到時回 emptyFlags",
  },
  {
    name: "loadFlags 不帶 post_id（會讀到別筆的旗標）",
    file: PFLAGS_SRC,
    from: "export const FLAGS_BY_USER_POST_SQL = \"SELECT * FROM user_listing_flags WHERE user_id = ? AND post_id = ?\";",
    to: "export const FLAGS_BY_USER_POST_SQL = \"SELECT * FROM user_listing_flags WHERE user_id = ?\";",
    expect: "loadFlags",
  },
  {
    name: "loadFlagMap 的鍵不做 Number（呼叫端用數字查就永遠查不到）",
    file: PFLAGS_SRC,
    from: "    for (const row of (await exec(FLAGS_BY_USER_SQL, [uid])) || []) map.set(Number(row.post_id), row);",
    to: "    for (const row of (await exec(FLAGS_BY_USER_SQL, [uid])) || []) map.set(String(row.post_id), row);",
    expect: "鍵是數字",
  },
  {
    name: "loadFlagMap 不帶 user_id（把所有人的旗標都撈進來）",
    file: PFLAGS_SRC,
    from: "export const FLAGS_BY_USER_SQL = \"SELECT * FROM user_listing_flags WHERE user_id = ?\";",
    to: "export const FLAGS_BY_USER_SQL = \"SELECT * FROM user_listing_flags\";",
    expect: "回 Map",
  },
  {
    name: "uid／pid 為 0 時照樣查（送出無意義的查詢）",
    file: PFLAGS_SRC,
    from: "  if (!uid || !pid) return emptyFlags();",
    to: "  if (false) return emptyFlags();",
    expect: "查不到時回 emptyFlags",
  },
  {
    name: "非 postgres 不回退（SQLite 站會壞）",
    file: PFLAGS_SRC,
    from: "  if (!isPg(options)) return loadFlagsSync(sqliteHandle(), uid, pid) || emptyFlags();",
    to: "  if (false) return loadFlagsSync(sqliteHandle(), uid, pid) || emptyFlags();",
    expect: "非 postgres 必須回退",
  },
];

// 法律文案 PG 分支的變異集（v3/test/legal-copy-async.test.js）。
const LEGALCOPY_SRC = "v3/src/legalCopyAsync.js";
const LEGALCOPY_MUTATIONS = [
  {
    // 文件優先：`settings` 只是 bootstrap 的種子。改成 settings 優先 ⇒ 後台改文案後前端看不到。
    name: "法律文案改成 settings 優先（文件被忽略）",
    file: LEGALCOPY_SRC,
    from: "      const fromDocs = await legalCopyFromDocumentsAsync(options);\n      if (fromDocs?.disclaimer && fromDocs?.privacy) return publicLegalCopy(fromDocs);",
    to: "      const seeded = await getSiteSettingAsync(LEGAL_COPY_KEY, options);\n      if (seeded?.disclaimer && seeded?.privacy) return publicLegalCopy(seeded);",
    expect: "文件優先：settings 存了別的值",
  },
  {
    // 沒有文件時應該回**預設值**（`legalCopyFromDocuments()` 永遠不會回 null）。
    name: "文件讀取例外時回預設值而不是 settings",
    file: LEGALCOPY_SRC,
    from: "    return publicLegalCopy(stored ?? defaultLegalCopy());",
    to: "    return publicLegalCopy(defaultLegalCopy());",
    // ⚠️ 殺手是「例外那條路」的測試，不是「文件不存在」那條：
    // 文件不存在時 `legalCopyFromDocumentsAsync()` 會回預設欄位 ⇒ 根本走不到這一行（等價變異）。
    // 這一條的鑑別力來自**文件讀取丟例外**（模擬文件表還沒補建）時，settings 才是唯一來源。
    expect: "文件讀取丟例外時才走 settings",
  },
  {
    // 寫入只寫一個 store：settings 有、文件沒有 ⇒ 真正生效的那份沒被改到。
    name: "儲存只寫 settings，不同步內容文件",
    file: LEGALCOPY_SRC,
    from: "        await publishDocumentAsync(draft.id, { actorId: 0, now, ...options });",
    to: "        void draft;",
    expect: "saveLegalCopyAsync：合併、兩邊都寫",
  },
  {
    // 本機鏡射拿掉：還沒移植的同步讀者（updateUserProfile → withLegalProfile）會看到舊文案。
    name: "不鏡射本機（同步讀者看到舊文案）",
    file: LEGALCOPY_SRC,
    from: "    try { saveLegalCopySync(next); } catch { /* 本機鏡射失敗不擋 */ }",
    to: "    try { void next; } catch { /* 不鏡射 */ }",
    expect: "saveLegalCopyAsync：合併、兩邊都寫",
  },
  {
    name: "reset 不生效（沿用目前值）",
    file: LEGALCOPY_SRC,
    from: "    const next = src.reset === true ? defaultLegalCopy() : normalizeLegalCopy({ ...current, ...src });",
    to: "    const next = normalizeLegalCopy({ ...current, ...src });",
    expect: "saveLegalCopyAsync：合併、兩邊都寫",
  },
  {
    name: "寫入失敗也回退本機（表面成功、實際寫在本機）",
    file: LEGALCOPY_SRC,
    from: "    if (!sqliteFallbackAllowed(options, write ? { write: true } : {})) throw error;",
    to: "    if (!sqliteFallbackAllowed(options, {})) throw error;",
    expect: "讀取失敗時回退本機",
  },
  // ⚠️ **刻意沒有**「非 postgres 模式也走 PG 分支」這條變異：它是**等價變異**。
  // 這一支的 PG 分支完全由既有的島嶼函式組成（`legalCopyFromDocumentsAsync`／
  // `getSiteSettingAsync`／`createDraftAsync`…），而那些函式自己就會依 driver 分派；
  // 把 `withFallback()` 的 `if (!isPg(options)) return runSqlite();` 拿掉之後，
  // SQLite 模式仍然一路走到同一批同步函式（實測：整個測試檔 8 條全綠，一條都不紅）。
  // 依紀律「等價變異要移除並寫下理由，不要硬追」。
];

// 「注入式 exec 形狀」的變異集（2026-09-28，第五十一批）。
//
// 背景：`contentDocumentsAsync.withFallbackTx()` 直接把 `options.exec` 轉送給 runner，而那個
// 模組的 runner 吃**裸陣列** ⇒ 呼叫端照 `crmOutboxAsync` 慣例傳 `{ rows, rowCount }` 時，
// `nextVersionAsync()` 把整個物件當成「沒有資料列」，版本算成 1 而撞唯一鍵（live PG 測試抓到）。
// 這一輪把同樣的洞在其它模組一併補上，並各留一條「還原這個洞」的變異。
const BUDGET_MUTATIONS = [
  {
    name: "budgetGuardAsync 讀取路徑不經 rowsOf 正規化（{rows} 形狀會靜默少讀）",
    file: "v3/src/budgetGuardAsync.js",
    from: "    if (options.exec) return await runPostgres(injectedExec(options.exec));\n    const pgDriver = options.pgDriver || (await sharedPgDriver());\n    await ensureBudgetStoreOnce(pgDriver, options.sqliteHandle);\n    const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;",
    to: "    if (options.exec) return await runPostgres(options.exec);\n    const pgDriver = options.pgDriver || (await sharedPgDriver());\n    await ensureBudgetStoreOnce(pgDriver, options.sqliteHandle);\n    const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;",
    expect: "注入式 exec 的形狀不影響結果",
  },
  {
    name: "budgetGuardAsync 寫入路徑不經 rowsOf 正規化（{rows} 形狀會靜默少讀）",
    file: "v3/src/budgetGuardAsync.js",
    from: "    if (options.exec) return await runPostgres(injectedExec(options.exec));\n    const pgDriver = options.pgDriver || (await sharedPgDriver());\n    await ensureBudgetStoreOnce(pgDriver, options.sqliteHandle);\n    return await pgDriver.withTransaction(async (client) => {",
    to: "    if (options.exec) return await runPostgres(options.exec);\n    const pgDriver = options.pgDriver || (await sharedPgDriver());\n    await ensureBudgetStoreOnce(pgDriver, options.sqliteHandle);\n    return await pgDriver.withTransaction(async (client) => {",
    expect: "注入式 exec 的形狀不影響結果",
  },
];

// 第六十六批：補抓 worker 的 driver-aware 收斂（bundle 的形狀、queue 管理、擁有權、prep 寫入）。
const ENRICH_QUEUE_SRC = "v3/src/listingEnrichQueue.js";
const ENRICH_WATCHER_SRC = "v3/src/watcher.js";
const ENRICH_FACADE_SRC = "v3/src/listingEnrichQueueAsync.js";
const ENRICHQ_MUTATIONS = [
  {
    name: "擁有權判斷回到同步版（PG 模式下本機沒有那一列就判成 superseded）",
    file: ENRICH_QUEUE_SRC,
    from: "    if (!(await queueOwnsRun(enrichQueue, conn, job))) {\n      await finishJobDriver(conn, job, { status: \"queued\", error: \"superseded\", errorClass: \"\" });",
    to: "    if (!jobStillOwnsRun(conn, job)) {\n      await finishJobDriver(conn, job, { status: \"queued\", error: \"superseded\", errorClass: \"\" });",
    expect: "擁有權判斷走 bundle",
  },
  {
    name: "bundle 在 PG 模式仍提供同步變體（死碼，看不出走哪個 store）",
    file: ENRICH_WATCHER_SRC,
    from: "  if (driver === \"postgres\") return base;",
    to: "  if (false) return base;",
    expect: "PG 模式只提供 async 變體",
  },
  {
    name: "facade 少了 upsertPrep（worker 的 prep 寫入沒有 driver-aware 路徑）",
    file: ENRICH_FACADE_SRC,
    from: "    upsertPrep: (c, args) => upsertPrepRowAsync(useConn(c), args, opts),\n",
    to: "",
    expect: "facade：upsertPrep",
  },
  {
    name: "沒有 bundle 時不補 facade（queue 管理退回同步函式）",
    file: ENRICH_QUEUE_SRC,
    from: '  const { listingEnrichQueueFacade } = await import("./listingEnrichQueueAsync.js");\n  return listingEnrichQueueFacade(conn);',
    to: "  return null;",
    expect: "bundle 缺席時動態載入 facade",
  },
  {
    name: "listingEnrichQueueAsync 讀取路徑不轉回裸陣列（{rows} 形狀會拿到全 0 統計）",
    file: "v3/src/listingEnrichQueueAsync.js",
    from: "    if (options.exec) {\n      const injected = options.exec;\n      return await runPostgres(async (sql, params = []) => {\n        const raw = await injected(sql, params);\n        return Array.isArray(raw) ? raw : (raw?.rows || []);\n      });\n    }",
    to: "    if (options.exec) return await runPostgres(options.exec);",
    expect: "注入式 exec 的形狀不影響結果",
  },
];

const SIMILARITY_MUTATIONS = [
  {
    name: "listingSimilarityAsync 不經 rowsOf 正規化（{rows} 形狀會少掉建議／洞察列）",
    file: "v3/src/listingSimilarityAsync.js",
    from: "    if (options.exec) return await runPostgres(injectedExec(options.exec));",
    to: "    if (options.exec) return await runPostgres(options.exec);",
    expect: "注入式 exec 的形狀不影響結果",
  },
];

// 登入讀 PG（`verifyLoginAsync`）的變異集（v3/test/auth-member-async.test.js）。
const AUTHMEMBER_SRC = "v3/src/auth.js";
// （`USERS_SRC` 已在上面（USERS_MUTATIONS）宣告，這裡共用同一個常數。）
const AUTHMEMBER_MUTATIONS = [
  {
    name: "登入的 PG 分支改讀本機（別節點建立的成員登不進去）",
    file: AUTHMEMBER_SRC,
    from: "  if ((options.driver || resolveDbDriver()) !== \"postgres\") return verifyLogin(email, password, { keys, now });",
    to: "  return verifyLogin(email, password, { keys, now });",
    expect: "密碼正確：PG 才有的帳號也登得進去",
  },
  {
    name: "登入不比對雜湊（任何密碼都過）",
    file: USERS_SRC,
    from: "  if (user.password_hash && verifyPassword(password, user.password_hash)) return user;",
    to: "  if (user.password_hash) return user;",
    expect: "密碼錯誤／查無此人",
  },
  {
    name: "登入不擋未驗證信箱",
    file: AUTHMEMBER_SRC,
    // 錨點要含下一行（同步版與 async 版各有一處同樣的判斷）。
    from: "  const hashed = await verifyUserPasswordAsync(key, pass, options);\n  if (hashed) {\n    if (!isEmailVerified(hashed)) {",
    to: "  const hashed = await verifyUserPasswordAsync(key, pass, options);\n  if (hashed) {\n    if (false) {",
    expect: "未驗證信箱",
  },
];

// 閒置恢復 async 版的變異集（v3/test/idle-verify.test.js）。
const IDLEPAUSE_MUTATIONS = [
  {
    name: "applyIdleResumeAsync 不判斷是否暫停（每個人都被恢復＋arm）",
    file: "v3/src/idlePause.js",
    from: "  const current = typeof getSettings === \"function\" ? await getSettings(uid) : null;\n  if (!uid || !shouldResumeIdle(current)) {",
    to: "  const current = typeof getSettings === \"function\" ? await getSettings(uid) : null;\n  if (!uid) {",
    expect: "applyIdleResumeAsync 與同步版逐欄相同",
  },
  {
    name: "applyIdleResumeAsync 不寫恢復旗標（暫停狀態留著）",
    file: "v3/src/idlePause.js",
    from: "  let settings = typeof saveSettings === \"function\" ? await saveSettings(uid, idleResumeFlags()) : current;",
    to: "  let settings = current;",
    expect: "applyIdleResumeAsync 與同步版逐欄相同",
  },
];

// 註冊確認／忘記密碼／分享事件（第五十三批）的變異集。
const VERIFY_DDL = "v3/src/emailVerifyAsync.js";
const FORGOT_SRC = "v3/src/forgotPassword.js";
const SHARE_SRC = "v3/src/rentalShareGrowth.js";
const VERIFY_MUTATIONS = [
  {
    name: "確認連結不檢查「已用過」（同一個連結可以重複開通）",
    file: VERIFY_DDL,
    from: "  if (String(row.verify_used_at || \"\").trim() || Number(row.email_verified) === 1) {",
    to: "  if (false) {",
    expect: "已用過／已驗證",
  },
  {
    name: "確認連結不檢查過期",
    file: VERIFY_DDL,
    from: "  if (Number.isFinite(exp) && exp <= now) {",
    to: "  if (false) {",
    expect: "過期：410 expired",
  },
  {
    name: "確認連結空字串也放行（少了 missing 守衛）",
    file: VERIFY_DDL,
    from: "  if (!key) throw httpError(\"找不到這個開通連結\", 404, \"missing\");",
    to: "  if (!key) return null;",
    expect: "找不到：404 missing",
  },
  {
    name: "確認成功卻不寫回旗標（連結可以一直用）",
    file: VERIFY_DDL,
    from: "    await exec(USER_CONFIRM_VERIFY_SQL, [usedAt, Number(row.id) || 0]);",
    to: "    void usedAt;",
    expect: "成功：回那一列",
  },
];
const FORGOT_MUTATIONS = [
  {
    // 這三個回呼少了 await，`user` 會是 Promise ⇒ 靜默當成「查無此人」。
    name: "注入回呼不 await（PG 的 findUser 回 Promise ⇒ 靜默查無此人）",
    file: FORGOT_SRC,
    from: "  const user = await findUser(key);",
    to: "  const user = findUser(key);",
    expect: "寄信成功：臨時密碼寫進 PG",
  },
  {
    name: "寄信失敗不還原舊雜湊（使用者被鎖在外面）",
    file: FORGOT_SRC,
    from: "      await restoreHash(user.id, previousHash);",
    to: "      void previousHash;",
    expect: "寄信失敗：舊雜湊要寫回去",
  },
  {
    name: "沒設定 SMTP 也先改密碼",
    file: FORGOT_SRC,
    from: "  if (!mailReady()) {",
    to: "  if (false) {",
    expect: "沒設定 SMTP：503",
  },
];
const SHARE_EVENT_MUTATIONS = [
  {
    name: "分享事件不做去重（同一天同訪客一直記）",
    file: SHARE_SRC,
    from: "  } else if (type === \"view\") {\n    const dup = (await exec(SHARE_DUP_BY_VISITOR_SQL, [valid, type, hash, since]))[0] || null;\n    if (dup) return { recorded: false, reason: \"deduped\", is_bot: bot };",
    to: "  } else if (type === \"view\") {\n    const dup = null;\n    if (dup) return { recorded: false, reason: \"deduped\", is_bot: bot };",
    expect: "view：去重、bot 標記、速率限制",
  },
  {
    name: "分享事件不驗 token 是否存在（偽造的也能記）",
    file: SHARE_SRC,
    from: "  const valid = validRow?.public_token ? String(validRow.public_token) : \"\";\n  if (!valid) throw rentalNotifyHttpError(\"找不到分享\", 404, \"share_not_found\");",
    to: "  const valid = validRow?.public_token ? String(validRow.public_token) : token;",
    expect: "政策守衛：偽造 token",
  },
  {
    name: "分享事件不擋公開來源的轉換事件",
    file: SHARE_SRC,
    // 錨點必須一路含到 async 版才有的那一行（`validRow`），否則同步版那一處也會命中。
    from: "  if (source === \"public\" && !PUBLIC_SHARE_EVENT_TYPES.includes(type)) {\n    throw rentalNotifyHttpError(\"無法記錄轉換\", 403, \"share_conversion_forbidden\");\n  }\n  if (source === \"server\" && !CONVERSION_SHARE_EVENT_TYPES.includes(type)) {\n    throw rentalNotifyHttpError(\"無法記錄\", 404, \"share_not_found\");\n  }\n  const validRow = (await exec(SHARE_TOKEN_LOOKUP_SQL, [token]))[0] || null;",
    to: "  if (false) {\n    throw rentalNotifyHttpError(\"無法記錄轉換\", 403, \"share_conversion_forbidden\");\n  }\n  if (source === \"server\" && !CONVERSION_SHARE_EVENT_TYPES.includes(type)) {\n    throw rentalNotifyHttpError(\"無法記錄\", 404, \"share_not_found\");\n  }\n  const validRow = (await exec(SHARE_TOKEN_LOOKUP_SQL, [token]))[0] || null;",
    expect: "政策守衛：偽造 token",
  },
  {
    name: "分享事件不寫 analytics（計數永遠 0）",
    file: SHARE_SRC,
    from: "  if (typeof bump === \"function\") await bump(bot ? `share_${type}_bot` : `share_${type}`, now);",
    to: "  void bump;",
    expect: "signup 轉換：落地列與 analytics",
  },
];

// 後台會員管理（第五十四批）的變異集。
const ADMINMEMBERS_SRC = "v3/src/adminMembersAsync.js";
const ADMINMEMBERS_MUTATIONS = [
  {
    // 第七十一批（`GET /api/me`）：自主刊登數原本讀本機 ⇒ PG 站永遠顯示 0 筆。
    name: "自主刊登數改讀本機（PG 站顯示 0 筆）",
    file: "v3/src/adminMembersAsync.js",
    from: "  if (!isPg(options)) return countOpenSelfListingsSync(uid);\n  const exec = await execFor(options);",
    to: "  if (true || !isPg(options)) return countOpenSelfListingsSync(uid);\n  const exec = await execFor(options);",
    expect: "PG 分支數的是 PG 的列",
  },
  {
    name: "GET /api/me 的自主刊登數改回同步版",
    file: "v3/src/server.js",
    from: "    open_self_listings: session?.userId ? await countOpenSelfListingsAsync(session.userId) : 0,",
    to: "    open_self_listings: session?.userId ? countOpenSelfListings(session.userId) : 0,",
    expect: "GET /api/me 走 PG 島嶼",
  },
  {
    name: "GET /api/me 的會員欄位改回同步版",
    file: "v3/src/server.js",
    from: "  const user = session?.userId ? await getUserByIdAsync(session.userId) : null;",
    to: "  const user = session?.userId ? getUserById(session.userId) : null;",
    expect: "GET /api/me 走 PG 島嶼",
  },
  {
    name: "後台列表不讀 PG 的會員設定（通知間隔永遠是預設值）",
    file: ADMINMEMBERS_SRC,
    from: "    getSettingsAsync(user.id, options),",
    to: "    Promise.resolve({}),",
    expect: "列表：PG 才有的會員",
  },
  {
    name: "後台列表不數關注（watchCount 永遠 0）",
    file: ADMINMEMBERS_SRC,
    from: "    countWatchedAsync(user.id, options),",
    to: "    Promise.resolve(0),",
    expect: "列表：PG 才有的會員",
  },
  {
    name: "後台列表不數自主刊登（listingCount 永遠 0）",
    file: ADMINMEMBERS_SRC,
    from: "    countOpenSelfListingsAsync(user.id, options),",
    to: "    Promise.resolve(0),",
    expect: "列表：PG 才有的會員",
  },
  {
    name: "停權不寫 PG（只回投影，看起來成功）",
    file: "v3/src/usersAsync.js",
    from: "    await exec(USER_DELETE_SQL, [now, who, String(reason || \"\").slice(0, 2000), String(reasonCode || \"\").slice(0, 40), id]);",
    to: "    void now;",
    expect: "刪除／復原：守衛訊息相同",
  },
  {
    name: "復原不寫 PG",
    file: "v3/src/usersAsync.js",
    from: "  await run(options, async (exec) => { await exec(USER_RESTORE_SQL, [id]); }, () => restoreUserSync(sqliteHandle(), id));",
    to: "  await run(options, async () => {}, () => restoreUserSync(sqliteHandle(), id));",
    expect: "刪除／復原：守衛訊息相同",
  },
  {
    name: "刪除不擋管理員帳號",
    file: "v3/src/members.js",
    from: "  if (user.role === \"admin\") {\n    const err = new Error(\"不能刪除管理員帳號\");",
    to: "  if (false) {\n    const err = new Error(\"不能刪除管理員帳號\");",
    expect: "刪除／復原：守衛訊息相同",
  },
  {
    name: "改方案不寫 PG",
    file: "v3/src/usersAsync.js",
    from: "  await run(options, async (exec) => { await exec(USER_SET_PLAN_SQL, [next, id]); },",
    to: "  await run(options, async () => {},",
    expect: "改方案：方案落地",
  },
  // ⚠️ 刻意**沒有**「不重設 intervalMinutes」那條：把值改成 `undefined` 是**等價變異**——
  // 讀取端（`settingsAsync`）在 `intervalAdminSet === false` 時就用方案預設值算，
  // 所以有沒有寫入那個數字，投影出來都一樣（實測：單獨跑也殺不死）。
  // 真正有鑑別力的是下面這條「不把 intervalAdminSet 設回 false」。
  {
    name: "改方案不把 intervalAdminSet 設回 false（手動間隔蓋掉方案預設）",
    file: ADMINMEMBERS_SRC,
    from: "    settingsPatch.intervalMinutes = planIntervalMinutes(fresh.plan);\n    settingsPatch.intervalAdminSet = false;",
    to: "    settingsPatch.intervalMinutes = planIntervalMinutes(fresh.plan);\n    settingsPatch.intervalAdminSet = true;",
    expect: "改方案：方案落地",
  },
];

const WATCHLIMITS_MUTATIONS = [
  {
    // 這一條真的抓到過：模組的 runner 約定是**裸陣列**，但 callback 一度寫成 `(...).rows`
    // ⇒ 永遠回 0（額度算成 0 筆，會員可以無限加入關注）。
    name: "countWatchedAsync 把裸陣列當 {rows}（永遠回 0）",
    file: "v3/src/watchLimitsAsync.js",
    from: "  return run(options, async (exec) => Number(one(await exec(WATCHED_COUNT_SQL, [uid]))?.n) || 0,",
    to: "  return run(options, async (exec) => Number(one((await exec(WATCHED_COUNT_SQL, [uid])).rows)?.n) || 0,",
    expect: "PG 與同步版相同：已確認離線的不佔額度",
  },
  {
    // 額度的定義：已確認離線的物件不佔額度。拿掉 EXISTS 之後兩邊會一起變鬆，
    // 所以殺手是「絕對值」那句（`sync === 2` 的前提），不是 parity。
    name: "額度不排除已確認離線的物件（額度算太鬆）",
    file: "v3/src/watchLimits.js",
    from: "           AND EXISTS (\n             SELECT 1 FROM listings l\n             WHERE l.post_id = f.post_id\n               AND IFNULL(l.offline_confirmed, 0) = 0\n           )`;",
    to: "           AND 1 = 1`;",
    expect: "PG 與同步版相同：已確認離線的不佔額度",
  },
  {
    name: "uid 0 不早退（送出一句 user_id = 0 的查詢）",
    file: "v3/src/watchLimitsAsync.js",
    from: "  if (!uid) return 0;",
    to: "  if (false) return 0;",
    expect: "PG 與同步版相同：已確認離線的不佔額度",
  },
];

// Ops 遞送 worker ＋ 傳輸佇列（第五十七批）的變異集。
const OUTBOX_SRC = "v3/src/feedbackOutboxAsync.js";
const OPSDL_SRC = "v3/src/opsDeliveryAsync.js";
const OUTBOXASYNC_MUTATIONS = [
  {
    name: "claim 不用 FOR UPDATE SKIP LOCKED（多節點會重複認領）",
    file: OUTBOX_SRC,
    from: "      LIMIT $3\n      FOR UPDATE SKIP LOCKED\n   )\n   RETURNING *`;",
    to: "      LIMIT $3\n   )\n   RETURNING *`;",
    expect: "原子認領",
  },
  {
    // 兩段式（先 SELECT 候選、再 UPDATE 認領）在 PG 上有窗口：SELECT 的鎖一結束就放掉，
    // 另一個 worker 會看到同一批還是 pending ⇒ 重複認領（live 併發測試實測 30 筆被認領 31 次）。
    name: "claim 改回兩段式（先查候選、再認領）＝重複認領",
    file: OUTBOX_SRC,
    from: "  return withFallback(options, async (exec) => {\n    const rows = (await exec(CLAIM_OUTBOX_SQL, [nowIso, staleBefore, cap])).rows;\n    return rows.map((row) => ({ ...row, attempts: Number(row.attempts) || 0 }));\n  }, () => claimOutboxBatchSync(sqliteHandle(), { limit, now, staleMs }), { write: true });",
    to: "  return withFallback(options, async (exec) => {\n    const candidates = (await exec(CLAIM_OUTBOX_SQL, [nowIso, staleBefore, cap])).rows;\n    const ids = candidates.map((row) => Number(row.id));\n    const rows = (await exec(CLAIM_OUTBOX_SQL, [nowIso, staleBefore, cap])).rows.filter((row) => ids.includes(Number(row.id)));\n    return rows.map((row) => ({ ...row, attempts: Number(row.attempts) || 0 }));\n  }, () => claimOutboxBatchSync(sqliteHandle(), { limit, now, staleMs }), { write: true });",
    expect: "原子認領",
  },
  {
    name: "claim 忽略 stale 視窗（crash 留下的 sending 永遠救不回來）",
    file: OUTBOX_SRC,
    from: "  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : now) - staleMs));\n  const cap = Math.max(1, Math.min(Number(limit) || 20, 200));",
    to: "  const staleBefore = nowIso;\n  const cap = Math.max(1, Math.min(Number(limit) || 20, 200));",
    expect: "原子認領",
  },
  {
    name: "失敗次數門檻差一（少送一次就進 dead-letter）",
    file: OUTBOX_SRC,
    from: "  if (attempts >= max) {",
    to: "  if (attempts > max) {",
    expect: "markOutboxFailureAsync",
  },
  {
    name: "stats 不把 bigint 轉數字（total 變成字串串接）",
    file: OUTBOX_SRC,
    from: "      out.total += Number(row.n) || 0;",
    to: "      out.total += row.n;",
    expect: "outboxStatsAsync",
  },
  {
    name: "精簡 payload 不保留 sha256（事後無法追查）",
    file: OUTBOX_SRC,
    from: "      const slim = JSON.stringify({ compacted: true, feedback_id: row.feedback_id, payload_sha256: payloadHashHex(row.payload) });",
    to: "      const slim = JSON.stringify({ compacted: true, feedback_id: row.feedback_id });",
    expect: "compactSentOutboxPayloadsAsync",
  },
  {
    // 停止鍵是**原生字串**：用 truthy 判斷會讓 "0" 也被當成停止（永遠送不出去）。
    name: "停止鍵用 truthy 判斷（'0' 也被當成停止）",
    file: OPSDL_SRC,
    from: "    return String(row?.value || \"\") === \"1\";",
    to: "    return Boolean(row?.value);",
    expect: "只有原始字串 '1' 算停止",
  },
  {
    name: "停止鍵用 JSON.stringify 寫入（開關永遠失效）",
    file: OPSDL_SRC,
    from: "    await exec(STOP_UPSERT_SQL, [OPS_DELIVERY_STOP_KEY, value]);",
    to: "    await exec(STOP_UPSERT_SQL, [OPS_DELIVERY_STOP_KEY, JSON.stringify(value)]);",
    expect: "UPSERT 原始字串",
  },
  {
    name: "deliveryControlAsync 的 effective 忽略本地停止",
    file: OPSDL_SRC,
    from: "    effective: Boolean(envAllowed && configured && !localStopped),",
    to: "    effective: Boolean(envAllowed && configured),",
    expect: "deliveryControlAsync：欄位與同步版逐欄對應",
  },
  {
    name: "worker 的 store 少了 isStopped（停止鍵形同虛設）",
    file: OPSDL_SRC,
    from: "    isStopped: () => isLocalDeliveryStoppedAsync(options),\n",
    to: "",
    expect: "本地停止鍵為 '1' 時完全不出手",
  },
];

// 回饋（feedback）PG 島嶼的變異集（第五十八批）。
const FEEDBACKASYNC_SRC = "v3/src/feedbackAsync.js";
const FEEDBACKASYNC_MUTATIONS = [
  {
    // 不變式：transaction 失敗時**不能**吞掉——否則會留下「回饋進去了、事件沒進去」的半套狀態，
    // 而那個事件是 Ops 唯一的來源。
    name: "交易失敗時吞掉錯誤、回 ok（半套狀態被當成成功）",
    file: FEEDBACKASYNC_SRC,
    from: "    if (!sqliteFallbackAllowed(options, { write: true })) throw error;\n    return createFeedbackWithOutboxSync(sqliteHandle(), userId, input);",
    to: "    return { ok: true, id: 0 };",
    expect: "不變式：outbox 寫入失敗時",
  },
  {
    name: "honeypot 不擋（機器人可以把內容塞進來）",
    file: FEEDBACKASYNC_SRC,
    from: "  if (String(input?.website || input?.hp || \"\").trim()) return { ok: true, id: 0 };",
    to: "  if (false) return { ok: true, id: 0 };",
    expect: "honeypot",
  },
  {
    name: "太短的內容也放行",
    file: FEEDBACKASYNC_SRC,
    from: "  if (body.length < FEEDBACK_BODY_MIN) throw httpError(`請多寫一點（至少 ${FEEDBACK_BODY_MIN} 個字）`);",
    to: "  if (false) throw httpError(`請多寫一點（至少 ${FEEDBACK_BODY_MIN} 個字）`);",
    expect: "內容驗證與洪水限制",
  },
  {
    name: "洪水限制不看「剛剛才送過」（可以連送）",
    file: FEEDBACKASYNC_SRC,
    from: "  if (last && nowMs(now) - Date.parse(last.created_at) < FEEDBACK_MIN_GAP_MS) {",
    to: "  if (false) {",
    expect: "內容驗證與洪水限制",
  },
  {
    name: "統計不把 bigint 轉數字（total 變字串）",
    file: FEEDBACKASYNC_SRC,
    from: "        out.total += Number(row.n) || 0;",
    to: "        out.total += row.n;",
    expect: "統計：狀態／類型白名單",
  },
  {
    name: "列表不 join users（後台看不到 email／nickname）",
    file: FEEDBACKASYNC_SRC,
    from: "export const FEEDBACK_LIST_SQL = `SELECT f.*, COALESCE(u.email, '') AS __email, COALESCE(u.nickname, '') AS __nickname\n   FROM feedback f LEFT JOIN users u ON u.id = f.user_id`;",
    to: "export const FEEDBACK_LIST_SQL = `SELECT f.*, '' AS __email, '' AS __nickname FROM feedback f`;",
    expect: "後台列表：篩選、排序",
  },
  {
    name: "備註不截斷（可以塞爆資料表）",
    file: FEEDBACKASYNC_SRC,
    from: "      args.push(String(patch.admin_note || \"\").trim().slice(0, FEEDBACK_NOTE_MAX));",
    to: "      args.push(String(patch.admin_note || \"\").trim());",
    expect: "改狀態／備註",
  },
  {
    name: "更新後重讀不 join users（回傳少了 email）",
    file: FEEDBACKASYNC_SRC,
    from: "    const next = one((await exec(FEEDBACK_BY_ID_JOINED_SQL, [Number(row.id)])).rows);",
    to: "    const next = one((await exec(FEEDBACK_BY_ID_SQL, [Number(row.id)])).rows);",
    expect: "改狀態／備註",
  },
];

// Ops 反向指令（第五十九批）的變異集。
const SITECMD_SRC = "v3/src/siteCommandApplyAsync.js";
const SITECMD_MUTATIONS = [
  {
    name: "本地停止鍵用 truthy 判斷（'0' 也被當成停止）",
    file: SITECMD_SRC,
    from: "    return String(row?.value || \"\") === \"1\";",
    to: "    return Boolean(row?.value);",
    expect: "驗章與開關",
  },
  {
    name: "停止鍵用 JSON.stringify 寫入（開關永遠失效）",
    file: SITECMD_SRC,
    from: "    await exec(STOP_UPSERT_SQL, [REMOTE_CS_STOP_KEY, value]);",
    to: "    await exec(STOP_UPSERT_SQL, [REMOTE_CS_STOP_KEY, JSON.stringify(value)]);",
    expect: "驗章與開關",
  },
  {
    name: "不驗簽章（任何人送指令都會被套用）",
    file: SITECMD_SRC,
    from: "  if (!verified.ok) return { httpStatus: 401, body: { apply_state: \"rejected\", reason: \"bad_signature\" } };",
    to: "  if (false) return { httpStatus: 401, body: { apply_state: \"rejected\", reason: \"bad_signature\" } };",
    expect: "驗章與開關",
  },
  {
    name: "不檢查 command_id 與簽章帶的 deliveryId 是否一致",
    file: SITECMD_SRC,
    from: "  if (String(parsed.command_id || \"\") !== String(verified.deliveryId || \"\")) {",
    to: "  if (false) {",
    expect: "格式錯誤",
  },
  {
    name: "不做冪等（同一組 idempotency_key 會再套用一次）",
    file: SITECMD_SRC,
    from: "  const existing = one(await exec(INBOX_FIND_SQL, [commandId, idem]));\n  if (existing) {",
    to: "  const existing = null;\n  if (existing) {",
    expect: "套用 feedback.patch_handling",
  },
  {
    name: "被拒絕的指令不寫 inbox（Ops 看不到失敗）",
    file: SITECMD_SRC,
    from: "      await exec(INBOX_INSERT_SQL, [commandId, idem, kind, JSON.stringify(command.payload || {}), applyState, JSON.stringify({ reason }), ts, null]);",
    to: "      void applyState;",
    expect: "被拒絕的指令",
  },
  {
    name: "空 patch 也放行",
    file: SITECMD_SRC,
    from: "    if (payload.handling_state == null && payload.status == null && payload.admin_note == null) {",
    to: "    if (false) {",
    expect: "被拒絕的指令",
  },
  {
    name: "crm.add_note 少了 contact_id 也放行",
    file: SITECMD_SRC,
    from: "    if (!contactId) throw reject(\"rejected\", \"missing_contact_id\", 400);",
    to: "    if (false) throw reject(\"rejected\", \"missing_contact_id\", 400);",
    expect: "crm.add_note",
  },
];

// 來源歷史（第六十一批）的變異集。
const SRCHIST_MUTATIONS = [
  {
    name: "來源歷史不疊加個人旗標（個人化欄位全空）",
    file: "v3/src/sourceHistoryAsync.js",
    from: "    const flagMap = await loadFlagMapAsync(userId, options);\n    return overlayRowsPersonal(rows, flagMap);",
    to: "    return rows;",
    expect: "個人化欄位相同",
  },
  {
    name: "來源歷史排序反過來（舊的排前面）",
    file: "v3/src/sourceHistoryAsync.js",
    from: "   FROM listings WHERE source_key = ? ORDER BY last_seen_at DESC`;",
    to: "   FROM listings WHERE source_key = ? ORDER BY last_seen_at ASC`;",
    expect: "由新到舊",
  },
  {
    name: "來源歷史不篩 source_key（會列出所有物件）",
    file: "v3/src/sourceHistoryAsync.js",
    from: "   FROM listings WHERE source_key = ? ORDER BY last_seen_at DESC`;",
    to: "   FROM listings WHERE 1=1 ORDER BY last_seen_at DESC`;",
    expect: "只列同一個 source_key",
  },
];

// 個人資料更新（第六十二批）的變異集。
const PROFILEASYNC_SRC = "v3/src/profileAsync.js";
const PROFILEASYNC_MUTATIONS = [
  {
    name: "個人資料更新不擋 email 變更（可以換掉註冊信箱）",
    file: PROFILEASYNC_SRC,
    from: "    if (next && next !== cur) throw httpError(\"註冊 Email 不能更改\", 400);",
    to: "    if (false) throw httpError(\"註冊 Email 不能更改\", 400);",
    expect: "驗證：email 不可改",
  },
  {
    name: "個人資料更新不驗頭像 URL（可以塞任意網址）",
    file: PROFILEASYNC_SRC,
    from: "  const avatar = has(\"avatar_url\") ? mediaUrl(input.avatar_url, \"頭像\") : String(row.avatar_url || \"\");",
    to: "  const avatar = has(\"avatar_url\") ? String(input.avatar_url || \"\") : String(row.avatar_url || \"\");",
    expect: "驗證：email 不可改",
  },
  {
    name: "個人資料更新不驗聯絡 Email",
    file: PROFILEASYNC_SRC,
    from: "    if (!ok) throw httpError(\"聯絡 Email 格式不對\", 400);",
    to: "    if (false) throw httpError(\"聯絡 Email 格式不對\", 400);",
    expect: "驗證：email 不可改",
  },
  {
    name: "沒帶到的欄位也一起清空（沿用舊值的規則失效）",
    file: PROFILEASYNC_SRC,
    from: "  const home = has(\"home_address\") ? cleanLine(input.home_address, 120) : String(row.home_address || \"\");",
    to: "  const home = has(\"home_address\") ? cleanLine(input.home_address, 120) : \"\";",
    expect: "只改帶到的欄位",
  },
  {
    name: "找不到會員不回 404（回 undefined 讓呼叫端爆掉）",
    file: PROFILEASYNC_SRC,
    from: "  if (!row) throw httpError(\"找不到這個會員\", 404);",
    to: "  if (!row) return null;",
    expect: "找不到會員 404",
  },
];

const testFile = process.argv[2] || "v3/test/reject-match-async.test.js";
const asJson = process.argv.includes("--json");
// --only=<子字串>：只跑名稱含該子字串的變異（除錯用）。
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.slice("--only=".length) : "";

// 被中斷時一定要把原始碼還原——第一版沒有這段，SIGTERM 之後原始碼停在「已變異」的狀態，
// 依測試檔挑變異集。預設是 reject-match；稽核可視性用另一組。
const MUTATIONS = /profile-async/.test(testFile) ? PROFILEASYNC_MUTATIONS
  : /source-history-async/.test(testFile) ? SRCHIST_MUTATIONS
  : /site-command-apply-async/.test(testFile) ? SITECMD_MUTATIONS
  : /feedback-async/.test(testFile) ? FEEDBACKASYNC_MUTATIONS
  : /feedback-outbox-async/.test(testFile) ? OUTBOXASYNC_MUTATIONS
  : /admin-members-async/.test(testFile) ? ADMINMEMBERS_MUTATIONS
  : /notify-queue-parity/.test(testFile) ? NOTIFYQ_MUTATIONS
  : /site-reset-async/.test(testFile) ? SITERESET_MUTATIONS
  : /register-async/.test(testFile) ? REGISTER_MUTATIONS
  : /commute-snapshot-async/.test(testFile) ? COMMUTE_MUTATIONS
  : /route-cache-async/.test(testFile) ? ROUTECACHE_MUTATIONS
  : /admin-maps-demo-async/.test(testFile) ? MAPSDEMO_MUTATIONS
  : /demand-aggregate-async/.test(testFile) ? DEMANDAGG_MUTATIONS
  : /self-listing-match-async/.test(testFile) ? SELFLISTING_MATCH_MUTATIONS
  : /self-listing-matches-async/.test(testFile) ? SELFLISTING_MATCHES_MUTATIONS
  : /self-listing-copy-async/.test(testFile) ? COPYSELF_MUTATIONS
  : /self-listing-publish-async/.test(testFile) ? PUBLISHSELF_MUTATIONS
  : /self-listing-create-async/.test(testFile) ? CREATESELF_MUTATIONS
  : /oauth-callback-async/.test(testFile) ? OAUTHCB_MUTATIONS
  : /listing-import-start-async/.test(testFile) ? IMPORTSTART_MUTATIONS
  : /wish-offer-create-async/.test(testFile) ? OFFERCREATE_MUTATIONS
  : /notify-flush-settings/.test(testFile) ? NOTIFYFLUSH_MUTATIONS
  : /watch-limits-async/.test(testFile) ? WATCHLIMITS_MUTATIONS
  : /email-verify-async/.test(testFile) ? VERIFY_MUTATIONS
  : /forgot-password-async/.test(testFile) ? FORGOT_MUTATIONS
  : /share-events-async/.test(testFile) ? SHARE_EVENT_MUTATIONS
  : /idle-verify/.test(testFile) ? IDLEPAUSE_MUTATIONS
  : /auth-member-async/.test(testFile) ? AUTHMEMBER_MUTATIONS
  : /budget-parity/.test(testFile) ? BUDGET_MUTATIONS
  : /listing-enrich-parity/.test(testFile) ? ENRICHQ_MUTATIONS
  : /listing-state-writes/.test(testFile) ? STATEWRITE_MUTATIONS
  : /admin-same-house-async/.test(testFile) ? SAMEBACKFILL_MUTATIONS
  : /listing-similarity-admin-parity/.test(testFile) ? SIMILARITY_MUTATIONS
  : /legal-copy-async/.test(testFile) ? LEGALCOPY_MUTATIONS
  : /data-revision-async/.test(testFile) ? DATAREV_MUTATIONS
  : /member-consents-async/.test(testFile) ? CONSENTS_MUTATIONS
  : /listing-import-lifecycle-async/.test(testFile) ? IMPLIFE_MUTATIONS
  : /self-listing-report-async/.test(testFile) ? SELFREPORT_MUTATIONS
  : /close-self-listing-async/.test(testFile) ? CLOSESELF_MUTATIONS
  : /listing-imports-async/.test(testFile) ? IMPORTS_MUTATIONS
  : /system-crawl-async/.test(testFile) ? SYSCRAWL_MUTATIONS
  : /rental-notify-prefs-async/.test(testFile) ? NPREFSWRITE_MUTATIONS
  : /rental-ops-async/.test(testFile) ? OPS_MUTATIONS
  : /rental-survey-async/.test(testFile) ? SURVEY_MUTATIONS
  : /wish-room-lifecycle-async/.test(testFile) ? WISHLIFECYCLE_MUTATIONS
  : /wish-example-async/.test(testFile) ? WISHEXAMPLE_MUTATIONS
  : /crm-module-async/.test(testFile) ? CRMMOD_MUTATIONS
  : /same-house-backfill-status/.test(testFile) ? BACKFILL_MUTATIONS
  : /listing-import-async/.test(testFile) ? LISTINGIMPORT_MUTATIONS
  : /site-command-async/.test(testFile) ? SITECOMMAND_MUTATIONS
  : /web-push-async/.test(testFile) ? PUSH_MUTATIONS
  : /rental-catalog-async/.test(testFile) ? RENTALCAT_MUTATIONS
  : /geo-cache-async/.test(testFile) ? GEOCACHE_MUTATIONS
  : /comms-async/.test(testFile) ? COMMS_MUTATIONS
  : /content-documents-async/.test(testFile) ? CONTENTDOCS_MUTATIONS
  : /member-media-async/.test(testFile) ? MEMBERMEDIA_MUTATIONS
  : /listing-tools-async/.test(testFile) ? LISTINGTOOLS_MUTATIONS
  : /session-async/.test(testFile) ? SESSION_MUTATIONS
  : /admin-audit-visibility/.test(testFile) ? AUDIT_MUTATIONS
  : /personal-flags-read-async/.test(testFile) ? PFLAGS_MUTATIONS
  : /users-async/.test(testFile) ? USERS_MUTATIONS
  : /rental-notify-write-async/.test(testFile) ? NWRITE_MUTATIONS
  : /rental-notify-reads-async/.test(testFile) ? NPREFS_MUTATIONS
  : /rental-analytics-async/.test(testFile) ? RANALYTICS_MUTATIONS
  : /wish-offers-async/.test(testFile) ? WOFFERS_MUTATIONS
  : /demand-async/.test(testFile) ? DEMAND_MUTATIONS
  : /route-data-map/.test(testFile) ? MAP_MUTATIONS
    : /admin-settings-async/.test(testFile) ? ADMSET_MUTATIONS
          : /self-listings-async/.test(testFile) ? SELFLIST_MUTATIONS
          : /housing-refresh-async/.test(testFile) ? HOUSING_MUTATIONS
            : /support-async/.test(testFile) ? SUPPORT_WRITE_MUTATIONS
      : REJECT_MUTATIONS;

// 差點把一個壞掉的修正當成完成品。任何中斷路徑都要走 restoreAll()。
const PRISTINE = new Map();
function restoreAll() {
  for (const [file, text] of PRISTINE) {
    try { writeFileSync(file, text); } catch { /* 盡力而為 */ }
  }
}
// 🚨 自我修復（2026-09-27 第二次踩到才加）：被 SIGTERM 中斷時，原始碼可能停在「已變異」狀態。
// 第一版只有記憶體裡的 PRISTINE + 訊號處理常式，但實測仍會留下變異過的檔案
// （工具被殺時處理常式不一定跑得到）。現在額外在 **tmpdir** 留一份備份：
//   * 啟動時若發現殘留備份 ⇒ 先還原，再開始（上一次被中斷也救得回來）
//   * 正常結束時刪掉備份
// 備份放 tmpdir 而不是 repo，避免污染 git status；也避免「備份自己也被提交」。
const backupPath = (file) => path.join(tmpdir(), `dsh-mutation-backup-${createHash("sha1").update(path.resolve(file)).digest("hex").slice(0, 12)}`);
const BACKUPS = new Map();
for (const file of new Set(MUTATIONS.map((m) => m.file))) {
  const bak = backupPath(file);
  if (existsSync(bak)) {
    // 上一次被中斷：先還原再說，避免把變異過的原始碼當成 baseline。
    writeFileSync(file, readFileSync(bak, "utf8"));
    console.error(`[mutation] 偵測到上一次中斷留下的備份，已還原 ${file}`);
  }
  const text = readFileSync(file, "utf8");
  PRISTINE.set(file, text);
  writeFileSync(bak, text);
  BACKUPS.set(file, bak);
}
let cleanedUp = false;
function removeBackups() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const bak of BACKUPS.values()) { try { unlinkSync(bak); } catch { /* 盡力而為 */ } }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { restoreAll(); removeBackups(); process.exit(130); });
}
process.on("uncaughtException", (error) => { restoreAll(); removeBackups(); console.error(error); process.exit(1); });
// 正常／提前結束都要清掉 tmpdir 的備份，否則會留下垃圾（而且下次啟動會誤判為「上次被中斷」）。
process.on("exit", () => { restoreAll(); removeBackups(); });

function runTests() {
  try {
    // ⚠️ maxBuffer 一定要放大：預設 1 MiB，而這個測試檔的 deepEqual 差異很大，
    // 一旦超過就會**截斷輸出**，後面失敗的 `not ok` 行整批消失 ⇒ 變異被誤判成 SURVIVED。
    // （實測：tier 的變異明明有兩條測試失敗，工具卻回報「沒有失敗」。）
    const out = execFileSync(process.execPath, ["--test", testFile], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024,
    });
    return { out, failed: false };
  } catch (error) {
    return { out: `${error.stdout || ""}${error.stderr || ""}`, failed: true };
  }
}

function failingNames(out) {
  return out.split("\n").filter((l) => l.startsWith("not ok ")).map((l) => l.replace(/^not ok \d+ - /, "").trim());
}

// 🚨 前置檢查（2026-09-27 加了自我修復之後仍然踩到才補的）：
// **所有 from 字串都必須存在**。以前少了只會把那一條標成 SKIP，看起來像「這條不用測」；
// 實際上「錨點不見了」幾乎都代表**原始碼被改過或停在半變異狀態**——
// 我因此有一次在「原始碼已經被弄壞」的狀態下繼續跑完整輪，
// 而且拿來對照的備份也繼承了同一個損壞，導致完整性檢查形同虛設。
// 現在直接中止（不套用任何變異），把問題大聲講出來。
{
  const missing = [];
  for (const m of MUTATIONS) {
    if (ONLY && !m.name.includes(ONLY)) continue;
    const text = readFileSync(m.file, "utf8");
    for (const step of [{ from: m.from, to: m.to }, ...(m.also || [])]) {
      const hits = text.split(step.from).length - 1;
      if (hits !== 1) missing.push(`  ${m.name}\n    ${m.file}: 錨點出現 ${hits} 次（必須恰好 1 次）\n    ${JSON.stringify(step.from.slice(0, 90))}`);
    }
  }
  if (missing.length) {
    console.error(`[mutation] 前置檢查失敗：${missing.length} 個錨點找不到（原始碼可能已被改動或停在半變異狀態）`);
    console.error(missing.join("\n"));
    console.error("\n[mutation] 未套用任何變異就中止。請先確認原始碼是乾淨的（例如 git diff）。");
    removeBackups();
    process.exit(2);
  }
  // `--check-anchors-only`：只跑前置檢查就結束（給 `v3/test/mutation-anchors.test.js` 用）。
  // 為什麼需要：錨點一旦變成**不唯一**（改動到別的函式剛好寫了同一行），整個套件會靜靜地中止，
  // 而「沒有跑變異」跟「變異全殺」在輸出上長得很像。實例：第五十四批之後
  // `usersAsync.js` 有兩處 `if (!id) return null;`，`USERS_MUTATIONS` 就再也沒真正跑過。
  if (process.argv.includes("--check-anchors-only")) {
    removeBackups();
    console.log(`[mutation] 錨點檢查通過：${MUTATIONS.length} 條`);
    process.exit(0);
  }
}

const results = [];
for (const m of MUTATIONS) {
  if (ONLY && !m.name.includes(ONLY)) continue;
  const original = readFileSync(m.file, "utf8");
  // `also` 支援「複合變異」：有些修正只有在**兩個地方同時改壞**時才看得出價值
  // （例：日誌節奏若與失敗計數耦合，只有計數器也壞掉時才會洗版）。
  // 單獨改一處是「等價變異」，殺不掉也不該假裝殺得掉——複合起來才測得到。
  const steps = [{ from: m.from, to: m.to }, ...(m.also || [])];
  let mutated = original;
  let skip = "";
  for (const step of steps) {
    const hits = mutated.split(step.from).length - 1;
    if (hits !== 1) { skip = `"${step.from.slice(0, 48)}…" 在 ${m.file} 出現 ${hits} 次（必須恰好 1 次）`; break; }
    mutated = mutated.replace(step.from, step.to);
  }
  if (skip) {
    results.push({ ...m, status: "SKIP", detail: skip });
    continue;
  }
  writeFileSync(m.file, mutated);
  let r;
  try {
    r = runTests();
  } finally {
    writeFileSync(m.file, original);
  }
  const killers = failingNames(r.out);
  const killed = killers.some((n) => n.includes(m.expect));
  results.push({
    ...m,
    status: killed ? "KILLED" : "SURVIVED",
    detail: killed ? killers.filter((n) => n.includes(m.expect)).join(" / ") : `沒有任何測試失敗${r.failed ? "" : "（整輪竟然全綠）"}`,
    allFailures: killers,
  });
  if (!asJson) {
    const bad = killed ? "OK  " : "BUG ";
    console.log(`[${bad}] ${m.name}\n       預期殺手「${m.expect}」→ ${killed ? "已失敗 ✓" : "**沒有失敗** ✗"}`);
    if (!killed) console.log(`       實際失敗項：${killers.length ? killers.join(" / ") : "（無）"}`);
  }
}

const survived = results.filter((r) => r.status === "SURVIVED");
const skipped = results.filter((r) => r.status === "SKIP");
if (asJson) console.log(JSON.stringify(results, null, 2));
else {
  console.log(`\n共 ${results.length} 條變異：KILLED ${results.length - survived.length - skipped.length}、SURVIVED ${survived.length}、SKIP ${skipped.length}`);
  for (const s of skipped) console.log(`  SKIP ${s.name} :: ${s.detail}`);
  for (const s of survived) console.log(`  SURVIVED ${s.name}`);
}
process.exit(survived.length ? 1 : 0);
