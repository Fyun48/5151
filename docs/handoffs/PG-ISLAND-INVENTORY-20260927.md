# PG 島嶼盤點：仍只走節點本機 SQLite 的正式路由（2026-09-27）

## 一句話

會員熱路徑（搜尋、通知、設定檔、爬蟲入庫）已搬到 PG，但**管理／站台內容類仍有大量路由
只走同步 `db.js`（節點本機 SQLite）**——而這不是理論風險：**30 個 `settings` 鍵已有 10 個
三個來源各不相同**，其中 `housingData` 連 PG 在內三方都不同。

## 為什麼要做這份

2026-09-27 的會員 SMTP 問題（見 `PG-ISLAND-MEMBER-MAIL-20260927.md`）是**誤打誤撞**發現的，
代表人工抽查會漏。所以改用機械化方式把所有呼叫點列出來。

## 方法（可重跑）

```
node v3/scripts/pg-island-inventory.mjs
```

1. 解析 `db.js` 所有頂層函式，建立「會碰 SQLite」集合（直接出現
   `db.prepare`／`db.exec`／`db.pragma`／`sqliteHandle`，或呼叫到集合內其他函式），fixpoint 迭代。
2. 排除本文內含 driver 判斷（`resolveDbDriver`／`pgSharedDriver`／`writePath`／`sqliteFallback`…）者。
3. 解析每個模組從 `./db.js` 匯入的名稱，在 `server.js` 逐路由找出引用了哪些同步函式。
4. 收集所有 `*Async.js` 的 export，標示是否已有 `...Async` 對應版本。

### 已知限制（必須跟結論一起看）

- **只看直接引用**；跨檔沒有建呼叫圖，所以「路由 → A → db.js」這種間接呼叫**抓不到**。
- 路由本文以「到下一個行首 `});`」近似，巢狀較深時可能多抓或少抓。
- driver 判斷的**傳遞**不完整：`A` 呼叫已 driver-aware 的 `B` 時，`A` 仍會被誤標。
  （這也是為什麼 db.js 只被判定 3 個 driver-aware，數字明顯偏低。）
- 因此**輸出是候選清單，不是證明**；要據此動手前仍須人工確認。

## 統計

- `db.js` 判定為「只走 SQLite」的函式：**292 個**
- `server.js` 仍直接呼叫同步 DB 函式的路由：**117 條**
- 其他模組仍直接引用同步 DB 函式：**20 個檔案**（多數是共用純函式或 SQLite 分支，屬偽陽性）

依路徑前綴分佈：

| 前綴 | 路由數 |
|---|---:|
| `admin` | 51 |
| `wish-offers` | 11 |
| `self-listings` | 9 |
| `wish-rooms` | 9 |
| `listings` | 6 |
| `demand` | 4 |
| `public` | 3 |
| `commute` | 2 |
| `rental-notify` | 2 |
| `(root)` | 2 |
| `account` | 1 |
| `brand` | 1 |
| `comms` | 1 |
| `disclaimer` | 1 |
| `forgot-password` | 1 |
| `help-qa` | 1 |
| `housing-data` | 1 |
| `listing-imports` | 1 |
| `me` | 1 |
| `oauth` | 1 |
| `profile` | 1 |
| `register` | 1 |
| `reset-all` | 1 |
| `reset-listings` | 1 |
| `spirit` | 1 |
| `sponsored` | 1 |
| `state` | 1 |
| `watch` | 1 |

**重點**：51 條在 `/api/admin/*`——也就是「管理員改站台內容」這一大塊完全沒搬。
會員熱路徑（`listings`、`state`、`commute`）多半已移植或有 `...Async` 版本。

## 具體證據：不是理論風險，已經分歧了

把 `settings` 全部 30 個鍵在 **PG／CasaOS SQLite／Synology SQLite** 三邊比對 md5（只比雜湊，未讀出值）：

**10 個鍵三方不一致**：

