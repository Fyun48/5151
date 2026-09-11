import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasSpoofedOwnerDirect,
  rejectSpoofedOwnerDirect,
  resolveVerifiedInstruction,
  INSTRUCTION_SOURCES,
} from "../src/instructionSource.js";

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

test("verified session is the only HTTP instruction source", () => {
  const instruction = resolveVerifiedInstruction({
    session: { email: "owner@example.com", role: "owner", nonce: "n1" },
    body: { action: "APPROVE_RELEASE" },
  });
  assert.equal(instruction.source, INSTRUCTION_SOURCES.VERIFIED_SESSION);
  assert.equal(instruction.actor, "owner:owner@example.com");
  assert.equal(instruction.session_nonce, "n1");
});

test("authorized workflow actor can record owner-direct observation", () => {
  const instruction = resolveVerifiedInstruction({
    workflowActor: "Fyun48",
    env: { PRODUCTION_RELEASE_GITHUB_ACTOR: "Fyun48" },
    body: {},
  });
  assert.equal(instruction.source, INSTRUCTION_SOURCES.VERIFIED_WORKFLOW_ACTOR);
  assert.equal(instruction.actor, "workflow:Fyun48");
});

test("payload cannot mint owner_direct even with a session present", () => {
  assert.throws(
    () => resolveVerifiedInstruction({
      session: { email: "owner@example.com", role: "owner" },
      body: { owner_direct: true },
    }),
    (e) => e.status === 403,
  );
});

test("unverified caller cannot claim an instruction source", () => {
  assert.throws(
    () => resolveVerifiedInstruction({ body: { reason: "please" } }),
    (e) => e.status === 403,
  );
  assert.throws(
    () => resolveVerifiedInstruction({ workflowActor: "someone-else", env: { PRODUCTION_RELEASE_GITHUB_ACTOR: "Fyun48" } }),
    (e) => e.status === 403,
  );
});
