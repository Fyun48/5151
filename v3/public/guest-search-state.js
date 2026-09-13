/** Guest UI search snapshot. sessionStorage only — never a member profile. */
(function guestSearchState(global) {
  const KEY = "591_v3_guest_search";

  function defaults() {
    return {
      districts: [],
      priceMin: 0,
      priceMax: 0,
      kinds: ["whole"],
      sort: "newest",
      filter: "all",
      q: "",
      areaMax: 0,
      excludeRooftop: true,
      excludeLowFloors: true,
      minBuildingFloors: 0,
      hasParking: false,
      moreOpen: false,
      watchDistricts: [],
      workAddress: "",
      commuteKm: 0,
    };
  }

  function read(storage) {
    const store = storage || (typeof sessionStorage === "undefined" ? null : sessionStorage);
    try {
      const raw = store?.getItem(KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      return { ...defaults(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch {
      return defaults();
    }
  }

  function write(state, storage) {
    const store = storage || (typeof sessionStorage === "undefined" ? null : sessionStorage);
    if (!store) return read(store);
    const next = { ...defaults(), ...(state || {}) };
    next.districts = (Array.isArray(next.districts) ? next.districts : []).filter(Boolean).slice(0, 4);
    next.watchDistricts = (Array.isArray(next.watchDistricts) ? next.watchDistricts : []).filter(Boolean).slice(0, 4);
    store.setItem(KEY, JSON.stringify(next));
    return next;
  }

  function toQuery(state) {
    const s = { ...defaults(), ...(state || {}) };
    return {
      districts: Array.isArray(s.districts) ? s.districts.filter(Boolean).slice(0, 4) : [],
      kind: Array.isArray(s.kinds) ? s.kinds.join(",") : "",
      sort: s.sort || "newest",
      q: s.q || "",
      priceMin: Number(s.priceMin) || 0,
      priceMax: Number(s.priceMax) || 0,
      areaMax: Number(s.areaMax) || 0,
      excludeRooftop: s.excludeRooftop !== false,
      excludeLowFloors: s.excludeLowFloors !== false,
      minBuildingFloors: Number(s.minBuildingFloors) || 0,
      hasParking: s.hasParking === true,
      wholeFloorOnly: Array.isArray(s.kinds) && s.kinds.length === 1 && s.kinds[0] === "whole",
      watchDistricts: Array.isArray(s.watchDistricts) ? s.watchDistricts.filter(Boolean).slice(0, 4) : [],
      workAddress: String(s.workAddress || "").trim().slice(0, 120),
      commuteKm: Number(s.commuteKm) || 0,
    };
  }

  global.GuestSearchState = { KEY, defaults, read, write, toQuery };
})(typeof window !== "undefined" ? window : globalThis);