| key | PG | CasaOS | Synology | 狀況 |
|---|---|---|---|---|
| `housingData` | `cc00314a8c58` | `2e0f03d2d532` | `b398e2d56c4e` | **三方各一版** |
| `sponsorLinks` | `eb46a521816a` | `00d8dcfde647` | `00d8dcfde647` | PG 與兩節點不同 |
| `rentalCatalog` | `65a2de6269f0` | （無） | `65a2de6269f0` | CasaOS 完全沒有 |
| `rentalCatalogDraft` | `65a2de6269f0` | `65a2de6269f0` | `37a6259cc0c1` | Synology 是 `null` |
| `siteCatalogStats` | `acd006feef30` | `5e27d35892ed` | `acd006feef30` | 兩節點不同 |
| `lastCoveringAt` | `7d21a551da82` | `8d2c52c2cb71` | `8d2c52c2cb71` | PG 不同 |
| `lastSystemCoveringAt` | `6f1b516d4400` | `8d2c52c2cb71` | `8d2c52c2cb71` | PG 不同 |
| `crawlScheduleV1` | `92385a8c4109` | （無） | （無） | 只在 PG（**預期**，已移植） |
| `llm_insight_apply_enabled` | `68934a3e9455` | （無） | （無） | 只在 PG（預期） |
| `phash_enabled` | `68934a3e9455` | （無） | （無） | 只在 PG（預期） |

`housingData` 是最嚴重的一個：**三個來源都不一樣**。它正好對應被標記的
`GET/PUT /api/admin/housing-data`（`[sync] getHousingData / saveHousingData`）——
後台改居住數據只寫到「回答你的那台節點」。

## 建議的處理順序

1. **`/api/admin/*` 的寫入路由優先**（51 條）。它們是「管理員改內容」的路徑，
   一旦兩台不一致，公開站顯示什麼取決於被導到哪一台——`housingData` 已經是三版了。
2. **`sponsorLinks`、`rentalCatalog*`、`siteCatalogStats`** 這幾個已在切換衝突清單裡的，
   應該跟衝突裁定一起決定以哪一版為準，再一併搬。
3. **不要一次改 117 條**。建議照既有的島嶼模式一批一批來（每批：async 模組 ＋ parity 測試
   ＋ 變異驗證），並在每批上線前先比對三邊雜湊，確認沒有新的分歧被製造出來。

## 這份沒有做的事

- **沒有修改任何一條路由**（點 2 的範圍是盤點，不是修）。
- 沒有把所有 117 條都人工確認過；上面已說明啟發法的限制。
- 沒有處理 `housingData` 等 10 個鍵的既有分歧——那需要先決定「以哪一版為準」，
  屬於 Owner 決策，我不代判。

## 附錄：117 條候選路由全量清單

