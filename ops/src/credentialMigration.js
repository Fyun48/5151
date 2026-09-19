// 一次性／冪等憑證 at-rest 遷移：把舊有明文 ingest/command 憑證列轉成 AES-256-GCM 密文。
// 只認得「非 v1: 開頭」的明文列；不印明文；全程一個交易；失敗 ROLLBACK + fail-closed。
import { encryptSecret, isEncryptedSecretBlob, secretAtRestKey } from "./secretAtRest.js";
import { withImmediateTx } from "./tx.js";

const LEGACY_PLAINTEXT_PREDICATE = `secret IS NOT NULL AND secret NOT LIKE 'v1:%'`;

function rowsOf(db, table) {
  return db.prepare(`SELECT id, secret FROM ${table} WHERE ${LEGACY_PLAINTEXT_PREDICATE}`).all();
}

function countPlaintext(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${LEGACY_PLAINTEXT_PREDICATE}`).get()?.n || 0);
}

export function migrateCredentialSecretsAtRest(db, { key = secretAtRestKey() } = {}) {
  if (!key || key.length !== 32) {
    const err = new Error("OPS_SECRET_AT_REST_KEY is not configured (32-byte key required) for credential migration");
    err.status = 503;
    throw err;
  }
  return withImmediateTx(db, () => {
    const ingest = rowsOf(db, "product_ingest_credential");
    const command = rowsOf(db, "product_command_credential");
    for (const row of ingest) {
      const ciphertext = encryptSecret(String(row.secret), key);
      db.prepare("UPDATE product_ingest_credential SET secret = ? WHERE id = ?").run(ciphertext, row.id);
    }
    for (const row of command) {
      const ciphertext = encryptSecret(String(row.secret), key);
      db.prepare("UPDATE product_command_credential SET secret = ? WHERE id = ?").run(ciphertext, row.id);
    }
    // 遷移後驗證：不得殘留明文。
    const remaining = countPlaintext(db, "product_ingest_credential") + countPlaintext(db, "product_command_credential");
    if (remaining > 0) {
      const err = new Error("credential secret migration incomplete (fail-closed)");
      err.status = 500;
      throw err;
    }
    return { migrated_ingest: ingest.length, migrated_command: command.length };
  });
}

export function hasLegacyPlaintextCredentials(db) {
  return countPlaintext(db, "product_ingest_credential") + countPlaintext(db, "product_command_credential") > 0;
}

export { isEncryptedSecretBlob };
