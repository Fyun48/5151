import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACK = path.join(root, "v3/evidence/production-uat-20260917-pre-activation.json");
const NORMALIZE = path.join(root, ".github/scripts/normalize-production-uat-evidence.py");
const EVIDENCE = path.join(root, ".github/scripts/activate-rental-marketplace-stage1-evidence.py");
const REMOTE = path.join(root, ".github/scripts/activate-rental-marketplace-stage1-remote.sh");
const WF = path.join(root, ".github/workflows/activate-rental-marketplace-stage1.yml");

function checkPack(file) {
  return execFileSync("python3", [NORMALIZE, "--check-pack", file], { encoding: "utf8" });
}

test("recovered Production UAT pack exists and is pre-activation only", () => {
  const doc = JSON.parse(readFileSync(PACK, "utf8"));
  assert.equal(doc.schema, "production-uat-evidence-pack-v1");
  assert.equal(doc.can_satisfy_post_activation_matching_gate, false);
  assert.equal(doc.flag_snapshot["wish.owner_matching_enabled"], false);
  assert.equal(doc.recordings[0].filename, "uat_production_guest_walkthrough.mp4");
  assert.equal(doc.recordings[0].bytes, 37774244);
  assert.equal(doc.recordings[0].github_upload, "rejected_for_size");
  assert.equal(doc.matching_safety.post_activation_cross_account_isolation, "not_covered");
  assert.equal(doc.matching_safety.post_activation_paused_completed_inactive_suppression, "not_covered");
  assert.match(checkPack(PACK), /UAT_EVIDENCE_PACK_OK/);
});

test("missing GitHub video is not treated as missing UAT, but cannot claim post-ON matching", () => {
  const doc = JSON.parse(readFileSync(PACK, "utf8"));
  const dir = mkdtempSync(path.join(tmpdir(), "uat-pack-"));
  const missingSha = path.join(dir, "ok.json");
  writeFileSync(missingSha, JSON.stringify(doc));
  assert.match(checkPack(missingSha), /UAT_EVIDENCE_PACK_OK/);

  const claimed = structuredClone(doc);
  claimed.can_satisfy_post_activation_matching_gate = true;
  writeFileSync(path.join(dir, "claim.json"), JSON.stringify(claimed));
  assert.throws(() => checkPack(path.join(dir, "claim.json")), /cannot satisfy post-activation matching gate/);

  const onFlag = structuredClone(doc);
  onFlag.flag_snapshot["wish.owner_matching_enabled"] = true;
  writeFileSync(path.join(dir, "on.json"), JSON.stringify(onFlag));
  assert.throws(() => checkPack(path.join(dir, "on.json")), /owner_matching OFF/);

  const noReject = structuredClone(doc);
  noReject.recordings[0].github_upload = "uploaded";
  writeFileSync(path.join(dir, "noreject.json"), JSON.stringify(noReject));
  assert.throws(() => checkPack(path.join(dir, "noreject.json")), /sha256 missing without GitHub size-rejection/);

  const emptyRec = structuredClone(doc);
  emptyRec.recordings = [];
  writeFileSync(path.join(dir, "empty.json"), JSON.stringify(emptyRec));
  assert.throws(() => checkPack(path.join(dir, "empty.json")), /missing GitHub video is not missing UAT/);
  rmSync(dir, { recursive: true, force: true });
});

test("Stage 1 activation still requires post-activation probes and ignores recovered UAT PASS", () => {
  const remote = readFileSync(REMOTE, "utf8");
  const wf = readFileSync(WF, "utf8");
  assert.match(remote, /pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence/);
  assert.match(remote, /run_post_activation_probes/);
  assert.match(wf, /pre-activation PRODUCTION_UAT_PASS 不能當 post-activation evidence/);
  assert.match(readFileSync(EVIDENCE, "utf8"), /PRODUCTION_UAT_PASS cannot satisfy ACTIVATION_OK/);
});
