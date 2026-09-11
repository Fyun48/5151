import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSpoofedOwnerDirect, rejectSpoofedOwnerDirect } from "../src/instructionSource.js";

test("owner_direct payload flags are spoof attempts", () => {
  assert.equal(hasSpoofedOwnerDirect({ owner_direct: true }), true);
  assert.equal(hasSpoofedOwnerDirect({ ownerDirect: "true" }), true);
  assert.equal(hasSpoofedOwnerDirect({ manual_owner: 1 }), true);
  assert.equal(hasSpoofedOwnerDirect({ instruction_source: "owner_direct" }), true);
  assert.equal(hasSpoofedOwnerDirect({ action: "APPROVE_RELEASE" }), false);
  assert.equal(hasSpoofedOwnerDirect(null), false);
});

test("rejectSpoofedOwnerDirect is 403 and does not accept the flag", () => {
  assert.throws(() => rejectSpoofedOwnerDirect({ owner_direct: true }), (e) => e.status === 403);
  assert.doesNotThrow(() => rejectSpoofedOwnerDirect({ reason: "owner_console" }));
});
