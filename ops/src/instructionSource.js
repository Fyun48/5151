import { httpError } from "./errors.js";

// 指令來源只能是已驗證身分（session / workflow actor），不能靠 payload 旗標冒充 Owner 直達。
const SPOOF_KEYS = ["owner_direct", "ownerDirect", "manual_owner", "manualOwner"];

export function hasSpoofedOwnerDirect(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  for (const key of SPOOF_KEYS) {
    const v = body[key];
    if (v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true") return true;
  }
  const source = String(body.instruction_source || body.instructionSource || "").toLowerCase();
  return source === "owner_direct" || source === "manual_owner";
}

export function rejectSpoofedOwnerDirect(body) {
  if (hasSpoofedOwnerDirect(body)) {
    throw httpError("instruction source must be a verified session, not a payload flag", 403);
  }
}
