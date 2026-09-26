// Capture the clock once, before any asynchronous work in a listing request.
export function listingRequestTime(asOf = null) {
  const now = asOf == null ? Date.now()
    : asOf instanceof Date ? asOf.getTime()
      : typeof asOf === "number" ? asOf : Date.parse(asOf);
  if (!Number.isFinite(now)) throw new TypeError("Invalid listing request asOf");
  return { now, asOf: new Date(now).toISOString() };
}
