import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOauthState,
  exchangeOauthCode,
  normalizeOauthConfig,
  publicOauthConfig,
  readOauthState,
} from "../src/oauth.js";

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
  assert.equal(calls.length, 2);
});
