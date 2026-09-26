import { isListingSearchUnavailable, SEARCH_UNAVAILABLE_CODE } from "./listingSearchAsync.js";

// Shared by both HTTP read entry points. Never expose database exception text.
export function sendListingSearchUnavailable(res, error) {
  if (!isListingSearchUnavailable(error)) return false;
  res.status(503).json({
    error: "資料庫暫時無法連線，清單目前讀不到；請稍後重試，若持續發生請回報。",
    code: SEARCH_UNAVAILABLE_CODE,
  });
  return true;
}