- `POST /api/account/delete  [sync]  deleteOwnAccount`
- `GET /api/admin/ads  [sync]  getAdminAdsSettings`
- `GET /api/admin/brand  [sync]  getBrandMascot`
- `PUT /api/admin/brand  [sync]  saveBrandMascot`
- `POST /api/admin/brand/file  [sync]  applyBrandUpload`
- `GET /api/admin/broadcasts  [sync]  getAdminBroadcastsSettings`
- `GET /api/admin/campaigns  [sync]  getCommsConfig`
- `GET /api/admin/comms-config  [sync]  getCommsConfig`
- `PUT /api/admin/comms-config  [sync]  saveCommsConfig`
- `GET /api/admin/crawl-sources  [sync]  getCrawlSources`
- `PUT /api/admin/crawl-sources  [sync]  getCrawlSources, saveCrawlSources`
- `GET /api/admin/help-qa  [sync]  getHelpQa`
- `PUT /api/admin/help-qa  [sync]  saveHelpQa`
- `GET /api/admin/housing-data  [sync]  getHousingData`
- `PUT /api/admin/housing-data  [sync]  saveHousingData`
- `POST /api/admin/housing-data/refresh  [async]  getHousingData`
- `GET /api/admin/legal-copy  [sync]  getLegalCopy`
- `PUT /api/admin/legal-copy  [sync]  saveLegalCopy`
- `GET /api/admin/mail  [sync]  getAdminMailSettings`
- `PUT /api/admin/mail  [sync]  saveAdminMailSettings`
- `POST /api/admin/mail/test  [async]  getStoredSmtp`
- `GET /api/admin/maps  [sync]  getAdminMapsSettings`
- `PUT /api/admin/maps  [sync]  getAdminMapsSettings, saveAdminMapsSettings`
- `GET /api/admin/members  [sync]  listAdminMembers`
- `PATCH /api/admin/members/:id  [sync]  adminPatchMember`
- `POST /api/admin/members/:id/delete  [sync]  adminDeleteMember`
- `POST /api/admin/members/:id/restore  [sync]  adminRestoreMember`
- `GET /api/admin/oauth  [sync]  getAdminOauthSettings`
- `PUT /api/admin/oauth  [sync]  saveAdminOauthSettings`
- `GET /api/admin/rental-catalog  [sync]  getRentalCatalog, getRentalCatalogDraft, getRentalCatalogTemplates, getRentalMarketplaceFlags`
- `PUT /api/admin/rental-catalog  [sync]  saveRentalCatalog`
- `POST /api/admin/rental-catalog/draft/publish  [sync]  publishRentalCatalogDraft`
- `POST /api/admin/rental-catalog/mutate  [sync]  mutateRentalCatalog`
- `POST /api/admin/rental-catalog/templates  [sync]  saveRentalCatalogTemplate`
- `PATCH /api/admin/rental-catalog/templates/:id  [sync]  renameRentalCatalogTemplate`
- `DELETE /api/admin/rental-catalog/templates/:id  [sync]  deleteRentalCatalogTemplate`
- `POST /api/admin/rental-catalog/templates/:id/apply  [sync]  applyRentalCatalogTemplate`
- `GET /api/admin/rental-marketplace-flags  [sync]  getRentalMarketplaceFlags`
- `PUT /api/admin/rental-marketplace-flags  [sync]  saveRentalMarketplaceFlags`
- `GET /api/admin/rental-match-rules  [sync]  rentalMatchAdminRules`
- `POST /api/admin/same-house/confirm  [sync]  mergeSameHouseForUser`
- `GET /api/admin/same-house/reconcile  [sync]  sameHouseBackfillStatus`
- `POST /api/admin/same-house/reconcile  [sync]  runSameHouseBackfill`
- `GET /api/admin/spirit  [sync]  getSpirit`
- `PUT /api/admin/spirit  [sync]  saveSpirit`
- `GET /api/admin/sponsor  [sync]  getAdminSponsorSettings`
- `PUT /api/admin/sponsor  [sync]  saveAdminSponsorSettings`
- `GET /api/admin/system-crawl  [sync]  getSystemCrawl, refreshSiteCatalogStats`
- `PUT /api/admin/system-crawl  [sync]  saveSystemCrawl`
- `GET /api/admin/wish-conditions  [sync]  getWishConditions`
- `PUT /api/admin/wish-conditions  [sync]  saveWishConditions`
- `GET /api/admin/wish-offer-reports  [sync]  listAdminWishOfferReportsFor`
- `GET /api/brand  [sync]  getBrandMascot`
- `GET /api/comms  [sync]  publicSponsorSettings, getCommsConfig`
- `POST /api/commute/focus  [sync]  getSettings→有Async`
- `GET /api/commute/snapshot  [sync]  getSettings→有Async, listingCommutePatch`
- `POST /api/demand  [sync]  createDemand`
- `GET /api/demand/:id  [sync]  getDemand`
- `GET /api/demand/aggregate  [sync]  aggregateDemand`
- `GET /api/demand/exposure  [sync]  homepageDemandExposure`
- `GET /api/disclaimer  [sync]  getLegalCopy`
- `POST /api/forgot-password  [async]  requestTempPassword`
- `GET /api/help-qa  [sync]  getHelpQa`
- `GET /api/housing-data  [sync]  getHousingData`
- `POST /api/listing-imports/:id/publish  [sync]  publishConfirmedImportFor`
- `GET /api/listings  [async]  confirmExpiredOfflineFromSettings`
- `POST /api/listings/:id/confirm-match  [sync]  confirmSuspectedMatch, stats`
- `POST /api/listings/:id/flags  [async]  stats`
- `POST /api/listings/:id/reject-match  [sync]  rejectSuspectedMatch, stats`
- `POST /api/listings/hide-many  [sync]  hideMany`
- `POST /api/listings/merge-same-house  [sync]  mergeSameHouseForUser, stats`
- `GET /api/me  [sync]  countOpenSelfListings, publicSponsorSettings, getLegalCopy`
- `GET /api/oauth  [sync]  getAdminOauthSettings`
- `PATCH /api/profile  [sync]  updateUserProfile`
- `POST /api/public/unsubscribe/:token  [sync]  applyUnsubscribeTokenFor`
- `GET /api/public/wish-room/:id  [sync]  getDemand, sharePageExtrasFor`
- `POST /api/public/wish-room/:id/share-events  [sync]  getDemand, sharePageExtrasFor`
- `POST /api/register  [sync]  getStoredSmtp, registerUserWithConsents`
- `GET /api/rental-notify/prefs  [sync]  getRentalNotifyPrefsFor`
- `PUT /api/rental-notify/prefs  [sync]  saveRentalNotifyPrefsFor`
- `POST /api/reset-all  [sync]  resetAllData`
- `POST /api/reset-listings  [sync]  resetListings, stats`
- `GET /api/self-listings  [sync]  getRentalCatalog, getRentalMarketplaceFlags, listMineSelfListings, rentalMatchOwnerMeta`
- `POST /api/self-listings  [sync]  createSelfListing`
- `POST /api/self-listings/:id/copy  [sync]  copyOwnListingFor`
- `GET /api/self-listings/:id/match-subscription  [sync]  getMatchSubscriptionFor`
- `PUT /api/self-listings/:id/match-subscription  [sync]  saveMatchSubscriptionFor`
- `GET /api/self-listings/:id/matches  [sync]  ownerListingMatches`
- `POST /api/self-listings/:id/matches/:wishRef/offers  [sync]  createWishOfferFor`
- `GET /api/self-listings/:id/matches/summary  [sync]  ownerListingMatchSummary`
- `POST /api/self-listings/:id/publish  [sync]  publishOwnedDraftFor`
- `GET /api/spirit  [sync]  getSpirit`
- `GET /api/sponsored  [sync]  getCommsConfig`
- `GET /api/state  [async]  confirmExpiredOfflineFromSettings, getSettings→有Async, recentEvents`
- `POST /api/watch  [async]  stats`
- `GET /api/wish-offers/:offerRef  [sync]  getWishOfferFor`
- `POST /api/wish-offers/:offerRef/accept  [sync]  acceptWishOfferFor`
- `POST /api/wish-offers/:offerRef/block  [sync]  blockWishOfferFor`
- `GET /api/wish-offers/:offerRef/contact  [sync]  readWishOfferContactFor`
- `POST /api/wish-offers/:offerRef/decline  [sync]  declineWishOfferFor`
- `POST /api/wish-offers/:offerRef/report  [sync]  reportWishOfferFor`
- `POST /api/wish-offers/:offerRef/withdraw  [sync]  withdrawWishOfferFor`
- `GET /api/wish-offers/blocks  [sync]  listMyWishOfferBlocksFor`
- `POST /api/wish-offers/blocks/:blockRef/remove  [sync]  unblockWishOfferFor`
- `GET /api/wish-offers/inbox  [sync]  listTenantWishOffersFor`
- `GET /api/wish-offers/owner  [sync]  listOwnerWishOffersFor`
- `POST /api/wish-rooms  [sync]  createDemand`
- `GET /api/wish-rooms/:id  [sync]  getDemand`
- `PATCH /api/wish-rooms/:id  [sync]  updateWishRoomFor`
- `POST /api/wish-rooms/:id/publish  [sync]  publishWishRoomFor`
- `POST /api/wish-rooms/:id/reopen  [sync]  reopenWishRoomFor`
- `GET /api/wish-rooms/:id/survey  [sync]  getCompletionSurveyFor`
- `POST /api/wish-rooms/:id/survey  [sync]  submitCompletionSurveyFor`
- `PUT /api/wish-rooms/example  [sync]  saveWishExampleFor`
- `GET /api/wish-rooms/mine  [sync]  listDemand, wishRoomOwnerSummaryFor`
- `GET /auth/:provider  [sync]  getStoredOauth`
- `GET /auth/:provider/callback  [async]  updateUserProfile, getStoredSmtp, getStoredOauth, registerUserWithConsents`

