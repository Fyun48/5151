import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOauthState,
  exchangeOauthCode,
  normalizeOauthConfig,
  planOauthSession,
  planOauthSignup,
  providerAuthorizeUrl,
  publicOauthConfig,
  readOauthState,
} from "../src/oauth.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("oauth state round-trips and expires", () => {
  const secret = "test-secret";
  const token = createOauthState({ provider: "google", accept: true, now: 1_000 }, secret);
  const ok = readOauthState(token, secret, 2_000);
  assert.equal(ok.provider, "google");
  assert.equal(ok.accept, true);
  assert.equal(readOauthState(token, secret, 1_000 + 16 * 60 * 1000), null);
  assert.equal(readOauthState("nope", secret, 2_000), null);
});

test("public oauth config hides secrets", () => {
  const cfg = normalizeOauthConfig({
    google: { enabled: true, clientId: "gid", clientSecret: "gsecret" },
  });
  const pub = publicOauthConfig(cfg);
  assert.equal(pub.google.enabled, true);
  assert.equal(pub.google.configured, true);
  assert.equal(pub.google.clientId, "gid");
  assert.equal(JSON.stringify(pub).includes("gsecret"), false);
});

test("authorize urls request email for google line facebook", () => {
  const google = providerAuthorizeUrl("google", { clientId: "g", redirectUri: "https://x/cb", state: "s" });
  const line = providerAuthorizeUrl("line", { clientId: "l", redirectUri: "https://x/cb", state: "s" });
  const fb = providerAuthorizeUrl("facebook", { clientId: "f", redirectUri: "https://x/cb", state: "s" });
  assert.match(google, /accounts\.google\.com/);
  assert.match(google, /email/);
  assert.match(line, /access\.line\.me/);
  assert.match(line, /email/);
  assert.match(fb, /facebook\.com/);
  assert.match(fb, /scope=email/);
});

test("new oauth accounts stay unverified until the mail link", () => {
  assert.equal(planOauthSignup({ user: null, accept: false }).action, "need_accept");
  assert.equal(planOauthSignup({ user: null, accept: true }).action, "register");
  assert.equal(planOauthSignup({ user: { email: "a@b.com" }, accept: true }).action, "existing");
  assert.equal(planOauthSignup({ user: { deleted_at: "2026-01-01" }, accept: true }).action, "closed");
  assert.equal(planOauthSession({ email: "a@b.com" }, { verified: false }).action, "pending_verify");
  assert.equal(planOauthSession({ email: "a@b.com" }, { verified: true }).action, "session");
});

test("google code exchange reads email from userinfo", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET" });
    if (String(url).includes("/token")) {
      return { ok: true, text: async () => JSON.stringify({ access_token: "tok" }) };
    }
    return { ok: true, text: async () => JSON.stringify({ email: "user@gmail.com", sub: "99", name: "U" }) };
  };
  const profile = await exchangeOauthCode(
    "google",
    { code: "abc", redirectUri: "https://x/auth/google/callback", clientId: "id", clientSecret: "sec" },
    { fetchImpl },
  );
  assert.equal(profile.email, "user@gmail.com");
  assert.equal(profile.subject, "99");
  assert.equal(profile.name, "U");
  assert.equal(calls.length, 2);
});

test("line and facebook code exchange read email and name", async () => {
  const line = await exchangeOauthCode(
    "line",
    { code: "abc", redirectUri: "https://x/auth/line/callback", clientId: "id", clientSecret: "sec" },
    {
      fetchImpl: async (url) => {
        if (String(url).includes("/token")) {
          return { ok: true, text: async () => JSON.stringify({ access_token: "tok" }) };
        }
        return { ok: true, text: async () => JSON.stringify({ email: "line@example.com", sub: "U1", name: "小林" }) };
      },
    },
  );
  assert.equal(line.email, "line@example.com");
  assert.equal(line.subject, "U1");
  assert.equal(line.name, "小林");

  const facebook = await exchangeOauthCode(
    "facebook",
    { code: "abc", redirectUri: "https://x/auth/facebook/callback", clientId: "id", clientSecret: "sec" },
    {
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes("access_token") && !href.includes("graph.facebook.com/me")) {
          return { ok: true, text: async () => JSON.stringify({ access_token: "tok" }) };
        }
        return { ok: true, text: async () => JSON.stringify({ email: "fb@example.com", id: "99", name: "小美" }) };
      },
    },
  );
  assert.equal(facebook.email, "fb@example.com");
  assert.equal(facebook.subject, "99");
  assert.equal(facebook.name, "小美");
});

test("line without email asks the member to register by mailbox", async () => {
  await assert.rejects(
    () => exchangeOauthCode(
      "line",
      { code: "abc", redirectUri: "https://x/auth/line/callback", clientId: "id", clientSecret: "sec" },
      {
        fetchImpl: async (url) => {
          if (String(url).includes("/token")) {
            return { ok: true, text: async () => JSON.stringify({ access_token: "tok" }) };
          }
          return { ok: true, text: async () => JSON.stringify({ sub: "U1", name: "小林" }) };
        },
      },
    ),
    /沒有提供 Email/,
  );
});

test("oauth callback still queues the verify mail and does not set session first", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(src, /planOauthSignup/);
  assert.match(src, /emailVerified: false/);
  assert.match(src, /queueSystemMail\("welcome"/);
  assert.match(src, /oauth=pending/);
  assert.match(src, /nicknameFromOauthName/);
  const callback = src.slice(src.indexOf('app.get("/auth/:provider/callback"'), src.indexOf('app.post("/api/forgot-password"'));
  assert.match(callback, /pending_verify/);
  assert.match(callback, /issueVerifyToken/);
  assert.doesNotMatch(callback.split("pending_verify")[1].split("afterMemberSession")[0], /sessionCookie/);
});
