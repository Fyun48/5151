# PR D evidence pass — Issue #325 (benchmark + responsive)

Local, non-Production evidence for the two gaps the ChatGPT gate left open on #325:

- PART P / PART R items 12 + 26-27: representative seeded benchmark + index/EXPLAIN evidence
- PART N / PART R items 31-33: 375 / 768 / 1440 responsive evidence

Nothing here deploys, changes a Production flag, or writes to Production data.

## 1. Seeded path benchmark (`paths-bench.md`, `paths-bench.json`, `bench-paths.mjs`)

Seed (in-memory SQLite, `node:sqlite`): 12,000 users, 6,000 listings, 12,000 wishes,
8,000 offers, 30,000 notify events, 30,000 deliveries, 4,400 digest buckets,
2,000 subscriptions, 20,000 match-seen rows, 15,000 share events, 200 analytics days.
Flags measured: Stage 1-4 in-app ON, digest ON, outbound mail/push OFF — the posture
Production runs today.

Headline numbers (median of 3-5 runs, Windows x64, Node 24.13.0):

| path | median ms | result |
|---|---|---|
| notify worker tick end to end (`runRentalNotifyTick`) | 84.2 | full tick, all sweeps |
| offer expiring sweep | 21.7 | scanned 80 / emitted 80 |
| digest bucket close | 31.6 | closed 80 |
| tenant retention sweep | 15.4 | scanned 80 / emitted 40 |
| due lifecycle reminders | 13.8 | scanned 80 / emitted 43 |
| owner retention sweep | 11.6 | scanned 80 / emitted 40 |
| pending delivery retry | 7.5 | delivered 80, failed 0 |
| analytics timeseries range | 1.7 | 93-day clamp |
| admin drill-down page | 0.38 | page cap 20/50 |
| notification dedup lookup | 0.078 | UNIQUE event_key |
| digest bucket lookup | 0.10 | item cap 8 |
| owner subscription lookup | 0.13 | bounded 80 |
| new-match dedup / recheck | 0.006 / 0.8 | bounded |
| survey due / aggregate | 0.41 / 0.06 | bounded |
| attribution lookup / write | 0.004 / 0.034 | token + conversion dedup |

The existing repo bound is `elapsed < 200ms` for the notify EXPLAIN probe plus the
seeded dedup/retry queries (`v3/test/rental-notify.test.js:449`); every path above is
far inside it and no threshold was relaxed.

EXPLAIN QUERY PLAN: 22 of 23 paths resolve to an index `SEARCH` (covering indexes for
deliveries retry, digest bucket, subscriptions, share lookup, offers, tenant
retention). One path is a bounded `SCAN`: the admin drill-down
(`... FROM wish_offers WHERE created_at >= ? AND created_at <= ? ORDER BY created_at
DESC, id DESC LIMIT 21`) — 0.38 ms at 8,000 offers, bounded by the LIMIT, no
unbounded COUNT and no N+1. Recorded as an observation, not changed here.

## 2. Responsive evidence (`responsive.json`, `focus.json`, `shots/`)

Target: the local evidence server running the **deployed master code** (same app as
Production) with a seeded owner / tenant / listing / wish / offer / notification state.
The server is started with the same anti-bot path intact; logins go through
`POST /api/login` with a captcha minted in-process for this local instance.

12 screenshots at 375 / 768 / 1440 of the PR D surfaces reachable per role:
`public-home` (share/browse), `tenant-wish-room` (`/w/<token>`, logged in as the
tenant), `owner-listing-match` (`/?self=<post_id>`, logged in as the owner/admin),
`admin-console` (`/admin.html`, admin incl. rental analytics panels).

Measured (see `responsive.json` for per-page detail):

- **horizontal overflow: 0 px on all 12 captures**, and no element extends past the
  viewport (`wide_elements` empty everywhere)
- **unnamed controls: 0** — every visible `button` / `[role=button]` has an accessible
  name
- **keyboard focus: visible** — `focus-probe.mjs` presses real Tab key events and every
  stop matches `:focus-visible` with `outline: solid 2px rgb(15,111,106)`
  (`focus.json`)
- **touch targets below the issue's 44 px line** at 375 px: 10 on `public-home`,
  2 on `tenant-wish-room`, 10 on `owner-listing-match`, 10 on `admin-console`. Most are
  30-43 px tall (header links 56×32, filter buttons 154×32, admin menu rows 279×30,
  主選單 input 335×43); the smallest are a footer link (49×17) and one 48×18 button.
  Metrics beyond 24 px is the WCAG 2.5.8 AA threshold, so this is a 44 px-guideline gap
  rather than an AA failure — fixing it is a design-system change and is deliberately
  **not** bundled into this evidence pass.
- admin tables: 11 `table` nodes exist but the hidden panels report width 0 until their
  tab is opened, so only the rendered panel is verified visually; there is no
  `scrollWidth > clientWidth` overflow on the rendered ones.

## 3. Reproduce

```bash
node v3/evidence/pr-d-20260918/bench-paths.mjs              # benchmark + EXPLAIN
node v3/evidence/pr-d-20260918/seed-local.mjs               # local evidence DB + generated credential file
# start the app against that DB, passing the generated credential from the gitignored file:
#   EVIDENCE_PASSWORD=$(node -e "console.log(require('./v3/evidence/pr-d-20260918/data/credentials.json').password)")
#   AUTH_EMAIL=owner@evidence.test AUTH_PASSWORD="$EVIDENCE_PASSWORD" SESSION_SECRET=<generated>\
#   DATA_DIR=v3/evidence/pr-d-20260918/data PORT=5199 node v3/src/server.js
EVIDENCE_BASE_URL=http://127.0.0.1:5199 node v3/evidence/pr-d-20260918/capture-responsive.mjs
EVIDENCE_BASE_URL=http://127.0.0.1:5199 node v3/evidence/pr-d-20260918/focus-probe.mjs
```

`data/` (the generated SQLite file and the generated credential file) is gitignored and
recreated by the seed script; the credential never enters the repository.
