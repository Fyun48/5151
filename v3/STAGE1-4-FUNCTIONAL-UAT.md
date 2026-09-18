# Issue #333 — Consolidated Production Functional UAT (Stages 2–4)

Status: **DESIGNED, NOT YET EXECUTED.** No `ISSUE333_FINAL_UAT_PASS` is claimed anywhere.

## 1. Why this document exists

ChatGPT's 2026-09-18 08:06Z review verified the rollout itself as **PASS** (master `69dee72a`,
source `e4ced00`, digest `sha256:d209658c…`, backup `predeploy-20260918-063424`, all four stage
receipts, final flag snapshot) and identified **one** remaining gap against the original #333
contract: the Stage 2–4 postcheck is intentionally a **read-only** gate/flag/privacy probe. It does
not execute the deeper **functional** Production checks #333 originally required.

## 2. Constraints imposed by the review

- do not change feature flags, do not redeploy, do not modify code unless a true blocker appears
- keep Stage 1–4 flags ON; keep `digest_enabled` / `outbound_mail_enabled` / `outbound_push_enabled` OFF
- do not use real tenant PII
- capture exact source/digest and the final flag snapshot
- capture 4xx/5xx/`SQLITE_BUSY` and worker/dedup observations
- clean generated UAT data through existing domain APIs
- fail-closed on a real blocker; never weaken a gate
- reply with the exact conclusion `ISSUE333_FINAL_UAT_PASS` only when the single consolidated UAT passes

## 3. Verified starting point

| Item | Value |
| --- | --- |
| Production source | `e4ced0018f1994640ca7da02014cabfbfb6d8445` |
| Image digest | `sha256:d209658c5f3949f9e71bf6d5e081cf4e4e783dc10656894443f49535a2dddcb2` |
| Backup binding | `/DATA/AppData/591-tracker-v3-backups/predeploy-20260918-063424` / `sha256:bbd31a04…` |
| Flags | Stage 1–4 ON, all three outbound channels OFF |
| Container | `591-tracker-v3`, listener `http://127.0.0.1:5153` |

The UAT harness must re-read all four of these at run time and record them; it must not assume them.

## 4. Reusable building blocks (verified present in the repo)

| Need | Existing artefact |
| --- | --- |
| Fixture registry, namespace stamps, TTL, "cleaned" bookkeeping | `v3/src/stage1FixtureRegistry.js` |
| Product-surface hiding of fixture rows | `v3/src/stage1FixtureIsolation.js` (`STAGE1_FIXTURE_NAMESPACE`, `applyBrowseIsolation`) |
| Fixture prepare / verify / cleanup / reap-stale domain flow, already proven in Production | `v3/src/stage1FixtureOps.js` (`runStage1FixtureDomain`, `FIXTURE_MODES`) |
| Container-side execution pattern (`docker exec`, `/app/src` imports, `DATA_DIR=/data`) | `.github/scripts/activate-rental-marketplace-stage1-remote.sh` |
| Workflow shape (scp helpers, authorize fail-closed, evidence, upload, conclude) | `.github/workflows/activate-rental-marketplace-stages.yml` |
| Domain APIs for every functional item | see §5 |


## 5. Coverage matrix — 15 items, exact API and expected signal

### Stage 2 — `wish.offer_enabled` (`v3/src/wishOffers.js`, `wishOfferTransitions.js`)

| # | Item | Drive | Expected signal |
| --- | --- | --- | --- |
| 2.1 | eligible offer create | `assertCreateOfferGates(db,{ownerUserId,listingRow,wishRow})` then `insertPendingOffer(db,{ownerUserId,listingRow,wishRow,idempotencyKey})` | offer row `status='pending'`, `public_token` non-empty |
| 2.2 | duplicate / idempotency | `normalizeOfferIdempotencyKey(key)` + re-`insertPendingOffer` with the same key | single row kept; no second live offer for `(wish,owner)` |
| 2.3 | rate-limit / anti-abuse | `assertOfferBurst(actorKey)` past the cap, `recordOfferFail(actorKey)`, `countOwnerOffersSince(db,owner,24h)` | burst throws the documented 429 code; daily owner cap enforced |
| 2.4 | tenant accept / Double Consent | `acceptWishOffer(db,tenantUserId,offerRef)` with and without a required consent | accept without consent is refused by the consent gate; with consent transitions `pending→accepted` |
| 2.5 | authorized contact projection | `readOfferContact(db,userId,offerRef)` as owner, as tenant, as a third account | owner/tenant receive the projection; the third account is denied |
| 2.6 | block / report | `blockOwnerFromOffer(db,tenantUserId,offerRef)`, `reportWishOffer(db,userId,offerRef,{...})` | block recorded and the thread closed; report row written with the documented reason code |
| 2.7 | paused / completed / closed rejection | `liveMatchEligible(db,listingRow,wishRow,now)` for a paused, a completed and a closed wish | `eligible=false` and create returns `match_no_longer_eligible` (409) |

