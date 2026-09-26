# PR-A 附錄：HTTP 入口清單（機械抽取）

> 由 `v3/src/server.js` 抽取，共 **288** 個 route。
> 這份是 PR-A「入口矩陣」的原始資料；矩陣本體（facade／讀寫來源／fallback／交易／測試狀態）見 `pr-a-access-matrix-20260924.md`。

## 依路徑前兩段分組的數量

| 路徑前綴 | route 數 |
|---|---|
| `/api/admin` | 122 |
| `/api/self-listings` | 13 |
| `/api/wish-rooms` | 12 |
| `/api/wish-offers` | 11 |
| `/api/media` | 9 |
| `/api/listings` | 9 |
| `/api/demand` | 8 |
| `/api/listing-imports` | 8 |
| `/api/public` | 7 |
| `/api/support` | 7 |
| `/api/listing-description-templates` | 5 |
| `/api/listing-contact-profiles` | 5 |
| `/api/announcements` | 4 |
| `/api/push` | 3 |
| `/api/consents` | 3 |
| `/api/member-mail` | 3 |
| `/api/profiles` | 3 |
| `/auth/:provider` | 2 |
| `/api/sponsored` | 2 |
| `/api/feedback` | 2 |
| `/api/rental-notify` | 2 |
| `/api/settings` | 2 |
| `/api/commute` | 2 |
| `/api/events` | 2 |
| `/api/health` | 1 |
| `/support` | 1 |
| `/manifest.webmanifest` | 1 |
| `/sw.js` | 1 |
| `/` | 1 |
| `/index.html` | 1 |
| `/login.html` | 1 |
| `/api/demo` | 1 |
| `/go/:id` | 1 |
| `/api/me` | 1 |
| `/api/profile` | 1 |
| `/api/disclaimer` | 1 |
| `/terms.html` | 1 |
| `/api/help-qa` | 1 |
| `/api/captcha` | 1 |
| `/api/login` | 1 |
| `/api/register` | 1 |
| `/verify-email` | 1 |
| `/api/oauth` | 1 |
| `/api/forgot-password` | 1 |
| `/api/logout` | 1 |
| `/logout` | 1 |
| `/api/ops` | 1 |
| `/admin.html` | 1 |
| `/api/account` | 1 |
| `/api/ads` | 1 |
| `/api/brand` | 1 |
| `/media/brand` | 1 |
| `/api/broadcasts` | 1 |
| `/api/comms` | 1 |
| `/api/spirit` | 1 |
| `/api/housing-data` | 1 |
| `/media/self` | 1 |
| `/media/lib` | 1 |
| `/l/:id` | 1 |
| `/w/:id` | 1 |
| `/api/change-password` | 1 |
| `/api/state` | 1 |
| `/api/reset-listings` | 1 |
| `/api/reset-all` | 1 |
| `/api/exclude-region` | 1 |
| `/api/watch` | 1 |

## 全部 route

