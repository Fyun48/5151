import { setImmediate as yieldToIO } from 'node:timers/promises';
import { candidateRowFromValues, LIST_CANDIDATE_KEYS, LIST_CANDIDATE_COLUMNS } from './listingCandidateRow.js';

const PREFIX = `SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings `;
// Relation OID is in the namespace. Inheritance/partitioning is excluded below,
// so each selected row belongs to that exact table.
const VERSION_COLUMNS = "post_id, xmin::text || '/' || ctid::text AS content_version";
const IDENTITY_SQL = `SELECT current_database() AS database_name, current_user AS role,
  inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
  pg_postmaster_start_time()::text AS server_started,
  floor(pg_snapshot_xmax(pg_current_snapshot())::text::numeric / 4294967296)::text AS xid_epoch,
  c.oid::text AS relation, pg_relation_filenode(c.oid)::text AS storage,
  c.relkind, c.relhassubclass, c.relrowsecurity,
  has_table_privilege(c.oid, 'SELECT') AS table_select
  FROM pg_class c WHERE c.oid = 'listings'::regclass`;

// Content only: selection, user scope, time-dependent conditions and row versions
// are always read from the current transaction. No TTL or cached query results.
// One bounded store belongs to one real pool. Namespace/version checks also
// protect pools whose clients change role/search_path or reconnect to a server.
export function createCandidateContentStore({ maxRows = 50000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0;
  let currentIdentity = null;
  const drop = id => {
    const old = entries.get(id);
    if (old) { bytes -= old.bytes; entries.delete(id); }
  };
  return {
    clear() { entries.clear(); bytes = 0; },
    bindIdentity(identity) {
      if (identity !== currentIdentity) { entries.clear(); bytes = 0; currentIdentity = identity; }
      return currentIdentity;
    },
    inspect() { return { rows: entries.size, bytes, maxRows, maxBytes }; },
    get(id, version, identity) {
      const entry = entries.get(id);
      return entry?.version === version && entry.identity === identity ? entry.values : null;
    },
    put(id, version, identity, row) {
      if (identity !== currentIdentity) return;
      const values = LIST_CANDIDATE_KEYS.map(key => row[key]);
      // Candidate columns currently contain scalars. A future mutable PG type
      // must keep using the ordinary reader until a safe copy contract exists.
      if (values.some(value => value != null && !['string', 'number', 'boolean'].includes(typeof value))) return;
      const size = 256 + values.length * 8 + values.reduce((n, value) => n + (typeof value === 'string' ? value.length * 2 + 24 : 8), 0);
      drop(id);
      if (size > maxBytes || maxRows < 1) return;
      while (entries.size && (entries.size >= maxRows || bytes + size > maxBytes)) drop(entries.keys().next().value);
      entries.set(id, { version, identity, values, bytes: size });
      bytes += size;
    },
  };
}

export async function readCandidateContent({ client, readRows, store, sql, params, options }) {
  if (!store || !options.arrayRows || !sql.startsWith(PREFIX)) return readRows(sql, params, options);
  // Enforce the full column privilege contract on every read, even a 100% hit.
  // Field metadata detects column replacement/type changes without trusting TTL.
  const fields = (await client.query(`SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings LIMIT 0`)).fields;
  const metadata = (await client.query(IDENTITY_SQL)).rows[0];
  // Views, inheritance/partitioning and RLS need their own version/visibility
  // proof. Keep their original single SELECT instead of approximating it.
  if (!metadata || metadata.relkind !== 'r' || metadata.relhassubclass || metadata.relrowsecurity || !metadata.table_select) {
    return readRows(sql, params, options);
  }
  const identity = store.bindIdentity(JSON.stringify([metadata, fields.map(f => [f.name, f.tableID, f.columnID, f.dataTypeID, f.dataTypeModifier])]));
  const selected = await readRows(`SELECT ${VERSION_COLUMNS} FROM listings ${sql.slice(PREFIX.length)}`, params);
  const rows = new Array(selected.length), missing = [], versions = new Map();
  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    const id = Number(row.post_id);
    const version = row.content_version;
    const values = store.get(id, version, identity);
    if (values) rows[i] = candidateRowFromValues(values);
    else { missing.push(id); versions.set(id, { version, index: i }); }
    if ((i + 1) % 256 === 0) await yieldToIO();
  }
  if (missing.length) {
    const fresh = await readRows(`SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings WHERE post_id = ANY($1::bigint[])`, [missing], options);
    for (let i = 0; i < fresh.length; i++) {
      const row = fresh[i], id = Number(row.post_id), selectedVersion = versions.get(id);
      if (!selectedVersion) throw new Error('PG content read returned an unselected candidate');
      store.put(id, selectedVersion.version, identity, row);
      rows[selectedVersion.index] = row;
      versions.delete(id);
      if ((i + 1) % 256 === 0) await yieldToIO();
    }
    if (versions.size) throw new Error('PG candidate content missing from the current snapshot');
  }
  return rows;
}
