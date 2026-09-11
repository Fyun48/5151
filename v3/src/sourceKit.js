/** 住商／信義／好房／樂屋的家俱瓦斯陽台補抓。591／5168／租租通走既有明細，不走這裡。 */

import { fetchHbDetailKit } from "./hbhousing.js";
import { fetchHfDetailKit } from "./housefun.js";
import { listingKitFrom } from "./listingKit.js";
import { fetchRakuyaDetailKit } from "./rakuya.js";
import { fetchSinyiDetailKit } from "./sinyi.js";

export const SOURCE_KIT_SOURCES = Object.freeze(["hbhousing", "sinyi", "housefun", "rakuya"]);

export function isSourceKitSource(source) {
  return SOURCE_KIT_SOURCES.includes(String(source || ""));
}

export async function fetchSourceKit(listing, options = {}) {
  const source = String(listing?.source || "");
  if (source === "hbhousing") return fetchHbDetailKit(listing, options);
  if (source === "sinyi") return fetchSinyiDetailKit(listing, options);
  if (source === "housefun") return fetchHfDetailKit(listing, options);
  if (source === "rakuya") return fetchRakuyaDetailKit(listing, options);
  return listingKitFrom(listing || {});
}
