import net from "node:net";
import os from "node:os";
import tls from "node:tls";

const READ_MS = 20_000;
const CONNECT_MS = 20_000;

export function mailConfigured() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
  return Boolean(host && from);
}

export function smtpConfig() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 587) || 587;
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "");
  const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
  const fromName = String(process.env.SMTP_FROM_NAME || "591 物件追蹤").trim();
  const secureFlag = String(process.env.SMTP_SECURE || "").trim();
  const secure = secureFlag === "1" || secureFlag.toLowerCase() === "true" || port === 465;
  return { host, port, user, pass, from, fromName, secure };
}

export function extractAddress(value) {
  const text = String(value || "").trim();
  const angle = text.match(/<([^>]+)>/);
  return (angle ? angle[1] : text).trim();
}

export function encodeHeader(text) {
  return `=?UTF-8?B?${Buffer.from(String(text), "utf8").toString("base64")}?=`;
}

export function formatFrom(fromEmail, fromName) {
  const email = extractAddress(fromEmail);
  const name = String(fromName || "").trim();
  if (!name) return email;
  return `${encodeHeader(name)} <${email}>`;
}

export function parseSmtpReply(buffer) {
  let rest = String(buffer || "");
  const lines = [];
  while (rest.length) {
    const idx = rest.indexOf("\n");
    if (idx < 0) return null;
    let line = rest.slice(0, idx);
    rest = rest.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!/^\d{3}[ -]/.test(line)) return null;
    lines.push(line);
    if (line[3] === " ") {
      return {
        reply: {
          code: Number(line.slice(0, 3)),
          lines,
          text: lines.join("\n"),
        },
        rest,
      };
    }
  }
  return null;
}

export function buildRfc822({ from, to, subject, text }) {
  const body = Buffer.from(String(text || "").replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  const wrapped = body.match(/.{1,76}/g)?.join("\r\n") || body;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapped,
  ].join("\r\n");
}

export function smtpDataPayload(rfc822) {
  const normalized = String(rfc822 || "").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const stuffed = normalized.split("\r\n").map((line) => (line.startsWith(".") ? `.${line}` : line));
  return `${stuffed.join("\r\n")}\r\n.\r\n`;
}

function ehloName() {
  const name = String(os.hostname() || "localhost").replace(/[^\w.-]/g, "");
  return name || "localhost";
}

function parseEhlo(text) {
  const auth = [];
  let starttls = false;
  for (const raw of String(text || "").split("\n")) {
    const rest = raw.slice(4).trim();
    if (/^STARTTLS$/i.test(rest)) starttls = true;
    if (/^AUTH\b/i.test(rest)) {
      auth.push(...rest.split(/\s+/).slice(1).map((item) => item.toUpperCase()));
    }
  }
  return { auth, starttls };
}

function openSession({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    socket.setTimeout(CONNECT_MS);
    socket.once("error", fail);
    socket.once("timeout", () => {
      socket.destroy();
      fail(new Error("SMTP 連線逾時"));
    });
    const session = attachSession(socket);
    const readyEvent = secure ? "secureConnect" : "connect";
    socket.once(readyEvent, () => {
      if (settled) return;
      settled = true;
      resolve(session);
    });
  });
}

function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host }, () => resolve(tlsSocket));
    tlsSocket.once("error", reject);
  });
}

