import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  buildRfc822,
  encodeHeader,
  extractAddress,
  formatFrom,
  mailConfigured,
  parseSmtpReply,
  smtpDataPayload,
  smtpSend,
} from "../src/mail.js";

test("parseSmtpReply reads multiline EHLO replies", () => {
  const parsed = parseSmtpReply("250-PIPELINING\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\nQUIT leftover");
  assert.equal(parsed.reply.code, 250);
  assert.equal(parsed.reply.lines.length, 3);
  assert.match(parsed.rest, /QUIT leftover/);
  assert.equal(parseSmtpReply("250-still going\r\n"), null);
});

test("rfc822 encodes subject and dots the payload", () => {
  const msg = buildRfc822({
    from: formatFrom("bot@example.com", "591 物件追蹤"),
    to: "user@example.com",
    subject: "臨時密碼",
    text: "第一行\n.hidden\n第三行",
  });
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
  assert.match(msg, /From: =\?UTF-8\?B\?/);
  const decoded = Buffer.from(msg.split("\r\n\r\n")[1], "base64").toString("utf8");
  assert.match(decoded, /\.hidden/);
  const payload = smtpDataPayload("Subject: x\r\n\r\n.hidden");
  assert.match(payload, /\r\n\.\r\n$/);
  assert.match(payload, /\r\n\.\.hidden/);
  assert.equal(extractAddress("591 <bot@example.com>"), "bot@example.com");
  assert.match(encodeHeader("臨時密碼"), /=\?UTF-8\?B\?/);
});

test("mailConfigured needs host and from/user", () => {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  const user = process.env.SMTP_USER;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  delete process.env.SMTP_USER;
  try {
    assert.equal(mailConfigured(), false);
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_FROM = "bot@example.com";
    assert.equal(mailConfigured(), true);
  } finally {
    for (const [key, value] of [
      ["SMTP_HOST", host],
      ["SMTP_FROM", from],
      ["SMTP_USER", user],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function startMockSmtp() {
  const messages = [];
  const conversation = [];
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
          conversation.push(line);
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
        conversation,
        close: () => new Promise((done) => server.close(done)),
      });
    });
    server.on("error", reject);
  });
}

test("smtpSend authenticates and delivers DATA to a local SMTP server", async () => {
  const mock = await startMockSmtp();
  try {
    await smtpSend(
      {
        host: "127.0.0.1",
        port: mock.port,
        user: "bot@example.com",
        pass: "secret",
        from: "bot@example.com",
        fromName: "591",
        secure: false,
      },
      { to: "member@example.com", subject: "臨時密碼", text: "密碼是 hello-temp" },
    );
    assert.equal(mock.messages.length, 1);
    assert.match(mock.conversation[0], /^EHLO /);
    assert.match(mock.conversation.join("\n"), /AUTH PLAIN /);
    assert.match(mock.conversation.join("\n"), /MAIL FROM:<bot@example.com>/);
    assert.match(mock.conversation.join("\n"), /RCPT TO:<member@example.com>/);
    const decoded = Buffer.from(
      mock.messages[0].split("\r\n\r\n")[1].replace(/\s+/g, ""),
      "base64",
    ).toString("utf8");
    assert.match(decoded, /hello-temp/);
  } finally {
    await mock.close();
  }
});
