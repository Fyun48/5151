// Media migration tool (Phase 18): local -> S3 object storage. Dry-run, verify
// and resume (idempotent) are built in.
export async function migrateMedia({ source, target, dryRun = false, resume = true } = {}) {
  const keys = await source.list();
  if (dryRun) {
    return { dryRun: true, count: keys.length, plan: keys.map((key) => ({ key })) };
  }
  const migrated = [];
  const skipped = [];
  for (const key of keys) {
    if (resume && (await target.exists(key))) {
      skipped.push(key);
      continue;
    }
    const buffer = await source.get(key);
    if (buffer == null) continue;
    const metadata = await source.getMetadata(key);
    await target.put(key, buffer, metadata || {});
    migrated.push(key);
  }
  return { dryRun: false, migrated, skipped, verify: await verifyMedia(source, target, keys) };
}

export async function verifyMedia(source, target, keys) {
  const results = [];
  for (const key of keys) {
    const src = await source.getMetadata(key);
    const tgt = await target.getMetadata(key);
    results.push({
      key,
      ok: Boolean(src?.sha256) && src.sha256 === tgt?.sha256,
      sourceBytes: src?.bytes ?? null,
      targetBytes: tgt?.bytes ?? null,
    });
  }
  return results;
}