function attachSession(socket) {
  let buf = "";
  const waiters = [];

  const onData = (chunk) => {
    buf += chunk;
    while (waiters.length) {
      const parsed = parseSmtpReply(buf);
      if (!parsed) break;
      buf = parsed.rest;
      waiters.shift().resolve(parsed.reply);
    }
  };

  socket.setEncoding("utf8");
  socket.on("data", onData);
  socket.on("error", (error) => {
    while (waiters.length) waiters.shift().reject(error);
  });
  socket.on("end", () => {
    while (waiters.length) waiters.shift().reject(new Error("SMTP 連線中斷"));
  });

  function readReply() {
    return new Promise((resolve, reject) => {
      const parsed = parseSmtpReply(buf);
      if (parsed) {
        buf = parsed.rest;
        resolve(parsed.reply);
        return;
      }
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error("SMTP 讀取逾時"));
      }, READ_MS);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      waiters.push(waiter);
    });
  }

  async function command(line, expect) {
    socket.write(`${line}\r\n`);
    const reply = await readReply();
    const allowed = expect == null ? null : Array.isArray(expect) ? expect : [expect];
    if (allowed && !allowed.includes(reply.code)) {
      throw new Error(`SMTP ${allowed.join("/")} 失敗（${reply.code}）：${reply.text}`);
    }
    return reply;
  }

  async function writeData(payload) {
    socket.write(payload);
    const reply = await readReply();
    if (reply.code !== 250) {
      throw new Error(`SMTP DATA 失敗（${reply.code}）：${reply.text}`);
    }
    return reply;
  }

  function replaceSocket(next) {
    socket.off("data", onData);
    return attachSession(next);
  }

  return { socket, readReply, command, writeData, replaceSocket };
}

async function authenticate(session, user, pass, methods) {
  const list = (methods || []).map((item) => String(item).toUpperCase());
  const token = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
  const tryPlain = list.includes("PLAIN") || list.length === 0;
  const tryLogin = list.includes("LOGIN") || list.length === 0;
  if (tryPlain) {
    const reply = await session.command(`AUTH PLAIN ${token}`);
    if (reply.code === 235) return;
    if (reply.code === 334) {
      const next = await session.command(token);
      if (next.code === 235) return;
      throw new Error(`SMTP AUTH 失敗（${next.code}）：${next.text}`);
    }
    if (!tryLogin) throw new Error(`SMTP AUTH 失敗（${reply.code}）：${reply.text}`);
  }
  if (tryLogin) {
    await session.command("AUTH LOGIN", 334);
    await session.command(Buffer.from(user, "utf8").toString("base64"), 334);
    await session.command(Buffer.from(pass, "utf8").toString("base64"), 235);
    return;
  }
  throw new Error("SMTP 不支援 AUTH PLAIN / LOGIN");
}

export async function smtpSend(config, { to, subject, text }) {
  const host = String(config.host || "").trim();
  const port = Number(config.port || 587);
  if (!host) throw new Error("尚未設定 SMTP_HOST");
  const toAddr = extractAddress(to);
  const fromAddr = extractAddress(config.from);
  if (!toAddr || !fromAddr) throw new Error("寄件或收件地址不完整");
  let session;
  try {
    session = await openSession({ host, port, secure: Boolean(config.secure) });
    await session.readReply();
    let ehlo = await session.command(`EHLO ${ehloName()}`, 250);
    const caps = parseEhlo(ehlo.text);
    if (!config.secure && caps.starttls) {
      await session.command("STARTTLS", 220);
      const upgraded = await upgradeTls(session.socket, host);
      session = session.replaceSocket(upgraded);
      ehlo = await session.command(`EHLO ${ehloName()}`, 250);
    }
    const authCaps = parseEhlo(ehlo.text);
    if (config.user) {
      await authenticate(session, config.user, config.pass || "", authCaps.auth);
    }
    await session.command(`MAIL FROM:<${fromAddr}>`, 250);
    await session.command(`RCPT TO:<${toAddr}>`, [250, 251]);
    await session.command("DATA", 354);
    const rfc822 = buildRfc822({
      from: formatFrom(fromAddr, config.fromName),
      to: toAddr,
      subject,
      text,
    });
    await session.writeData(smtpDataPayload(rfc822));
    try {
      await session.command("QUIT", 221);
    } catch {
      // 有些伺服器 QUIT 後直接斷線
    }
  } finally {
    try {
      session?.socket?.destroy();
    } catch {
      // ignore
    }
  }
}

export async function sendMail({ to, subject, text }) {
  if (!mailConfigured()) {
    const err = new Error("尚未設定寄信，請聯絡管理員在伺服器 auth.env 寫入 SMTP 設定");
    err.status = 503;
    throw err;
  }
  try {
    await smtpSend(smtpConfig(), { to, subject, text });
  } catch (error) {
    if (error.status) throw error;
    console.warn("SMTP 失敗：", error.message);
    const err = new Error("寄信失敗，請稍後再試");
    err.status = 502;
    throw err;
  }
}
