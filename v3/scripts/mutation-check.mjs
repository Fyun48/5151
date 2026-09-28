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
    from: '  if (!row) throw httpError("找不到這則站內刊登", 404);',
    to: "  if (!row) return null;",
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
    from: "    const rows = await exec(WISH_EXAMPLE_SELECT_SQL, [uid]);\n    return exampleFromRow(rows?.[0] || null);",
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
];

// 內容文件 PG 分支的變異集（v3/test/content-documents-async.test.js）。
// 這一組的重點是「不可變性」——那是用 PG trigger 實作的業務規則，不是加固。
const CD_SRC = "v3/src/contentDocumentsAsync.js";
const CD_SYNC_SRC = "v3/src/contentDocuments.js";
const CONTENTDOCS_MUTATIONS = [
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
    expect: "函式本文被截斷的守衛",
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
    expect: "被低估的那一批",
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
    from: "  if (!new RegExp(`(?<![\\\\w$.])${n}(?![\\\\w$])(?!\\\\s*:)`).test(body)) return false;",
    to: "  if (!new RegExp(`(?<![\\\\w$.])${n}(?![\\\\w$])`).test(body)) return false;",
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

const testFile = process.argv[2] || "v3/test/reject-match-async.test.js";
const asJson = process.argv.includes("--json");
// --only=<子字串>：只跑名稱含該子字串的變異（除錯用）。
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.slice("--only=".length) : "";

// 被中斷時一定要把原始碼還原——第一版沒有這段，SIGTERM 之後原始碼停在「已變異」的狀態，
// 依測試檔挑變異集。預設是 reject-match；稽核可視性用另一組。
const MUTATIONS = /close-self-listing-async/.test(testFile) ? CLOSESELF_MUTATIONS
  : /wish-example-async/.test(testFile) ? WISHEXAMPLE_MUTATIONS
  : /crm-module-async/.test(testFile) ? CRMMOD_MUTATIONS
  : /same-house-backfill-status/.test(testFile) ? BACKFILL_MUTATIONS
  : /listing-import-async/.test(testFile) ? LISTINGIMPORT_MUTATIONS
  : /site-command-async/.test(testFile) ? SITECOMMAND_MUTATIONS
  : /web-push-async/.test(testFile) ? PUSH_MUTATIONS
  : /rental-catalog-async/.test(testFile) ? RENTALCAT_MUTATIONS
  : /comms-async/.test(testFile) ? COMMS_MUTATIONS
  : /content-documents-async/.test(testFile) ? CONTENTDOCS_MUTATIONS
  : /member-media-async/.test(testFile) ? MEMBERMEDIA_MUTATIONS
  : /listing-tools-async/.test(testFile) ? LISTINGTOOLS_MUTATIONS
  : /session-async/.test(testFile) ? SESSION_MUTATIONS
  : /admin-audit-visibility/.test(testFile) ? AUDIT_MUTATIONS
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
