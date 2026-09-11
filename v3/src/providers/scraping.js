import { executeWithProvider, } from "./executeWithProvider.js";
import { getBoundBudgetDb, readCredential } from "../budgetGuard.js";

const USER_AGENT = "591-tracker/1.0 (personal rental watcher)";

export async function fetchHtmlDirect(url, { headers = {}, timeoutMs = 8000 } = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return "";
  return res.text();
}

async function fetchViaPaidProvider(cfg, url, db) {
  const code = String(cfg.provider_code || "");
  if (code === "stub_paid") {
    return { value: `<!-- stub_paid ${url} -->`, usage: { costMinor: Number(cfg.ceiling_minor) || 0 } };
  }
  const key = readCredential(db, cfg);
  if (!key) {
    const err = new Error("missing scraping credential");
    throw err;
  }
  let target;
  if (code === "zenrows") {
    target = new URL("https://api.zenrows.com/v1/");
    target.searchParams.set("apikey", key);
    target.searchParams.set("url", url);
  } else if (code === "scrape_do") {
    target = new URL("https://api.scrape.do/");
    target.searchParams.set("token", key);
    target.searchParams.set("url", url);
  } else {
    const err = new Error(`scraping provider ${code} has no adapter`);
    throw err;
  }
  const res = await fetch(String(target), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`scraping HTTP ${res.status}`);
  return { value: await res.text(), usage: { costMinor: Number(cfg.ceiling_minor) || 0 } };
}

export async function fetchListingPage(url, { headers, timeoutMs, db, fallback } = {}) {
  const database = db || getBoundBudgetDb();
  const fallbackAction = fallback || (() => fetchHtmlDirect(url, { headers, timeoutMs }));
  return executeWithProvider({
    db: database,
    category: "scraping_api",
    fallbackAction,
    costCeilingMinor: undefined,
    actionWithProvider: (cfg) => fetchViaPaidProvider(cfg, url, database),
  });
}