### Stage 3 — `wish.public_share_v2_enabled` (`v3/src/rentalShareGrowth.js`)

| # | Item | Drive | Expected signal |
| --- | --- | --- | --- |
| 3.1 | first-party share attribution | `recordShareEvent(db,{token,...})` against a controlled fixture wish with a real `public_token` | event row written and attributed to the right wish/listing |
| 3.2 | dedup | repeat the same `recordShareEvent` inside the dedup window | no second counted event; the dedup counter moves |
| 3.3 | CTA behaviour | `resolveValidShareToken(db,token)` + `shouldAttributeSignup({newlyCreated,source})` | a valid token resolves; CTA signup attributes once, a repeat signup does not |
| 3.4 | sentinel gate probe | live `POST /api/public/wish-room/<sentinel>/share-events` | already covered by the stages postcheck; kept as a regression anchor |

### Stage 4 — `owner_notifications_enabled` + `notifications_enabled` (`v3/src/rentalNotify.js`, `rentalNotifyWorker.js`)

| # | Item | Drive | Expected signal |
| --- | --- | --- | --- |
| 4.1 | in-app new-match event generation | `emitRentalNotifyEvent(db,{eventType,userId,eventKey,...})` for a new match | `emitted=true`, event row queued, dock row produced |
| 4.2 | event dedup / episode behaviour | repeat `emitRentalNotifyEvent` with the same `eventKey`, then start a new episode | duplicate is deduped (`notify_deduped` counter moves), a new episode emits again |
| 4.3 | preference suppression | `saveRentalNotifyPrefs(db,userId,{...})` then emit the suppressed type | `emitted=false` with the documented reason; no dock row |
| 4.4 | worker bounded / non-reentrant / backlog | `runRentalNotifyTick(db,now,{...})` twice plus one concurrent call | tick completes, never re-enters, backlog drains, no unbounded growth |
| 4.5 | blocked / closed / ineligible suppression | emit for a blocked or closed wish, and for an ineligible listing | `emitted=false`; no dock row |
| 4.6 | outbound stays OFF | inspect the three outbound sinks for the whole UAT | no mail/push/digest send is attempted (`outbound_*` stay false) |

## 6. Harness design

1. **One new workflow**, `production-uat-stages-functional.yml` (manual, `refs/heads/master`, reusing
   the fail-closed authorization block of `activate-rental-marketplace-stages.yml`): confirm string
   `UAT-STAGE1-4-PRODUCTION`, a per-run `owner_authorization` bound to source SHA + digest + backup id
   + backup hash, and `PRODUCTION_DEPLOY_ALLOWED_ACTOR` enforced for both actor fields.
2. **One new harness helper**, `.github/scripts/production-uat-stages-remote.sh` +
   `.github/scripts/production-uat-stages-domain.mjs`, in the exact shape of `runStage1FixtureDomain`:
   functions over an injected `db`, no raw SQL outside the existing domain APIs, returning a
   structured report. It runs **inside** the container via `docker exec` and imports the domain APIs
   from `/app/src/*.js` plus `/app/src/env.js`. See §10.1 for why this must NOT be a `v3/src` module.
3. **UAT namespace** `issue333-uat-<runid>`, stamped with the existing `stampFixtureNamespace` and
   registry so every generated row is (a) hidden from product surfaces by
   `stage1FixtureIsolation.js` and (b) discoverable for cleanup.
4. **Cleanup runs in the same workflow**: a `cleanup` phase reuses `cleanupStage1Fixtures` /
   `verifyCleanup` semantics, so the run cannot pass while rows remain. A `reap-stale` mode reuses
   `reapStaleStage1Fixtures` for abandoned runs (the 72h TTL already applies).
5. **No new mutation channel**: the harness may only call existing domain functions. If a required
   behaviour has no domain API, that is a **finding**, not something to work around with raw SQL.

## 7. Evidence and acceptance

`stages-functional-uat-evidence.json`, schema `rental-marketplace-stages-functional-uat/v1`:

