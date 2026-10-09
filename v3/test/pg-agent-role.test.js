import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { roleStatus, startServers } from "../../deploy/shadow-ha/pg-agent/agent.mjs";

/** 連到 agent 埠、讀一行、等連線結束（server 會 `end()`）。 */
function readAgentLine(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let data = "";
    let ended = false;
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error(`timeout reading agent port ${port}`));
    });
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => {
      ended = true;
    });
    socket.on("close", () => resolve({ line: data, ended }));
    socket.on("error", reject);
  });
}

test("roleStatus: recovery=f（primary）→ primary 埠 up、standby 埠 down", () => {
  assert.deepEqual(
    roleStatus({
      error: false,
      inRecovery: false,
      failures: 0,
      failLimit: 2,
      last: { primary: "down", standby: "down" },
    }),
    { primary: "up", standby: "down" }
  );
});

test("roleStatus: recovery=t（standby）→ primary 埠 down、standby 埠 up", () => {
  assert.deepEqual(
    roleStatus({
      error: false,
      inRecovery: true,
      failures: 0,
      failLimit: 2,
      last: { primary: "up", standby: "down" },
    }),
    { primary: "down", standby: "up" }
  );
});

test("roleStatus: 單一瞬斷（failures < failLimit）維持上次狀態", () => {
  assert.deepEqual(
    roleStatus({
      error: true,
      inRecovery: null,
      failures: 1,
      failLimit: 2,
      last: { primary: "up", standby: "down" },
    }),
    { primary: "up", standby: "down" }
  );
});

test("roleStatus: 連續失敗達門檻 → 兩個埠都 down", () => {
  assert.deepEqual(
    roleStatus({
      error: true,
      inRecovery: null,
      failures: 2,
      failLimit: 2,
      last: { primary: "up", standby: "down" },
    }),
    { primary: "down", standby: "down" }
  );
});

test("startServers: TCP 契約（隨機埠、讀一行、斷言 up/down、連線後會結束）", async () => {
  const servers = await startServers({
    primaryPort: 0,
    standbyPort: 0,
    getState: () => ({ primary: "up", standby: "down" }),
  });
  try {
    assert.ok(servers.primaryPort > 0, "primaryPort 應綁到實際埠");
    assert.ok(servers.standbyPort > 0, "standbyPort 應綁到實際埠");
    assert.notEqual(servers.primaryPort, servers.standbyPort, "兩埠應不同");

    const primary = await readAgentLine(servers.primaryPort);
    assert.equal(primary.line, "up\n");
    assert.equal(primary.ended, true, "primary 埠寫完一行後應結束連線");

    const standby = await readAgentLine(servers.standbyPort);
    assert.equal(standby.line, "down\n");
    assert.equal(standby.ended, true, "standby 埠寫完一行後應結束連線");
  } finally {
    await servers.close();
  }
});

test("startServers: 每次連線即時讀 getState（角色翻轉後回報新狀態）", async () => {
  let state = { primary: "up", standby: "down" };
  const servers = await startServers({
    primaryPort: 0,
    standbyPort: 0,
    getState: () => state,
  });
  try {
    assert.equal((await readAgentLine(servers.primaryPort)).line, "up\n");

    // 模擬 promote 後的角色翻轉（primary ↔ standby）。
    state = { primary: "down", standby: "up" };
    assert.equal((await readAgentLine(servers.primaryPort)).line, "down\n");
    assert.equal((await readAgentLine(servers.standbyPort)).line, "up\n");
  } finally {
    await servers.close();
  }
});

test("startServers: 讀一行後立刻 RST（模擬 HAProxy）不讓行程掛掉、仍可繼續服務", async () => {
  const servers = await startServers({
    primaryPort: 0,
    standbyPort: 0,
    getState: () => ({ primary: "up", standby: "down" }),
  });
  try {
    // HAProxy 讀完第一行就會 RST 連線；這裡讀到一行後立刻硬斷，模擬該行為。
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: servers.primaryPort });
      socket.setEncoding("utf8");
      socket.setTimeout(3000, () => {
        socket.destroy();
        reject(new Error("timeout waiting for line"));
      });
      socket.on("data", () => {
        if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
        else socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    });

    // 給 server 一點時間處理 RST，然後確認仍能服務新連線（沒被 ECONNRESET 打掛）。
    await new Promise((r) => setTimeout(r, 100));
    const again = await readAgentLine(servers.primaryPort);
    assert.equal(again.line, "up\n");
    assert.equal(again.ended, true);
  } finally {
    await servers.close();
  }
});