| # | method | path | server.js 行 | 守門 |
|---|---|---|---|---|
| 1 | GET | `/api/health` | 433 | public |
| 2 | GET | `/support` | 437 | public |
| 3 | GET | `/manifest.webmanifest` | 441 | public |
| 4 | GET | `/sw.js` | 446 | public |
| 5 | GET | `/api/push/vapid` | 453 | public |
| 6 | GET | `/` | 457 | public |
| 7 | GET | `/index.html` | 461 | public |
| 8 | GET | `/login.html` | 465 | public |
| 9 | GET | `/api/demo` | 469 | public |
| 10 | GET | `/api/public/listings` | 543 | public |
| 11 | GET | `/go/:id` | 653 | public |
| 12 | GET | `/api/me` | 678 | public |
| 13 | PATCH | `/api/profile` | 718 | public |
| 14 | GET | `/api/disclaimer` | 732 | public |
| 15 | GET | `/api/public/documents` | 736 | public |
| 16 | GET | `/api/public/documents/:type` | 747 | public |
| 17 | GET | `/terms.html` | 761 | public |
| 18 | POST | `/api/consents` | 765 | public |
| 19 | GET | `/api/consents` | 782 | public |
| 20 | GET | `/api/consents/:id/document` | 791 | public |
| 21 | GET | `/api/help-qa` | 805 | public |
| 22 | GET | `/api/demand` | 836 | public |
| 23 | GET | `/api/wish-rooms` | 844 | public |
| 24 | GET | `/api/demand/aggregate` | 852 | public |
| 25 | GET | `/api/demand/exposure` | 877 | public |
| 26 | GET | `/api/wish-rooms/mine` | 885 | public |
| 27 | GET | `/api/wish-rooms/example` | 902 | public |
| 28 | PUT | `/api/wish-rooms/example` | 915 | public |
| 29 | DELETE | `/api/wish-rooms/example` | 928 | public |
| 30 | GET | `/api/demand/:id` | 941 | public |
| 31 | GET | `/api/wish-rooms/:id` | 950 | public |
| 32 | GET | `/api/public/wish-room/:id` | 960 | public |
| 33 | POST | `/api/public/wish-room/:id/share-events` | 971 | public |
| 34 | POST | `/api/public/unsubscribe/:token` | 1000 | public |
| 35 | GET | `/api/captcha` | 1023 | public |
| 36 | POST | `/api/login` | 1032 | public |
| 37 | POST | `/api/register` | 1062 | public |
| 38 | GET | `/verify-email` | 1142 | public |
| 39 | GET | `/api/oauth` | 1163 | public |
| 40 | GET | `/auth/:provider` | 1167 | public |
| 41 | GET | `/auth/:provider/callback` | 1194 | public |
| 42 | POST | `/api/forgot-password` | 1283 | public |
| 43 | POST | `/api/logout` | 1297 | public |
| 44 | GET | `/logout` | 1302 | admin+member |
| 45 | POST | `/api/ops/commands/apply` | 1307 | admin+member |
| 46 | GET | `/admin.html` | 1335 | admin |
| 47 | GET | `/api/admin/members` | 1343 | admin |
| 48 | POST | `/api/admin/members/:id/delete` | 1357 | admin |
| 49 | POST | `/api/admin/members/:id/restore` | 1372 | admin |
| 50 | POST | `/api/account/delete` | 1382 | public |
| 51 | PATCH | `/api/admin/members/:id` | 1399 | admin |
| 52 | GET | `/api/admin/mail` | 1413 | admin |
| 53 | PUT | `/api/admin/mail` | 1417 | admin |
| 54 | GET | `/api/admin/oauth` | 1425 | admin |
| 55 | PUT | `/api/admin/oauth` | 1429 | admin |
| 56 | GET | `/api/admin/sponsor` | 1437 | admin |
| 57 | PUT | `/api/admin/sponsor` | 1441 | admin |
| 58 | GET | `/api/admin/ads` | 1449 | admin |
| 59 | PUT | `/api/admin/ads` | 1453 | admin |
| 60 | GET | `/api/ads` | 1461 | admin |
| 61 | GET | `/api/brand` | 1465 | admin |
| 62 | GET | `/api/admin/brand` | 1469 | admin |
| 63 | PUT | `/api/admin/brand` | 1473 | admin |
| 64 | POST | `/api/admin/brand/file` | 1481 | admin |
| 65 | GET | `/media/brand/:file` | 1491 | admin |
| 66 | GET | `/api/admin/broadcasts` | 1502 | admin |
| 67 | PUT | `/api/admin/broadcasts` | 1506 | admin |
| 68 | GET | `/api/broadcasts` | 1514 | admin |
| 69 | GET | `/api/admin/announcements` | 1526 | admin |
| 70 | POST | `/api/admin/announcements` | 1530 | admin |
| 71 | PATCH | `/api/admin/announcements/:id` | 1538 | admin |
| 72 | POST | `/api/admin/announcements/:id/publish` | 1546 | admin |
| 73 | GET | `/api/admin/campaigns` | 1556 | admin |
| 74 | POST | `/api/admin/campaigns` | 1560 | admin |
| 75 | PATCH | `/api/admin/campaigns/:id` | 1568 | admin |
| 76 | GET | `/api/admin/comms-config` | 1576 | admin |
| 77 | PUT | `/api/admin/comms-config` | 1580 | admin |
| 78 | GET | `/api/announcements` | 1588 | public |
| 79 | GET | `/api/announcements/inbox` | 1592 | public |
| 80 | POST | `/api/announcements/:id/read` | 1597 | public |
| 81 | POST | `/api/announcements/:id/dismiss` | 1602 | public |
| 82 | GET | `/api/sponsored` | 1607 | public |
| 83 | POST | `/api/sponsored/:id/event` | 1617 | public |
| 84 | GET | `/api/comms` | 1627 | public |
| 85 | GET | `/api/support/public` | 1652 | public |
| 86 | GET | `/api/support/tiers` | 1660 | public |
| 87 | POST | `/api/support/checkout` | 1669 | public |
| 88 | POST | `/api/support/cta` | 1691 | public |
| 89 | POST | `/api/support/cta/dismiss` | 1705 | public |
| 90 | POST | `/api/support/event` | 1723 | public |
| 91 | POST | `/api/support/webhook/:provider` | 1736 | admin |
| 92 | GET | `/api/admin/support/dashboard` | 1745 | admin |
| 93 | GET | `/api/admin/support/config` | 1757 | admin |
| 94 | GET | `/api/admin/support/preview` | 1761 | admin |
| 95 | PUT | `/api/admin/support/config` | 1765 | admin |
| 96 | POST | `/api/admin/support/config/publish` | 1776 | admin |
| 97 | GET | `/api/admin/support/costs` | 1787 | admin |
| 98 | POST | `/api/admin/support/costs` | 1791 | admin |
| 99 | PUT | `/api/admin/support/costs/:id` | 1801 | admin |
| 100 | GET | `/api/admin/support/tiers` | 1812 | admin |
| 101 | POST | `/api/admin/support/tiers` | 1816 | admin |
| 102 | PUT | `/api/admin/support/tiers/:id` | 1826 | admin |
| 103 | GET | `/api/admin/support/providers` | 1837 | admin |
| 104 | PUT | `/api/admin/support/providers/:id` | 1841 | admin |
| 105 | GET | `/api/admin/support/transactions` | 1852 | admin |
| 106 | POST | `/api/admin/support/transactions/manual` | 1858 | admin |
| 107 | PUT | `/api/admin/support/transactions/:id` | 1868 | admin |
| 108 | GET | `/api/admin/support/sponsors` | 1880 | admin |
| 109 | POST | `/api/admin/support/sponsors` | 1884 | admin |
| 110 | PUT | `/api/admin/support/sponsors/:id` | 1894 | admin |
| 111 | GET | `/api/admin/support/cta-rules` | 1906 | admin |
| 112 | PUT | `/api/admin/support/cta-rules/:id` | 1910 | admin |
| 113 | GET | `/api/admin/help-qa` | 1921 | admin |
| 114 | PUT | `/api/admin/help-qa` | 1925 | admin |
| 115 | GET | `/api/admin/wish-conditions` | 1933 | admin |
| 116 | PUT | `/api/admin/wish-conditions` | 1937 | admin |
| 117 | GET | `/api/admin/rental-catalog` | 1945 | admin |
| 118 | PUT | `/api/admin/rental-catalog` | 1961 | admin |
| 119 | POST | `/api/admin/rental-catalog/mutate` | 1969 | admin |
| 120 | POST | `/api/admin/rental-catalog/templates` | 1977 | admin |
| 121 | PATCH | `/api/admin/rental-catalog/templates/:id` | 1985 | admin |
| 122 | DELETE | `/api/admin/rental-catalog/templates/:id` | 1993 | admin |
| 123 | POST | `/api/admin/rental-catalog/templates/:id/apply` | 2001 | admin |
| 124 | POST | `/api/admin/rental-catalog/draft/publish` | 2009 | admin |
| 125 | GET | `/api/admin/rental-marketplace-flags` | 2017 | admin |
| 126 | PUT | `/api/admin/rental-marketplace-flags` | 2021 | admin |
| 127 | GET | `/api/admin/rental-match-rules` | 2029 | admin |
| 128 | GET | `/api/admin/wish-offer-reports` | 2033 | admin |
| 129 | GET | `/api/admin/feedback` | 2037 | admin |
| 130 | PATCH | `/api/admin/feedback/:id` | 2046 | admin |
| 131 | GET | `/api/admin/ops-delivery` | 2054 | admin |
| 132 | PUT | `/api/admin/ops-delivery` | 2058 | admin |
| 133 | GET | `/api/admin/remote-cs` | 2063 | admin |
| 134 | PUT | `/api/admin/remote-cs` | 2067 | admin |
| 135 | POST | `/api/admin/ops-delivery/compact-outbox` | 2072 | admin |
| 136 | GET | `/api/admin/crm` | 2077 | admin |
| 137 | PUT | `/api/admin/crm/module` | 2088 | admin |
| 138 | PUT | `/api/admin/crm/sync` | 2093 | admin |
| 139 | GET | `/api/admin/crm/contacts/:id` | 2098 | admin |
| 140 | POST | `/api/admin/crm/contacts` | 2110 | admin |
| 141 | PATCH | `/api/admin/crm/contacts/:id` | 2118 | admin |
| 142 | POST | `/api/admin/crm/contacts/:id/cases` | 2126 | admin |
| 143 | PATCH | `/api/admin/crm/cases/:id` | 2134 | admin |
| 144 | POST | `/api/admin/crm/contacts/:id/notes` | 2142 | admin |
| 145 | POST | `/api/admin/crm/contacts/:id/todos` | 2150 | admin |
| 146 | POST | `/api/admin/crm/todos/:id/done` | 2158 | admin |
| 147 | POST | `/api/admin/crm/from-feedback/:id` | 2166 | admin |
| 148 | GET | `/api/spirit` | 2174 | admin |
| 149 | GET | `/api/housing-data` | 2178 | admin |
| 150 | GET | `/api/admin/housing-data` | 2182 | admin |
| 151 | PUT | `/api/admin/housing-data` | 2186 | admin |
| 152 | POST | `/api/admin/housing-data/refresh` | 2194 | admin |
| 153 | GET | `/api/admin/spirit` | 2203 | admin |
| 154 | PUT | `/api/admin/spirit` | 2207 | admin |
| 155 | GET | `/api/admin/legal-copy` | 2215 | admin |
| 156 | PUT | `/api/admin/legal-copy` | 2219 | admin |
| 157 | GET | `/api/admin/documents` | 2227 | admin |
| 158 | GET | `/api/admin/documents/:id/events` | 2234 | admin |
| 159 | GET | `/api/admin/documents/:id` | 2238 | admin |
| 160 | POST | `/api/admin/documents` | 2247 | admin |
| 161 | PATCH | `/api/admin/documents/:id` | 2256 | admin |
| 162 | POST | `/api/admin/documents/:id/publish` | 2265 | admin |
| 163 | POST | `/api/admin/documents/:id/new-version` | 2274 | admin |
| 164 | GET | `/api/admin/providers` | 2283 | admin |
| 165 | PUT | `/api/admin/providers/site-budget` | 2291 | admin |
| 166 | PUT | `/api/admin/providers` | 2300 | admin |
| 167 | POST | `/api/admin/providers/test` | 2309 | admin |
| 168 | GET | `/api/admin/providers/usage` | 2317 | admin |
| 169 | GET | `/api/admin/similarity` | 2325 | admin |
| 170 | PUT | `/api/admin/phash` | 2333 | admin |
| 171 | POST | `/api/admin/similarity/:id/review` | 2342 | admin |
| 172 | GET | `/api/admin/maps` | 2354 | admin |
| 173 | PUT | `/api/admin/maps` | 2358 | admin |
| 174 | GET | `/api/admin/crawl-sources` | 2377 | admin |
| 175 | PUT | `/api/admin/crawl-sources` | 2385 | admin |
| 176 | GET | `/api/admin/system-crawl` | 2396 | admin |
| 177 | PUT | `/api/admin/system-crawl` | 2400 | admin |
| 178 | GET | `/api/admin/same-house/reconcile` | 2408 | admin |
| 179 | POST | `/api/admin/same-house/reconcile` | 2415 | admin |
| 180 | GET | `/api/admin/overview` | 2432 | admin |
| 181 | GET | `/api/admin/data-health` | 2440 | admin |
| 182 | GET | `/api/admin/audit` | 2448 | admin |
| 183 | GET | `/api/admin/listings/search` | 2452 | admin |
| 184 | POST | `/api/admin/same-house/confirm` | 2456 | admin |
| 185 | POST | `/api/demand` | 2472 | public |
| 186 | POST | `/api/wish-rooms` | 2485 | public |
| 187 | PATCH | `/api/wish-rooms/:id` | 2498 | public |
| 188 | POST | `/api/wish-rooms/:id/publish` | 2511 | public |
| 189 | POST | `/api/wish-rooms/:id/reopen` | 2524 | public |
| 190 | POST | `/api/demand/:id/reply` | 2552 | public |
| 191 | POST | `/api/demand/:id/close` | 2565 | public |
| 192 | POST | `/api/demand/:id/report` | 2578 | public |
| 193 | GET | `/api/feedback/meta` | 2595 | public |
| 194 | POST | `/api/feedback` | 2599 | public |
| 195 | GET | `/api/self-listings` | 2617 | public |
| 196 | GET | `/api/self-listings/:id/matches/summary` | 2639 | public |
| 197 | GET | `/api/self-listings/:id/matches` | 2652 | public |
| 198 | POST | `/api/self-listings/:id/matches/:wishRef/offers` | 2674 | public |
| 199 | GET | `/api/rental-notify/prefs` | 2692 | public |
| 200 | PUT | `/api/rental-notify/prefs` | 2701 | public |
| 201 | GET | `/api/self-listings/:id/match-subscription` | 2710 | public |
| 202 | PUT | `/api/self-listings/:id/match-subscription` | 2719 | public |
| 203 | GET | `/api/wish-rooms/:id/survey` | 2728 | public |
| 204 | POST | `/api/wish-rooms/:id/survey` | 2737 | admin |
| 205 | GET | `/api/admin/rental-ops` | 2746 | admin |
| 206 | GET | `/api/admin/rental-ops/drill` | 2753 | admin |
| 207 | GET | `/api/wish-offers/inbox` | 2767 | public |
| 208 | GET | `/api/wish-offers/owner` | 2784 | public |
| 209 | GET | `/api/wish-offers/blocks` | 2801 | public |
| 210 | POST | `/api/wish-offers/blocks/:blockRef/remove` | 2814 | public |
| 211 | GET | `/api/wish-offers/:offerRef/contact` | 2827 | public |
| 212 | GET | `/api/wish-offers/:offerRef` | 2842 | public |
| 213 | POST | `/api/wish-offers/:offerRef/accept` | 2855 | public |
| 214 | POST | `/api/wish-offers/:offerRef/decline` | 2870 | public |
| 215 | POST | `/api/wish-offers/:offerRef/withdraw` | 2885 | public |
| 216 | POST | `/api/wish-offers/:offerRef/block` | 2900 | public |
| 217 | POST | `/api/wish-offers/:offerRef/report` | 2915 | public |
| 218 | GET | `/api/self-listings/:id` | 2931 | public |
| 219 | POST | `/api/self-listings` | 2944 | public |
| 220 | POST | `/api/self-listings/photos` | 2962 | public |
| 221 | GET | `/media/self/:file` | 2976 | public |
| 222 | GET | `/api/media` | 2988 | public |
| 223 | GET | `/api/media/tags` | 2997 | public |
| 224 | POST | `/api/media/tags` | 3005 | public |
| 225 | PATCH | `/api/media/tags/:id` | 3013 | public |
| 226 | DELETE | `/api/media/tags/:id` | 3021 | public |
| 227 | PUT | `/api/media/:id/tags` | 3029 | public |
| 228 | GET | `/api/media/by-tags` | 3037 | public |
| 229 | POST | `/api/media` | 3046 | public |
| 230 | DELETE | `/api/media/:id` | 3056 | public |
| 231 | GET | `/media/lib/:file` | 3065 | public |
| 232 | GET | `/api/public/self-listing/:id` | 3068 | public |
| 233 | GET | `/l/:id` | 3077 | public |
| 234 | GET | `/w/:id` | 3080 | public |
| 235 | GET | `/api/listing-imports/meta` | 3084 | public |
| 236 | GET | `/api/listing-imports` | 3091 | public |
| 237 | POST | `/api/listing-imports` | 3098 | public |
| 238 | GET | `/api/listing-imports/:id` | 3107 | public |
| 239 | PATCH | `/api/listing-imports/:id` | 3114 | public |
| 240 | POST | `/api/listing-imports/:id/cancel` | 3121 | public |
| 241 | POST | `/api/listing-imports/:id/confirm` | 3128 | public |
| 242 | POST | `/api/listing-imports/:id/publish` | 3135 | admin |
| 243 | GET | `/api/admin/listing-imports` | 3144 | admin |
| 244 | POST | `/api/self-listings/:id/copy` | 3150 | public |
| 245 | POST | `/api/self-listings/:id/publish` | 3157 | public |
| 246 | GET | `/api/listing-description-templates` | 3166 | public |
| 247 | POST | `/api/listing-description-templates` | 3173 | public |
| 248 | GET | `/api/listing-description-templates/:id` | 3180 | public |
| 249 | PATCH | `/api/listing-description-templates/:id` | 3187 | public |
| 250 | DELETE | `/api/listing-description-templates/:id` | 3194 | public |
| 251 | GET | `/api/listing-contact-profiles` | 3201 | public |
| 252 | POST | `/api/listing-contact-profiles` | 3208 | public |
| 253 | GET | `/api/listing-contact-profiles/:id` | 3215 | public |
| 254 | PATCH | `/api/listing-contact-profiles/:id` | 3222 | public |
| 255 | DELETE | `/api/listing-contact-profiles/:id` | 3229 | public |
| 256 | POST | `/api/self-listings/:id/close` | 3236 | public |
| 257 | POST | `/api/self-listings/:id/report` | 3249 | admin |
| 258 | POST | `/api/admin/self-listings/:id/hide` | 3262 | admin |
| 259 | POST | `/api/push/subscribe` | 3270 | public |
| 260 | POST | `/api/push/unsubscribe` | 3283 | admin |
| 261 | POST | `/api/admin/mail/test` | 3296 | admin |
| 262 | GET | `/api/settings` | 3593 | member |
| 263 | GET | `/api/member-mail` | 3603 | member |
| 264 | POST | `/api/change-password` | 3613 | public |
| 265 | POST | `/api/member-mail` | 3629 | member |
| 266 | POST | `/api/member-mail/test` | 3639 | member |
| 267 | GET | `/api/state` | 3665 | member |
| 268 | POST | `/api/commute/focus` | 3715 | member |
| 269 | GET | `/api/commute/snapshot` | 3725 | member |
| 270 | GET | `/api/listings` | 3741 | member |
| 271 | POST | `/api/listings/hide-many` | 3800 | member |
| 272 | POST | `/api/reset-listings` | 3811 | public |
| 273 | POST | `/api/reset-all` | 3826 | public |
| 274 | GET | `/api/listings/:id/history` | 3840 | member |
| 275 | POST | `/api/listings/:id/flags` | 3852 | member |
| 276 | POST | `/api/listings/:id/recheck` | 3902 | public |
| 277 | POST | `/api/listings/:id/report-gone` | 3973 | public |
| 278 | POST | `/api/listings/:id/reject-match` | 4034 | public |
| 279 | POST | `/api/listings/:id/confirm-match` | 4058 | public |
| 280 | POST | `/api/listings/merge-same-house` | 4082 | public |
| 281 | POST | `/api/settings` | 4152 | member |
| 282 | POST | `/api/profiles` | 4165 | member |
| 283 | POST | `/api/profiles/:id/load` | 4183 | member |
| 284 | DELETE | `/api/profiles/:id` | 4195 | member |
| 285 | POST | `/api/exclude-region` | 4206 | member |
| 286 | POST | `/api/watch` | 4224 | member |
| 287 | GET | `/api/events/revision` | 4239 | member |
| 288 | GET | `/api/events/stream` | 4249 | public |
