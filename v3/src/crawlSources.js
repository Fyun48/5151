/** 爬蟲來源開關。591 與站內自行刊登預設開；住商預設關，打開才抓。樂屋／信義仍是 stub。 */

export const CRAWL_SOURCE_CATALOG = [
  { id: "591", label: "591 租屋", stub: false },
  { id: "hbhousing", label: "住商不動產", stub: false },
  { id: "rakuya", label: "樂屋網", stub: true },
  { id: "sinyi", label: "信義房屋", stub: true },
  { id: "house591", label: "其他租屋網（之後）", stub: true },
  { id: "self", label: "自行刊登", stub: false },
];

const DEFAULT_ENABLED = {
  "591": true,
  hbhousing: false,
  rakuya: false,
  sinyi: false,
  house591: false,
  self: true,
};

export function defaultCrawlSources() {
  return CRAWL_SOURCE_CATALOG.map((row) => ({
    ...row,
    enabled: DEFAULT_ENABLED[row.id] === true,
  }));
}

export function normalizeCrawlSources(input) {
  const incoming = Array.isArray(input)
    ? Object.fromEntries(input.map((row) => [String(row?.id || ""), row]))
    : input && typeof input === "object"
      ? input
      : {};
  return CRAWL_SOURCE_CATALOG.map((row) => {
    const cell = incoming[row.id];
    const enabledRaw = cell && typeof cell === "object" ? cell.enabled : cell;
    const enabled = row.stub ? enabledRaw === true : enabledRaw !== false;
    return { ...row, enabled: Boolean(enabled) };
  });
}

export function crawlSourceEnabled(sources, id) {
  const list = normalizeCrawlSources(sources);
  return list.some((row) => row.id === id && row.enabled);
}

export function publicCrawlSources(sources) {
  return { items: normalizeCrawlSources(sources) };
}
