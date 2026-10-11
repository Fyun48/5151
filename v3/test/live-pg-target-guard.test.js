// live PG 目標庫守衛的反例測試（2026-10-11）。
//
// 這一支要證明的是「擋得住」，不是「寫了註解」：
//   1. `assertPgTargetAllowed()` 對指向正式庫 `5151_shadow` 的連線字串**丟錯**（不預設放行）。
//   2. 共用的 `livePgTargetSkip()` 會把它變成非空的 skip 理由（＝live 測試整支略過、不建立連線）。
//   3. **端到端**：真的拿一個指向 `5151_shadow` 的假連線字串去跑一支既有 live 測試，
//      該測試必須被 skip、行程必須 exit 0、而且**完全沒有嘗試連線**（沒有 ECONNREFUSED）。
//
// 用的假連線字串是 `127.0.0.1:1`（一定連不上），所以「有沒有連」看得出來。
// 測試本身**不需要任何資料庫**，可以離線跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ALLOWED_PG_TARGET_DBS, assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { livePgTargetSkip } from "./helpers/livePgTarget.js";

// 指向正式庫、但保證連不上的假字串（值本身不是憑證）。
const FAKE_PROD_URL = "postgres://x@127.0.0.1:1/5151_shadow";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET_TEST = "v3/test/settings-driver-parity.test.js";

test("assertPgTargetAllowed：指向 5151_shadow 的連線字串必須丟錯（不得預設放行）", () => {
  assert.throws(
    () => assertPgTargetAllowed("live-pg-guard-test", FAKE_PROD_URL, { env: {} }),
    /不在允許清單/,
  );
  assert.ok(!ALLOWED_PG_TARGET_DBS.includes("5151_shadow"), "正式庫不得出現在允許清單內");
});

test("livePgTargetSkip：白名單外回傳 skip 理由、白名單內回傳 false、未設定回傳未設定", async () => {
  const refused = await livePgTargetSkip("live-pg-guard-test", FAKE_PROD_URL);
  assert.equal(typeof refused, "string");
  assert.match(refused, /不在允許清單/);

  for (const db of ALLOWED_PG_TARGET_DBS) {
    assert.equal(
      await livePgTargetSkip("live-pg-guard-test", `postgres://u:p@127.0.0.1:1/${db}`),
      false,
      `${db} 在允許清單內 ⇒ 不該被擋`,
    );
  }

  assert.match(await livePgTargetSkip("live-pg-guard-test", ""), /未設定/);
});

test("livePgTargetSkip：預設讀 process.env.PG_TEST_URL（把環境變數指到正式庫就被擋）", async () => {
  const before = process.env.PG_TEST_URL;
  try {
    process.env.PG_TEST_URL = FAKE_PROD_URL;
    const reason = await livePgTargetSkip("live-pg-guard-test");
    assert.match(reason, /不在允許清單/);
  } finally {
    if (before === undefined) delete process.env.PG_TEST_URL;
    else process.env.PG_TEST_URL = before;
  }
});

test("端到端：PG_TEST_URL 指向正式庫時，live 測試被 skip、exit 0、且完全沒有嘗試連線", () => {
  const res = spawnSync(process.execPath, ["--test", TARGET_TEST], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180000,
    env: (() => {
      const env = {
        ...process.env,
        PG_TEST_URL: FAKE_PROD_URL,
        PG_URL: "",
        PGHOST: "",
        PG_LIVE_REPRO_URL: "",
        ALLOW_PRODUCTION_PG_TARGET: "",
      };
      // 拿掉 node:test 的「遞迴」標記，子行程才會真的跑這個檔案。
      // 留著的話它只會印一句 warning 就什麼都不跑 —— 那會讓這條測試變成假綠。
      delete env.NODE_TEST_CONTEXT;
      return env;
    })(),
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;

  assert.equal(res.status, 0, `被擋下來應該是「略過」而不是失敗：\n${out.slice(-2000)}`);
  assert.match(out, /# tests [1-9]\d*/, "子行程必須真的跑了測試（不能被 node:test 的遞迴保護整批跳過）");
  assert.match(out, /# pass [1-9]\d*/, "要真的有測試通過");
  assert.match(out, /# fail 0/, "不得有失敗");
  assert.match(out, /skip/i, "要被標成 skip");
  assert.match(out, /不在允許清單/, "skip 理由要明講目標庫不在允許清單");
  assert.doesNotMatch(out, /ECONNREFUSED/, "不該真的去連那個假目標（連了才會 ECONNREFUSED）");
  assert.doesNotMatch(out, /# fail [1-9]/, "不得有失敗");
});
