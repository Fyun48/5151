import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPraOnLaterOff,
  runStage1Domain,
  STAGE2_PLUS_FLAGS,
} from "../../.github/scripts/activate-rental-marketplace-stage1-domain.mjs";

function flags(stage1 = false, extra = {}) {
  return {
    rental_catalog_v2: { enabled: true },
    wish: {
      lifecycle_enabled: true,
      owner_matching_enabled: stage1,
      offer_enabled: false,
      public_share_v2_enabled: false,
      owner_notifications_enabled: false,
      notifications_enabled: false,
      digest_enabled: false,
      outbound_mail_enabled: false,
      outbound_push_enabled: false,
      ...extra,
    },
  };
}

function memoryDb(rows = []) {
  return {
    prepare(sql) {
      return {
        get() {
          if (/COUNT\(\*\)/.test(sql) && /demand_posts/.test(sql)) {
            if (/status/.test(sql)) {
              return { n: rows.filter((row) => row.status === "open").length };
            }
            return { n: rows.length };
          }
          return { n: 0 };
        },
        all() {
          const grouped = new Map();
          for (const row of rows) {
            const key = `${row.lifecycle || "active"}|${row.status || "open"}`;
            grouped.set(key, (grouped.get(key) || 0) + 1);
          }
          return [...grouped.entries()].map(([key, n]) => {
            const [lifecycle, status] = key.split("|");
            return { lifecycle, status, n };
          });
        },
      };
    },
  };
}

