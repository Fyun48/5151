export function newSelfListingIdempotencyKey(randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUuid === "function") return randomUuid();
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function selfListingClientFingerprint(payload = {}) {
  const { idempotency_key: _ignored, ...rest } = payload;
  return JSON.stringify(rest);
}

export function resolveSelfListingCreateKey(state = {}, fingerprint = "", makeKey = newSelfListingIdempotencyKey) {
  if (state.key && state.fingerprint === fingerprint) {
    return { ...state, key: state.key, fingerprint };
  }
  return { ...state, key: makeKey(), fingerprint };
}

export function beginSelfListingSubmit(state = {}) {
  if (state.inFlight) return { allowed: false, state };
  return {
    allowed: true,
    state: { ...state, inFlight: true, submitDisabled: true },
  };
}

export function endSelfListingSubmit(state = {}, { success = false } = {}) {
  const next = { ...state, inFlight: false, submitDisabled: false };
  if (success) {
    next.key = "";
    next.fingerprint = "";
  }
  return next;
}
