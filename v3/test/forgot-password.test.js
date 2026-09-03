import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { generateTempPassword, validatePassword } from "../src/password.js";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { registerUser, verifyUserPassword } from "../src/members.js";
import { forgotPasswordMessage, requestTempPassword } from "../src/forgotPassword.js";
import { mailConfigured } from "../src/mail.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  return db;
}

test("forgot password emails a temp password and replaces the old one", async () => {
  const db = memoryDb();
  registerUser(db, { email: "A@B.com", password: "password1", acceptDisclaimer: true });
  const sent = [];
  const result = await requestTempPassword(db, "a@b.com", {
    configured: () => true,
    send: async (mail) => {
      sent.push(mail);
    },
    makePassword: () => "temp-pass-99",
    attempts: new Map(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.message, forgotPasswordMessage());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "a@b.com");
  assert.match(sent[0].subject, /臨時密碼/);
  assert.match(sent[0].text, /temp-pass-99/);
  assert.equal(verifyUserPassword(db, "a@b.com", "password1"), null);
  assert.equal(verifyUserPassword(db, "a@b.com", "temp-pass-99")?.email, "a@b.com");
});

test("unknown email still looks successful and does not send mail", async () => {
  const sent = [];
  const result = await requestTempPassword(memoryDb(), "nobody@example.com", {
    configured: () => true,
    send: async (mail) => {
      sent.push(mail);
    },
    attempts: new Map(),
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /若此帳號存在/);
  assert.equal(sent.length, 0);
});

test("send failure restores the previous password", async () => {
  const db = memoryDb();
  registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  const err = await requestTempPassword(db, "a@b.com", {
    configured: () => true,
    send: async () => {
      const fail = new Error("寄信失敗，請稍後再試");
      fail.status = 502;
      throw fail;
    },
    makePassword: () => "temp-pass-99",
    attempts: new Map(),
  }).catch((error) => error);
  assert.equal(err.status, 502);
  assert.equal(verifyUserPassword(db, "a@b.com", "password1")?.email, "a@b.com");
  assert.equal(verifyUserPassword(db, "a@b.com", "temp-pass-99"), null);
});

test("unconfigured mail returns 503 and does not change the password", async () => {
  const db = memoryDb();
  registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  const err = await requestTempPassword(db, "a@b.com", {
    configured: () => false,
    send: async () => {
      throw new Error("should not send");
    },
    attempts: new Map(),
  }).catch((error) => error);
  assert.equal(err.status, 503);
  assert.match(err.message, /尚未設定寄信/);
  assert.equal(verifyUserPassword(db, "a@b.com", "password1")?.email, "a@b.com");
});

test("cooldown returns 429 for the same email", async () => {
  const db = memoryDb();
  const attempts = new Map();
  const now = 1_000_000;
  await requestTempPassword(db, "nobody@example.com", {
    configured: () => true,
    send: async () => {},
    attempts,
    now,
  });
  const err = await requestTempPassword(db, "nobody@example.com", {
    configured: () => true,
    send: async () => {},
    attempts,
    now: now + 1000,
    cooldownMs: 60_000,
  }).catch((error) => error);
  assert.equal(err.status, 429);
  assert.match(err.message, /秒後再試/);
});

test("invalid email is rejected", async () => {
  const err = await requestTempPassword(memoryDb(), "not-an-email", {
    configured: () => true,
    attempts: new Map(),
  }).catch((error) => error);
  assert.equal(err.status, 400);
});

test("generated temp passwords meet the minimum length", () => {
  const pw = generateTempPassword();
  assert.equal(pw.length, 12);
  assert.equal(validatePassword(pw), pw);
  assert.notEqual(generateTempPassword(), generateTempPassword());
});

test("forgot-password API is listed as a public path", () => {
  const src = readFileSync(path.join(dir, "../src/auth.js"), "utf8");
  assert.match(src, /\/api\/forgot-password/);
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /app\.post\("\/api\/forgot-password"/);
});

test("forgot password forwards admin smtp to sendMail", async () => {
  const db = memoryDb();
  registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  const smtp = {
    host: "smtp.admin.test",
    port: 587,
    user: "bot@admin.test",
    pass: "smtp-test-pass",
    from: "bot@admin.test",
    fromName: "吉比",
    secure: false,
  };
  const sent = [];
  await requestTempPassword(db, "a@b.com", {
    smtp,
    configured: () => true,
    send: async (mail) => sent.push(mail),
    makePassword: () => "temp-pass-99",
    attempts: new Map(),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].smtp, smtp);
  assert.equal(sent[0].to, "a@b.com");
});

const SMTP_ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "SMTP_FROM_NAME",
  "SMTP_SECURE",
];

async function withSmtpEnv(values, fn) {
  const prev = Object.fromEntries(SMTP_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of SMTP_ENV_KEYS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    return await fn();
  } finally {
    for (const key of SMTP_ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test("forgot password uses admin smtp when process.env SMTP is empty", async () => {
  await withSmtpEnv({}, async () => {
    assert.equal(mailConfigured(), false);
    const db = memoryDb();
    registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
    const smtp = {
      host: "smtp.admin.test",
      from: "bot@admin.test",
      user: "bot@admin.test",
      pass: "smtp-test-pass",
    };
    const sent = [];
    const result = await requestTempPassword(db, "a@b.com", {
      smtp,
      send: async (mail) => sent.push(mail),
      makePassword: () => "temp-pass-99",
      attempts: new Map(),
    });
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].smtp.host, "smtp.admin.test");
    assert.match(sent[0].text, /temp-pass-99/);
  });
});

function startMockSmtp() {
  const messages = [];
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = "";
      let mode = "cmd";
      socket.write("220 mock ESMTP\r\n");
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        for (;;) {
          if (mode === "data") {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            messages.push(buf.slice(0, end));
            buf = buf.slice(end + 5);
            mode = "cmd";
            socket.write("250 queued\r\n");
            continue;
          }
          const idx = buf.indexOf("\r\n");
          if (idx < 0) return;
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const verb = line.split(" ")[0].toUpperCase();
          if (verb === "EHLO") socket.write("250-mock\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (verb === "AUTH") socket.write("235 ok\r\n");
          else if (verb === "MAIL" || verb === "RCPT") socket.write("250 ok\r\n");
          else if (verb === "DATA") {
            mode = "data";
            socket.write("354 go\r\n");
          } else if (verb === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else socket.write("250 ok\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        messages,
        close: () => new Promise((done) => server.close(done)),
      });
    });
    server.on("error", reject);
  });
}