- `identity`: source SHA, `src_tree_sha256`, image digest, backup id/hash, run id, workflow
- `flag_snapshot`: the ten `rental_catalog_v2` / `wish` keys from §3, before and after
- `items[]`: `{id, stage, check, expected, observed, status, http_status, code, sqlite_busy}`
- `probe_log`: every HTTP status and code, every `SQLITE_BUSY`, every worker tick duration
- `worker`: tick count, re-entrancy observations, backlog before/after
- `dedup`: dedup counters before/after
- `cleanup`: rows created, rows cleaned, `verifyCleanup` result
- `problems[]`: must be empty on PASS
- `conclusion`: `ISSUE333_FINAL_UAT_PASS` only when `problems` is empty and cleanup is verified

Acceptance: every §5 item is `status=pass`, `problems` empty, cleanup verified, and the flag snapshot
is unchanged apart from the UAT namespace rows.

## 8. Cleanup and rollback posture

- The UAT never changes feature flags, so there is nothing to roll back at the flag level.
- Every generated row lives under the UAT namespace and is removed by the cleanup phase; if cleanup
  fails, the run fails closed and records the namespace so `reap-stale` can finish the job.
- No real tenant data is read or written: every fixture account, listing and wish is generated.

## 9. Remaining work

The harness is a substantial build (a domain module roughly the size of `stage1FixtureOps.js`, plus
the workflow, the evidence writer and unit tests) and it must be unit-tested **before** it is ever
pointed at Production, because every Production iteration consumes real actions. It has **not** been
built or run yet. The correct next step is a reviewed change: new harness + tests → CI green → merge
→ a single consolidated UAT run → post the evidence and `ISSUE333_FINAL_UAT_PASS`.

## 10. Findings from the design pass (these change the plan)

### 10.1 BLOCKER — the harness must NOT live in `v3/src`

`/app/src` is a **bind mount** from the NAS host (the activation remote already asserts
`EXPECTED_SRC_MOUNT`), and the stage postchecks reach the domain APIs because the workflow scp's the
helper to `/tmp/...` and the helper then imports `/app/src/*.js`. Anything placed in `v3/src` is part
of the deployed runtime and therefore needs a deploy.

Because the review forbids a redeploy, the UAT harness must be a **`.github/scripts/production-uat-*.mjs`
helper** that is scp'd at run time and imports the domain APIs from `/app/src/...`. It must not be a
new `v3/src` module, and the design in §6.2 is corrected accordingly.

### 10.2 BLOCKER — every existing Stage 1 fixture mode now fails closed

`runStage1FixtureDomain()` calls `assertReadinessFlags()` for **every** mode, and that assertion
requires the later flags to be `false`. With Stage 1–4 ON it rejects the live posture. Proven
locally against the deployed code:

```text
PASS   pre-activation (owner_matching OFF) | mode=prepare/verify/cleanup
THROW  post-activation (Stage 1-4 ON) | mode=cleanup-activated
       -> fixture-before ... wish.offer_enabled must be false
THROW  post-activation (Stage 1-4 ON) | mode=cleanup / reap-stale
       -> fixture-before ... wish.owner_matching_enabled must be false
```

Two consequences:

1. The Phase A fixtures bound to `stage1-fix:20260918064529:35316208975` **can no longer be reaped
   through any existing mode**, because the readiness gate fires before the cleanup logic runs.
2. The UAT cannot reuse the Stage 1 fixture path to build its fixtures.

Recommended fix (needs a deploy, so it needs an explicit decision): widen the contract with a
backwards-compatible option, e.g. `assertReadinessFlags(flags, label, expectedOwnerMatching, {
allowActivatedStages })`, where the last three entries (`digest_enabled`, `outbound_mail_enabled`,
`outbound_push_enabled`) must stay `false` in every posture. The default keeps today's behaviour, so
existing callers and tests are unaffected. Until that ships, the UAT harness must build and clean its
own fixtures directly through the registry/isolation helpers and the domain create/delete APIs,
without calling `prepareStage1Fixtures` / `cleanupStage1Fixtures`.

### 10.3 Consequence for the single-run requirement

The review asks for **one** consolidated UAT. Given 10.1 and 10.2, one run can satisfy the 15
functional items, but the leftover Phase A fixtures are a **separate** remediation. This sheet
therefore proposes: one UAT run for the functional items, plus a follow-up (deploy the widened
readiness contract, then one `reap-stale` / `cleanup` run) so no fixture rows are left behind.


