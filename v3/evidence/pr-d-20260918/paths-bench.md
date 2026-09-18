# PR D seeded path benchmark — 2026-09-18T15:02:07.888Z

node v24.13.0 / win32 x64; in-memory SQLite; seed 5865.97 ms; total 6426.999 ms

| path | median ms | min | max | iters | bounds/notes | result |
|---|---|---|---|---|---|---|
| due lifecycle reminders (scheduleLifecycleReminders) | 13.895 | 13.573 | 14.091 | 3 | bounded 80/tick, cursor-paged | {"scanned":80,"emitted":43} |
| notification dedup lookup (emitRentalNotifyEvent, second call) | 0.072 | 0.06 | 0.096 | 5 | UNIQUE event_key dedup path | {"emitted":false,"reason":"deduped","event_key":"<redacted-token>","event_id":30129} |
| pending delivery retry (deliverQueuedNotifications) | 6.501 | 6.337 | 7.565 | 3 | bounded 80/batch | {"scanned":80,"delivered":80,"failed":0} |
| digest bucket lookup (addDigestItem) | 0.092 | 0.073 | 0.125 | 5 | item cap 8/bucket | {"id":10,"public_token":"<redacted-token>","user_id":11,"channel":"dock","bucket_date":"2026-09-17","kind":"owner_new_match","status":"open","item_count":3,"overflow_count":0,"created_at":"2026-09-17T12:00:00.000Z"} |
| owner subscription lookup (listDueMatchSubscriptions) | 0.121 | 0.11 | 0.137 | 5 | bounded 80/tick | {"rows":80} |
| new-match notification dedup (openMatchEpisodeIfNeeded) | 0.005 | 0.005 | 0.007 | 5 | rental_match_seen lookup | {"notify":false,"episode":1} |
| new-match eligibility recheck (recheckSeenMatchEligibility) | 0.905 | 0.808 | 0.985 | 3 | bounded 80/batch | {"scanned":4,"closed":0} |
| completion survey due lookup (raw path used by the notify tick) | 0.408 | 0.402 | 0.436 | 5 | bounded 80 | {"rows":80} |
| survey aggregate over a bounded range (surveyAggregate) | 0.064 | 0.062 | 0.068 | 5 | GROUP BY found_via_site | {"rows":1} |
| analytics timeseries range (rentalOpsSummary) | 1.514 | 1.47 | 1.703 | 5 | range clamp 93 days | {"keys":7} |
| admin drill-down pagination (rentalOpsDrilldown offers) | 0.402 | 0.393 | 0.471 | 5 | page cap 50 | {"kind":"offers","next_cursor":20} |
| attribution conversion lookup (resolveValidShareToken) | 0.004 | 0.004 | 0.005 | 5 | token lookup | {"value":"<redacted-token>"} |
| attribution conversion write (recordShareEvent signup, server source) | 0.035 | 0.017 | 0.252 | 3 | server-source conversion; public cta/server is refused by design | {"recorded":false,"reason":"deduped","is_bot":false} |
| offer expiring sweep (scheduleOfferExpiring) | 21.14 | 21.115 | 21.199 | 3 | bounded 80/tick | {"scanned":80,"emitted":80} |
| tenant retention sweep (scheduleTenantRetention) | 15.196 | 14.723 | 15.706 | 3 | bounded 80/tick | {"scanned":80,"emitted":40,"skipped_policy":0} |
| owner retention sweep (scheduleOwnerRetention) | 11.856 | 11.759 | 13.2 | 3 | bounded 80/tick | {"scanned":80,"emitted":40} |
| digest bucket close (closeDigestBuckets) | 30.898 | 30.57 | 31.311 | 3 | bounded 80/tick | {"closed":80,"scanned":80} |
| event/delivery cleanup (cleanupRentalNotify) | 0.854 | 0.722 | 1.047 | 3 | retention 180d events | {"events":0,"share":0} |
| notify worker tick end to end (runRentalNotifyTick) | 87.619 | 47.918 | 92.932 | 3 | the real worker entry point | {"skipped":false} |

## EXPLAIN QUERY PLAN (index usage)

| path | indexes | SEARCH nodes | SCAN nodes |
|---|---|---|---|
| notify.lifecycle_due | idx_demand_posts_status | 1 | 0 |
| notify.notify_dedup | cover:sqlite_autoindex_rental_notify_events_1 | 1 | 0 |
| notify.delivery_retry | cover:idx_rental_notify_deliveries_retry | 1 | 0 |
| notify.digest_bucket | cover:sqlite_autoindex_rental_digest_buckets_2 | 1 | 0 |
| notify.match_sub | cover:idx_rental_match_subs_owner | 1 | 0 |
| notify.match_seen | sqlite_autoindex_rental_match_seen_1 | 1 | 0 |
| notify.survey_due | idx_demand_lifecycle_expires | 1 | 0 |
| notify.analytics_range | idx_rental_analytics_metric | 1 | 0 |
| notify.share_lookup | cover:idx_rental_share_lookup | 1 | 0 |
| notify.offer_expiring | cover:idx_wish_offers_expires | 1 | 0 |
| notify.tenant_retention | cover:idx_demand_lifecycle_active | 1 | 0 |
| notify.admin_drill | - | 0 | 1 |
| offer.owner_daily | cover:idx_wish_offers_owner_keyset | 1 | 0 |
| offer.listing_daily | cover:idx_wish_offers_listing_created | 1 | 0 |
| offer.wish_pending | cover:idx_wish_offers_wish_status | 1 | 0 |
| offer.tenant_inbox | cover:idx_wish_offers_tenant_inbox | 1 | 0 |
| offer.owner_sent | cover:idx_wish_offers_owner_status | 1 | 0 |
| offer.owner_keyset | cover:idx_wish_offers_owner_created | 1 | 0 |
| offer.tenant_keyset | cover:idx_wish_offers_tenant_inbox | 1 | 0 |
| offer.owner_total | cover:idx_wish_offers_owner_keyset | 1 | 0 |
| offer.tenant_pending_count | cover:idx_wish_offers_tenant_status_keyset | 1 | 0 |
| offer.expiry | cover:idx_wish_offers_expires | 1 | 0 |
| offer.block_lookup | cover:sqlite_autoindex_user_blocks_2 | 1 | 0 |
| offer.report_rate | cover:idx_wish_offer_reports_reporter_created | 1 | 0 |

## Row counts after seeding

- users: 12000
- listings: 6000
- demand_posts: 12000
- wish_offers: 8000
- rental_notify_events: 30000
- rental_notify_deliveries: 30000
- rental_digest_buckets: 3400
- rental_digest_items: 4400
- rental_match_subscriptions: 2000
- rental_match_seen: 12000
- rental_share_events: 15000
- rental_analytics_daily: 403
- rental_completion_surveys: 600
