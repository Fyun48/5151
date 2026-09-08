#!/usr/bin/env node
/**
 * Read-only SQLite inspection for Production predeploy.
 * Do NOT import v3/src/db.js or demand.js — those migrate schema.
 */
import { DatabaseSync } from "node:sqlite";

const FORBIDDEN_SQL = /\b(ALTER|UPDATE|DELETE|INSERT|CREATE|DROP|REPLACE|VACUUM|REINDEX)\b/i;

export function openReadOnly(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function tableExists(db, name) {
  const row = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name);
  return Boolean(row);
}

export function inspectDemandPosts(dbPath) {
  const db = openReadOnly(dbPath);
  try {
    if (!tableExists(db, "demand_posts")) {
      return {
        demand_posts: "ABSENT",
        total_posts: null,
        total_open: null,
        duplicate_open_users: 0,
        affected_posts: 0,
        affected_ids: [],
        duplicates: [],
        migration_classification: "WISH_ROOM_DATA_MIGRATION: demand_posts TABLE ABSENT",
      };
    }
    const schema = db.prepare("PRAGMA table_info(demand_posts)").all()
      .map((row) => row.name);
    const totalPosts = db.prepare("SELECT COUNT(*) AS total_posts FROM demand_posts").get().total_posts;
    const totalOpen = db.prepare(
      "SELECT COUNT(*) AS total_open FROM demand_posts WHERE status = 'open'",
    ).get().total_open;
    const duplicates = db.prepare(`
      SELECT
        user_id,
        COUNT(*) AS open_count,
        GROUP_CONCAT(id) AS open_ids
      FROM demand_posts
      WHERE status = 'open'
      GROUP BY user_id
      HAVING COUNT(*) > 1
    `).all();
    const affectedIds = [];
    for (const row of duplicates) {
      for (const id of String(row.open_ids || "").split(",").filter(Boolean)) {
        affectedIds.push(Number(id));
      }
    }
    const hasDup = duplicates.length > 0;
    return {
      demand_posts: "PRESENT",
      schema_columns: schema,
      total_posts: totalPosts,
      total_open: totalOpen,
      duplicate_open_users: duplicates.length,
      affected_posts: affectedIds.length,
      affected_ids: affectedIds,
      duplicates,
      migration_classification: hasDup
        ? "WISH_ROOM_DATA_MIGRATION: DATA CHANGE WILL OCCUR ON FIRST NEW-VERSION START"
        : "WISH_ROOM_DATA_MIGRATION: NO CURRENT DUPLICATE-OPEN ROWS",
    };
  } finally {
    db.close();
  }
}

export function integrityCheck(dbPath) {
  const db = openReadOnly(dbPath);
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    return row?.integrity_check ?? row?.["integrity_check"] ?? Object.values(row || {})[0];
  } finally {
    db.close();
  }
}

export function integrityReport(dbPath) {
  const integrity_check = integrityCheck(dbPath);
  return { integrity_check, ok: integrity_check === "ok" };
}

export function assertSafeSelect(sql) {
  if (FORBIDDEN_SQL.test(sql)) {
    throw new Error("refusing non-read-only SQL");
  }
}

const self = process.argv[1] ? String(process.argv[1]) : "";
if (self.endsWith("sqlite-readonly-inspect.mjs")) {
  const dbPath = process.argv[2];
  const mode = process.argv[3] || "demand";
  if (!dbPath) {
    console.error("usage: sqlite-readonly-inspect.mjs <db-path> [demand|integrity]");
    process.exit(2);
  }
  if (mode === "integrity") {
    console.log(JSON.stringify(integrityReport(dbPath)));
  } else {
    console.log(JSON.stringify(inspectDemandPosts(dbPath)));
  }
}
