import { httpError } from "../errors.js";
import { previousStableComplete } from "./productionReleasePolicy.js";

export const SCHEMA_COMPAT_OK = "compatible";
export const DB_RESTORE_CONFIRMATION = "RESTORE-PRODUCTION-DB";

export function looksLikeStaticTreeHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

export function rollbackContractFields(target) {
  if (!target) return { source_sha: null, artifact_digest: null, static_tree_hash: null, schema_compat: null };
  return {
    source_sha: target.source_sha || target.previous_stable_sha || null,
    artifact_digest: target.artifact_digest || target.previous_stable_digest || null,
    static_tree_hash: target.static_tree_hash || target.previous_stable_static_tree_hash || null,
    schema_compat: target.schema_compat || target.previous_stable_schema_compat || null,
  };
}

export function rollbackContractComplete(target) {
  if (!previousStableComplete(target)) return false;
  const fields = rollbackContractFields(target);
  return looksLikeStaticTreeHash(fields.static_tree_hash) && String(fields.schema_compat || "") === SCHEMA_COMPAT_OK;
}

export function assertCompleteRollbackContract(target) {
  if (!rollbackContractComplete(target)) {
    throw httpError("complete rollback requires source SHA, artifact digest, static tree hash, and compatible schema", 409);
  }
}

export function assertDbRestoreConfirmation(body = {}) {
  const flag = body.confirm_db_restore ?? body.confirmDbRestore ?? body.restore_database ?? body.restoreDatabase;
  if (flag == null || flag === false || flag === "" || flag === 0) {
    return { requested: false };
  }
  if (flag !== DB_RESTORE_CONFIRMATION) {
    throw httpError("database restore requires explicit confirmation RESTORE-PRODUCTION-DB", 409);
  }
  return { requested: true };
}