## 附錄：其他模組的引用（多為偽陽性，需人工確認）

```
仍直接呼叫同步 DB 函式：20 個檔案

accountMaintenanceAsync.js: sqliteHandle
adminOverview.js: getAdminMailSettings, getAdminMapsSettings, getAdminOauthSettings, getCrawlSources, getSystemCrawl, readSiteCatalogStats, sameHouseBackfillStatus
coveringBookkeepingAsync.js: armMemberExternalFetch, coveringBookkeeping, crawlIntervalMinutes, markCoveringCompleted, sqliteHandle
crawlScheduleAsync.js: sqliteHandle, settingsFromRows
crawlerReads.js: listMatchCandidates, listingSearchBuildContext, crawlerReadsBuildContext, listingsNeeding591Geo, listingsNeedingAddressEnrich, listingsNeedingAddressGeo, listingsNeedingAliveCheck, listingsNeedingFeeDetail, listingsNeedingMrt, listingsNeedingOfflineRecheck, listingsNeedingRoute, listingsNeedingSourceKit
crmAsync.js: sqliteHandle
crmOutboxAsync.js: sqliteHandle
listingDetailAsync.js: decorateRowsWithProvider, getListing, listingSearchBuildContext, preloadDecorationProviderAsync
listingGroupsAsync.js: sqliteHandle
listingSearchAsync.js: listListings, listListingsCommuteSqlFirst, listListingsFitSqlFirst, listListingsSqlFirst, listingSearchBuildContext
listingSearchNodePg.js: buildListListingsClauses, buildListListingsRowsAsync, buildListRequestContextFromPg, decorateListListingsPage, preloadDecorationProviderAsync, resolveListDistrictNames
listingSearchPage.js: buildListRequestContextFromPg
listingSearchSqlPgDiagnostic.js: decorateRowsWithProvider, listingSearchBuildContext, preloadDecorationProviderAsync
listingSimilarityAsync.js: sqliteHandle
listingStatsAsync.js: buildListingStatsRowsAsync, listingStatsBuildContext, stats, summarizeListingStatsAsync, summarizeRawListingStatsAsync
notifyEnqueueAsync.js: notifyEnqueueBuildContext
notifyQueueAsync.js: pendingNotifyEvents
publicListingSearchAsync.js: buildListRequestContextFromPg, buildPublicListingsClauses, buildPublicListingsRowsAsync, decoratePublicListingsPage, listingSearchBuildContext, listPublicListingsFast, preloadDecorationProviderAsync
settingsAsync.js: armMemberExternalFetch, settingsFromRows, sqliteHandle
watcher.js: getCommunityCache, getListing, getSettings, getSystemCrawl, getMailTemplates, listingCount, listMatchCandidates, listingCommutePatch, upsertRouteJob, getRouteJob, markListingOffline, markListingAlive, eventChannelsHandled, setCachedRoute, commuteRushEnabled, collectCommuteSettings, updateListingsGeoByAddress, setCachedGeo
```
