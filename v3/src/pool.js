export function clampConcurrency(value, { fallback = 4, max = 8 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.floor(n));
}

/** 591 詳情／社區請求的平行數。40 個瀏覽器視窗會打爆主機也被封鎖；HTTP 4～8 條較穩。 */
export function detailConcurrency() {
  return clampConcurrency(process.env.GEO_591_CONCURRENCY, { fallback: 4, max: 8 });
}

export async function mapPool(items, { concurrency = 4, gapMs = 0 } = {}, fn) {
  const list = [...(items || [])];
  if (!list.length) return [];
  const results = new Array(list.length);
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  }

  const starters = [];
  for (let i = 0; i < limit; i += 1) {
    if (i > 0 && gapMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    starters.push(worker());
  }
  await Promise.all(starters);
  return results;
}
