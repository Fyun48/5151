function nowIso() {
  return new Date().toISOString();
}

function numIds(values) {
  return [...new Set((values || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))].sort((a, b) => a - b);
}

function parseSectionIds(raw) {
  try {
    return numIds(JSON.parse(raw || "[]"));
  } catch {
    return [];
  }
}

export function coverFromRow(row) {
  return {
    id: row.id,
    regionId: Number(row.region_id) || 0,
    sectionIds: parseSectionIds(row.section_ids),
    priceMin: Number(row.price_min) || 0,
    priceMax: Number(row.price_max) || 0,
    lastRunAt: row.last_run_at || null,
    createdAt: row.created_at || "",
  };
}

export function coverFingerprint(cover) {
  return [
    Number(cover.regionId) || 0,
    numIds(cover.sectionIds).join(","),
    Number(cover.priceMin) || 0,
    Number(cover.priceMax) || 0,
  ].join("|");
}

export function listCrawlCovers(db) {
  return db
    .prepare(
      "SELECT id, region_id, section_ids, price_min, price_max, last_run_at, created_at FROM crawl_covers ORDER BY region_id, id",
    )
    .all()
    .map(coverFromRow);
}

export function replaceCrawlCovers(db, covers, now = nowIso()) {
  const previous = new Map(listCrawlCovers(db).map((row) => [coverFingerprint(row), row]));
  db.exec("DELETE FROM crawl_covers");
  const insert = db.prepare(
    `INSERT INTO crawl_covers(region_id, section_ids, price_min, price_max, last_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const cover of covers || []) {
    const regionId = Number(cover.regionId) || 0;
    if (regionId <= 0) continue;
    const sectionIds = numIds(cover.sectionIds);
    const priceMin = Number(cover.priceMin) || 0;
    const priceMax = Number(cover.priceMax) || 0;
    const prev = previous.get(coverFingerprint({ regionId, sectionIds, priceMin, priceMax }));
    insert.run(
      regionId,
      JSON.stringify(sectionIds),
      priceMin,
      priceMax,
      prev?.lastRunAt || null,
      prev?.createdAt || now,
    );
  }
  return listCrawlCovers(db);
}

export function touchCrawlCoversRun(db, now = nowIso()) {
  db.prepare("UPDATE crawl_covers SET last_run_at = ?").run(now);
}
