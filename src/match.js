export function streetKey(address) {
  const text = String(address || "")
    .replace(/\s+/g, "")
    .replace(/-/g, "");
  if (!text) return "";
  const street = text
    .replace(/\d+巷.*$/, "")
    .replace(/\d+弄.*$/, "")
    .replace(/\d+之\d+號.*$/, "")
    .replace(/\d+號.*$/, "")
    .replace(/\d+$/, "");
  if (street.length < 5 || !/[路街道大道]/.test(street)) return "";
  return street;
}

export function coverKey(url) {
  return String(url || "")
    .replace(/!.*$/, "")
    .replace(/\?.*$/, "")
    .replace(/#.*$/, "");
}

export function areaNum(value) {
  const n = Number(String(value || "").replace(/坪/g, "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function floorMain(floorName) {
  const main = String(floorName || "").replace(/\s+/g, "").split("/")[0];
  const numbered = main.match(/(\d+)/);
  if (numbered) return numbered[1];
  return main.toLowerCase();
}

export function layoutRooms(layout) {
  const match = String(layout || "").match(/(\d+)\s*房/);
  return match ? Number(match[1]) : null;
}

export function communityId(listing) {
  if (listing.community_id && Number(listing.community_id) !== 0) {
    return `c${listing.community_id}`;
  }
  const bit = String(listing.source_key || "").split("|")[2] || "";
  return bit.startsWith("c") ? bit : "";
}

export function scoreMatch(incoming, previous) {
  if (!incoming || !previous) return null;
  if (Number(incoming.post_id) === Number(previous.post_id)) return null;
  if (incoming.source_key && incoming.source_key === previous.source_key) {
    return { level: "high", detail: `指紋相同，先前 #${previous.post_id}` };
  }

  const floorA = floorMain(incoming.floor_name);
  const floorB = floorMain(previous.floor_name);
  const areaA = areaNum(incoming.area_name);
  const areaB = areaNum(previous.area_name);
  const commA = communityId(incoming);
  const commB = communityId(previous);
  const streetA = streetKey(incoming.address);
  const streetB = streetKey(previous.address);
  const coverA = coverKey(incoming.cover);
  const coverB = coverKey(previous.cover);
  const roomsA = layoutRooms(incoming.layout);
  const roomsB = layoutRooms(previous.layout);
  const sameFloor = Boolean(floorA && floorA === floorB);
  const areaClose = areaA != null && areaB != null && Math.abs(areaA - areaB) <= 1;
  const areaTight = areaA != null && areaB != null && Math.abs(areaA - areaB) <= 0.5;
  const sameCover = Boolean(coverA && coverA === coverB);
  const sameRooms = roomsA != null && roomsA === roomsB;
  const sameRole = Boolean(incoming.role_name && incoming.role_name === previous.role_name);

  if (commA && commA === commB && sameFloor && areaTight) {
    return { level: "high", detail: `同社區＋樓層＋坪數，先前 #${previous.post_id}` };
  }

  if (streetA && streetA === streetB && sameFloor && areaClose && (sameCover || sameRooms || sameRole)) {
    const why = sameCover ? "封面接近" : sameRooms ? "格局相同" : "同一聯絡人";
    return { level: "medium", detail: `${streetA} · ${why}，先前 #${previous.post_id}` };
  }

  if (sameCover && sameFloor && areaClose && streetA && streetB && streetA.slice(0, 3) === streetB.slice(0, 3)) {
    return { level: "medium", detail: `封面圖相同，先前 #${previous.post_id}` };
  }

  return null;
}

export function bestMatch(incoming, candidates) {
  let medium = null;
  for (const previous of candidates || []) {
    const hit = scoreMatch(incoming, previous);
    if (!hit) continue;
    if (hit.level === "high") return { ...hit, listing: previous };
    if (!medium) medium = { ...hit, listing: previous };
  }
  return medium;
}