function harness({ initial = flags(false), posts = [], saveImpl } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "stage1-domain-"));
  let current = structuredClone(initial);
  const writes = [];
  const deps = {
    db: memoryDb(posts),
    getRentalMarketplaceFlags: () => structuredClone(current),
    saveRentalMarketplaceFlags: (partial) => {
      writes.push(structuredClone(partial));
      if (saveImpl) return saveImpl(partial, current, (next) => { current = next; });
      current = {
        ...current,
        ...partial,
        rental_catalog_v2: { ...current.rental_catalog_v2, ...(partial.rental_catalog_v2 || {}) },
        wish: { ...current.wish, ...(partial.wish || {}) },
      };
    },
    statusPath: path.join(dir, "status.json"),
    resultPath: path.join(dir, "result.json"),
  };
  return {
    deps,
    writes,
    dir,
    readStatus: () => JSON.parse(readFileSync(deps.statusPath, "utf8")),
    readResult: () => JSON.parse(readFileSync(deps.resultPath, "utf8")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("Stage 1 happy path only turns owner_matching on and keeps PRA on / later flags off", () => {
  const h = harness({ posts: [{ lifecycle: "active", status: "open" }] });
  const result = runStage1Domain({ ...h.deps, mode: "activate" });
  assert.equal(result.mode, "activate");
  assert.equal(result.before_raw_flags.wish.owner_matching_enabled, false);
  assert.equal(result.after_raw_flags.wish.owner_matching_enabled, true);
  assert.equal(result.after_raw_flags.rental_catalog_v2.enabled, true);
  assert.equal(result.after_raw_flags.wish.lifecycle_enabled, true);
  for (const key of STAGE2_PLUS_FLAGS) {
    assert.equal(result.after_raw_flags.wish[key], false, key);
  }
  assert.deepEqual(h.writes, [{ wish: { owner_matching_enabled: true } }]);
  assert.deepEqual(result.before_counts, result.after_counts);
  assert.equal(h.readStatus().phase, "after-verify");
  h.cleanup();
});

test("Stage 1 inspect never mutates", () => {
  const h = harness();
  const result = runStage1Domain({ ...h.deps, mode: "inspect" });
  assert.equal(result.mode, "inspect");
  assert.equal(h.writes.length, 0);
  assert.equal(result.raw_flags.wish.owner_matching_enabled, false);
  h.cleanup();
});

test("Stage 1 activate fail-closes unexpected PRA flags before mutation", () => {
  const off = harness({
    initial: {
      rental_catalog_v2: { enabled: false },
      wish: flags(false).wish,
    },
  });
  assert.throws(
    () => runStage1Domain({ ...off.deps, mode: "activate" }),
    /rental_catalog_v2.enabled must be true/,
  );
  assert.equal(off.writes.length, 0);
  off.cleanup();

  const life = harness({
    initial: {
      rental_catalog_v2: { enabled: true },
      wish: { ...flags(false).wish, lifecycle_enabled: false },
    },
  });
  assert.throws(
    () => runStage1Domain({ ...life.deps, mode: "activate" }),
    /lifecycle_enabled must be true/,
  );
  assert.equal(life.writes.length, 0);
  life.cleanup();
});

test("Stage 1 activate fail-closes when any Stage 2-4 or outbound flag is already ON", () => {
  for (const key of STAGE2_PLUS_FLAGS) {
    const h = harness({ initial: flags(false, { [key]: true }) });
    assert.throws(
      () => runStage1Domain({ ...h.deps, mode: "activate" }),
      new RegExp(`${key} must be false`),
    );
    assert.equal(h.writes.length, 0);
    h.cleanup();
  }
});

test("Stage 1 owner_matching already ON is idempotent and does not write again", () => {
  const h = harness({ initial: flags(true) });
  const first = runStage1Domain({ ...h.deps, mode: "activate" });
  const second = runStage1Domain({ ...h.deps, mode: "activate" });
  assert.equal(first.mode, "activate-already-on");
  assert.equal(second.mode, "activate-already-on");
  assert.equal(h.writes.length, 0);
  assert.equal(first.after_raw_flags.wish.owner_matching_enabled, true);
  assert.equal(first.after_raw_flags.wish.lifecycle_enabled, true);
  h.cleanup();
});

test("Stage 1 already-on with a later flag ON is not treated as replay success", () => {
  const h = harness({ initial: flags(true, { offer_enabled: true }) });
  assert.throws(
    () => runStage1Domain({ ...h.deps, mode: "activate" }),
    /offer_enabled must be false/,
  );
  assert.equal(h.writes.length, 0);
  h.cleanup();
});

test("Stage 1 post-activation verify failure compensates only owner_matching and keeps PRA ON", () => {
  let phase = "before";
  const h = harness({
    saveImpl(partial, current, setCurrent) {
      if (partial?.wish?.owner_matching_enabled === true) {
        phase = "poison";
        setCurrent({
          ...flags(true),
          wish: { ...flags(true).wish, offer_enabled: true },
        });
        return;
      }
      phase = "rolled";
      setCurrent(flags(false));
    },
  });
  h.deps.getRentalMarketplaceFlags = () => {
    if (phase === "before") return flags(false);
    if (phase === "poison") return { ...flags(true), wish: { ...flags(true).wish, offer_enabled: true } };
    return flags(false);
  };
  assert.throws(
    () => runStage1Domain({ ...h.deps, mode: "activate" }),
    /offer_enabled must be false/,
  );
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[0], { wish: { owner_matching_enabled: true } });
  assert.deepEqual(h.writes[1], { wish: { owner_matching_enabled: false } });
  const result = h.readResult();
  assert.equal(result.mode, "activate-compensated");
  assert.equal(result.after_raw_flags.wish.owner_matching_enabled, false);
  assert.equal(result.after_raw_flags.rental_catalog_v2.enabled, true);
  assert.equal(result.after_raw_flags.wish.lifecycle_enabled, true);
  assert.equal(h.readStatus().phase, "rolled-back-in-process");
  h.cleanup();
});

test("Stage 1 rollback failure is marked PRODUCTION_STATE_UNKNOWN", () => {
  let phase = "before";
  const h = harness({
    saveImpl(partial) {
      if (partial?.wish?.owner_matching_enabled === true) {
        phase = "poison";
        return;
      }
      throw new Error("cannot compensate");
    },
  });
  h.deps.getRentalMarketplaceFlags = () => {
    if (phase === "before") return flags(false);
    return { ...flags(true), wish: { ...flags(true).wish, offer_enabled: true } };
  };
  assert.throws(
    () => runStage1Domain({ ...h.deps, mode: "activate" }),
    /cannot compensate/,
  );
  assert.equal(h.readStatus().phase, "PRODUCTION_STATE_UNKNOWN");
  assert.equal(h.readResult().mode, "PRODUCTION_STATE_UNKNOWN");
  h.cleanup();
});

test("Stage 1 explicit rollback only turns owner_matching off", () => {
  const h = harness({ initial: flags(true) });
  const result = runStage1Domain({ ...h.deps, mode: "rollback" });
  assert.equal(result.mode, "rollback");
  assert.deepEqual(h.writes, [{ wish: { owner_matching_enabled: false } }]);
  assert.equal(result.after_raw_flags.wish.owner_matching_enabled, false);
  assert.equal(result.after_raw_flags.rental_catalog_v2.enabled, true);
  assert.equal(result.after_raw_flags.wish.lifecycle_enabled, true);
  h.cleanup();
});

test("Stage 1 concurrent replay stays safe: second activate is a no-write already-on", () => {
  const shared = { current: flags(false), writes: [] };
  const make = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stage1-conc-"));
    return {
      dir,
      deps: {
        db: memoryDb(),
        getRentalMarketplaceFlags: () => structuredClone(shared.current),
        saveRentalMarketplaceFlags: (partial) => {
          shared.writes.push(structuredClone(partial));
          shared.current = {
            ...shared.current,
            wish: { ...shared.current.wish, ...partial.wish },
          };
        },
        statusPath: path.join(dir, "status.json"),
        resultPath: path.join(dir, "result.json"),
      },
    };
  };
  const a = make();
  const b = make();
  const first = runStage1Domain({ ...a.deps, mode: "activate" });
  const second = runStage1Domain({ ...b.deps, mode: "activate" });
  assert.equal(first.mode, "activate");
  assert.equal(second.mode, "activate-already-on");
  assert.equal(shared.writes.length, 1);
  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});

test("assertPraOnLaterOff rejects Stage2-4 while requiring PRA ON", () => {
  assert.doesNotThrow(() => assertPraOnLaterOff(flags(false), "ok", false));
  assert.throws(() => assertPraOnLaterOff(flags(false, { outbound_push_enabled: true }), "x", false), /outbound_push_enabled/);
  assert.throws(
    () => assertPraOnLaterOff({ rental_catalog_v2: { enabled: true }, wish: { ...flags(false).wish, lifecycle_enabled: false } }, "x", false),
    /lifecycle_enabled/,
  );
});
