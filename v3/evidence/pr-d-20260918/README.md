# PR D evidence pass — Issue #325 (benchmark + responsive)

Local, non-Production evidence for the two gaps the ChatGPT gate left open on #325:

- PART P / PART R items 12 + 26-27: representative seeded benchmark + index/EXPLAIN evidence
- PART N / PART R items 31-33: 375 / 768 / 1440 responsive evidence

Nothing here deploys, changes a Production flag, or writes to Production data.

## 1. Seeded path benchmark (`paths-bench.md`, `paths-bench.json`, `bench-paths.mjs`)

Seed (in-memory SQLite, `node:sqlite`): 12,000 users, 6,000 listings, 12,000 wishes,
8,000 offers, 30,000 notify events, 30,000 deliveries, 4,400 digest buckets,
2,000 subscriptions, 20,000 match-seen rows, 15,000 share events, 200 analytics days.
Flags measured (see `posture_measured` in `paths-bench.json`): Stage 1-4 in-app ON, **digest ON on
purpose so the digest bucket sweep is actually exercised by the benchmark**, outbound mail/push
OFF. The digest switch being ON is a property of this seeded benchmark; **Production today keeps
digest / mail / push OFF** until the outbound gate gets its own approval.

Headline numbers (median of 3-5 runs, Windows x64, Node 24.13.0):

| path | median ms | result |
|---|---|---|
| notify worker tick end to end (`runRentalNotifyTick`) | 87.4 | full tick, all sweeps |
| digest bucket close | 31.8 | closed 80 / scanned 80 |
| offer expiring sweep | 21.3 | scanned 80 / emitted 80 |
| tenant retention sweep | 15.8 | scanned 80 / emitted 40 |
| due lifecycle reminders | 13.8 | scanned 80 / emitted 43 |
| owner retention sweep | 11.7 | scanned 80 / emitted 40 |
| pending delivery retry | 7.0 | delivered 80, failed 0 |
| new-match eligibility recheck | 1.15 | scanned 4 / closed 0 |
| analytics timeseries range | 1.61 | 93-day clamp |
| event/delivery cleanup | 0.86 | retention 180d |
| completion survey due lookup | 0.43 | bounded 80 |
| admin drill-down page | 0.38 | page cap 20/50 |
| owner subscription lookup | 0.115 | bounded 80 |
| digest bucket lookup | 0.098 | item cap 8 |
| survey aggregate (bounded range) | 0.088 | GROUP BY found_via_site |
| notification dedup lookup | 0.068 | UNIQUE event_key |
| attribution conversion write / lookup | 0.038 / 0.004 | dedup / token lookup |
| new-match notification dedup | 0.005 | rental_match_seen lookup |

The existing repo bound is `elapsed < 200ms` for the notify EXPLAIN probe plus the
seeded dedup/retry queries (`v3/test/rental-notify.test.js:449`); every path above is
far inside it and no threshold was relaxed.

EXPLAIN QUERY PLAN — **24 paths in total: 23 are index SEARCH paths with no SCAN node, and 1
contains a SCAN node** (`notify.admin_drill`):

- the 23 index SEARCH paths include covering indexes for deliveries retry, digest buckets,
  subscriptions, share lookup, offers, tenant retention and the analytics metric range
  (`paths-bench.md` lists each path with its index and SEARCH/SCAN counts)
- the single SCAN is the admin drill-down
  (`... FROM wish_offers WHERE created_at >= ? AND created_at <= ? ORDER BY created_at
  DESC, id DESC LIMIT 21`) — **0.38 ms at 8,000 offers**, bounded by the LIMIT, no
  unbounded COUNT and no N+1. Recorded as an observation, not changed here.

## 2. Responsive evidence (`responsive.json`, `focus.json`, `shots/`)

Target: the local evidence server running the **deployed master code** (same app as
Production) with a seeded owner / tenant / listing / wish / offer / notification state.
The server is started with the same anti-bot path intact; logins go through
`POST /api/login` with a captcha minted in-process for this local instance.

