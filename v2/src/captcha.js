import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const TTL_MS = 10 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const used = new Map();

function secret() {
  return process.env.SESSION_SECRET || "missing";
}

function hmac(value) {
  return createHmac("sha256", secret()).update(String(value)).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return timingSafeEqual(left, right);
}

export function normalizeCaptchaAnswer(answer) {
  return String(answer || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

export function randomCaptchaCode(length = 4) {
  const n = Math.max(4, Number(length) || 4);
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

function hashAnswer(answer) {
  return hmac(`ans:${normalizeCaptchaAnswer(answer)}`);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderCaptchaSvg(code) {
  const text = String(code || "");
  const w = 180;
  const h = 52;
  const parts = [`<rect width="${w}" height="${h}" rx="8" fill="#fffdf8"/>`];
  for (let i = 0; i < 4; i++) {
    const x1 = randomInt(6, 36);
    const y1 = randomInt(8, 44);
    const x2 = randomInt(140, 174);
    const y2 = randomInt(8, 44);
    const cx = randomInt(50, 130);
    const cy = randomInt(6, 46);
    parts.push(
      `<path d="M${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}" fill="none" stroke="#d9cfc2" stroke-width="1.4"/>`,
    );
  }
  [...text].forEach((ch, i) => {
    const x = 22 + i * 40;
    const y = 34 + randomInt(0, 7) - 3;
    const rot = randomInt(0, 31) - 15;
    const size = 22 + randomInt(0, 6);
    parts.push(
      `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-size="${size}" font-family="Georgia, 'Times New Roman', serif" font-weight="700" fill="#3a332c">${escapeXml(ch)}</text>`,
    );
  });
  for (let i = 0; i < 16; i++) {
    parts.push(`<circle cx="${randomInt(8, 172)}" cy="${randomInt(8, 44)}" r="1.1" fill="#cbbfaf"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="驗證碼">${parts.join("")}</svg>`;
}

function pruneUsed(now) {
  if (used.size < 800) return;
  for (const [nonce, exp] of used) {
    if (Number(exp) <= now) used.delete(nonce);
  }
  if (used.size > 4000) used.clear();
}

export function issueCaptcha({ now = Date.now(), code } = {}) {
  pruneUsed(now);
  const answer = normalizeCaptchaAnswer(code || randomCaptchaCode(4));
  const nonce = randomBytes(8).toString("hex");
  const payload = Buffer.from(
    JSON.stringify({ n: nonce, e: now + TTL_MS, h: hashAnswer(answer) }),
  ).toString("base64url");
  const id = `${payload}.${hmac(payload)}`;
  return {
    id,
    prompt: "請輸入圖中的 4 個字",
    svg: renderCaptchaSvg(answer),
  };
}

export function verifyCaptcha(id, answer, { now = Date.now() } = {}) {
  const token = String(id || "");
  const guess = normalizeCaptchaAnswer(answer);
  if (!token.includes(".") || !guess) {
    const err = new Error("請先完成「我不是機器人」的驗證");
    err.status = 400;
    throw err;
  }
  const [payload, mac] = token.split(".");
  if (!payload || !mac || !safeEqual(hmac(payload), mac)) {
    const err = new Error("驗證已失效，請換一張再試");
    err.status = 400;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    const err = new Error("驗證已失效，請換一張再試");
    err.status = 400;
    throw err;
  }
  const nonce = String(data?.n || "");
  if (!nonce || used.has(nonce)) {
    const err = new Error("這張驗證碼已用過，請換一張");
    err.status = 400;
    throw err;
  }
  used.set(nonce, Number(data.e) || now);
  if (!data?.e || now > Number(data.e)) {
    const err = new Error("驗證已過期，請換一張再試");
    err.status = 400;
    throw err;
  }
  if (!safeEqual(String(data.h || ""), hashAnswer(guess))) {
    const err = new Error("驗證碼不對，請再試一次");
    err.status = 400;
    throw err;
  }
}

export function assertHoneypot(body) {
  const trap = String(body?.website || body?.company || "").trim();
  if (!trap) return;
  const err = new Error("驗證失敗，請再試一次");
  err.status = 400;
  throw err;
}

export function assertHuman(body, opts) {
  assertHoneypot(body);
  verifyCaptcha(body?.captchaId, body?.captchaAnswer, opts);
}

export function resetCaptchaUsed() {
  used.clear();
}