function decodeSmtpBody(raw) {
  const parts = String(raw || "").split("\r\n\r\n");
  return Buffer.from((parts[1] || "").replace(/\s+/g, ""), "base64").toString("utf8");
}

test("forgot password delivers via admin smtp even if env points at the wrong host", async () => {
  const mock = await startMockSmtp();
  try {
    await withSmtpEnv(
      {
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: "1",
        SMTP_FROM: "wrong@example.com",
        SMTP_USER: "wrong@example.com",
        SMTP_PASS: "nope",
      },
      async () => {
        const db = memoryDb();
        registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
        const result = await requestTempPassword(db, "a@b.com", {
          smtp: {
            host: "127.0.0.1",
            port: mock.port,
            user: "bot@admin.test",
            pass: "smtp-test-pass",
            from: "bot@admin.test",
            fromName: "吉比",
            secure: false,
          },
          attempts: new Map(),
          makePassword: () => "tempPass99x",
        });
        assert.equal(result.ok, true);
        assert.equal(mock.messages.length, 1);
        assert.match(decodeSmtpBody(mock.messages[0]), /tempPass99x/);
      },
    );
  } finally {
    await mock.close();
  }
});

test("db wrapper and admin test mail read getStoredSmtp", () => {
  const dbSrc = readFileSync(path.join(dir, "../src/db.js"), "utf8");
  const wrap = dbSrc.slice(
    dbSrc.indexOf("export function requestTempPassword"),
    dbSrc.indexOf("export { publicUser }"),
  );
  assert.match(wrap, /smtp:\s*getStoredSmtp\(\)/);
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const queue = server.slice(server.indexOf("function queueSystemMail"), server.indexOf('app.post("/api/register"'));
  assert.match(queue, /smtp:\s*getStoredSmtp\(\)/);
  const mailTest = server.slice(
    server.indexOf('app.post("/api/admin/mail/test"'),
    server.indexOf("app.use(express.static"),
  );
  assert.match(mailTest, /getStoredSmtp\(\)/);
  assert.match(mailTest, /\bsmtp,/);
});