**21 screenshots**: 7 PR D acceptance surfaces × 375 / 768 / 1440. Each entry in
`responsive.json` records the interaction steps that were performed and whether the
expected panel/section was actually visible afterwards (`steps[].expect.visible`), so the
surfaces are exercised through their real UI entry points instead of only being present in
the DOM:

| surface | what the capture shows | how it is reached |
|---|---|---|
| `public-share-cta` | public share page v2 CTA (anonymous visitor) | `/w/<token>` with no session |
| `tenant-notify-prefs` | tenant notification preferences / lifecycle switches | `[data-nav="notify"]` then `[data-hub-tab="rental"]` |
| `tenant-wish-room` | tenant wish room as the owner of that wish | `/w/<token>` as the tenant |
| `tenant-wish-lifecycle` | wish lifecycle states and controls | `[data-nav="demand"]` (`#wishLifecycleBar` visible) |
| `tenant-survey` | completion survey UI | `已找到房` (`#wishCompleteBtn`) on the seeded open wish |
| `owner-match-subscription` | owner new-match subscription controls | `[data-nav="post"]` then `[data-self-matches]` (查看符合需求) |
| `admin-rental-ops` | admin Rental Operations Analytics, panel loaded | `/admin.html#rental/ops` then `#rentalOpsLoad` → `#rentalOpsSummary` rendered |

Measured (see `responsive.json` / `focus.json` for per-surface detail):

- **horizontal overflow: 0 px on all 21 captures**, and no element extends past the viewport
- **unnamed controls: 0** on all 21 captures
- **touch targets below the issue's 44 px line: 0** on all 21 captures (§2.1)
- **keyboard focus**: `focus-probe.mjs` walks **every PR D surface at all three widths** with real
  Tab key events until focus wraps back to the first stop — 21 surface runs, **266 distinct tab
  stops, 0 failures**; each stop matches `:focus-visible`, exposes a visible indicator
  (`outline: solid 2px rgb(15,111,106)` or the UA `auto 1px` ring) and has an accessible name
  resolved as `aria-labelledby` → `aria-label` → `<label>` → `title` → text → placeholder (the
  source used is recorded per stop in `focus.json`)
- the admin Rental Operations Analytics panel/table/chart is really opened and rendered before the
  capture; hidden admin panels still report width 0 until their tab is opened, so only the opened
  panel is covered

### 2.1 44 px touch-target remediation (PART N)

The earlier pass reported small targets; they are fixed in this PR rather than waived:

- `v3/public/tokens.css`: `--btn-height` 40 → **44** and `--chip-height` 32 → **44** (`--touch`
  was already 44), plus a documented rule set that gives `button`, `[role="button"]`,
  `[role="tab"]`, inputs (except `checkbox`/`radio`), `select`, `textarea` and standalone
  (non-`p a`) links `min-height: var(--touch)`
- `v3/public/index.html`: five hard-coded `min-height: 32px` control rules (mobile help dock,
  `button.tag`, filter head actions, site notice ghost, `#openFilterSheetBtn`) now read
  `var(--touch)`
- native `checkbox` / `radio` boxes stay 24 px (WCAG 2.5.8 AA) and their **wrapping label** carries
  the 44 px target; the measurement counts the label as the control for those two input types and
  says so here instead of silently skipping them
- `v3/public/index.html`: 31 `<label>` elements that sat next to an input without `for=` are now
  associated (`for="<id>"`). This is what made those inputs report "no accessible name" in the
  earlier probe — a real a11y gap, fixed at the producer
- inline links inside running text (`p a`) intentionally keep text size: they are not controls

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

`data/` (the generated SQLite file plus the generated credential and token files) is gitignored
and recreated by the seed script; the credential never enters the repository.

Two environment notes that matter when re-running the responsive pass:

- the server reads `index.html` once at boot, so **copy the changed `v3/public/**` files and
  restart it** before re-measuring, otherwise the browser keeps seeing the previous markup
- the `tenant-survey` capture completes the seeded tenant's open wish through the real UI (that is
  how the survey overlay opens), so **re-run `seed-local.mjs` between a capture run and a focus
  run** to give every width a fresh open wish; use `EVIDENCE_ONLY=<surface,...>` and
  `EVIDENCE_WIDTHS=375` for a single-surface iteration.
