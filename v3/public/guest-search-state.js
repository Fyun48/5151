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
    store.setItem(KEY, JSON.stringify(next));
    return next;
  }

  function toQuery(state) {
    const s = { ...defaults(), ...(state || {}) };
    return {
      districts: Array.isArray(s.districts) ? s.districts.filter(Boolean) : [],
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
    };
  }

  global.GuestSearchState = { KEY, defaults, read, write, toQuery };
})(typeof window !== "undefined" ? window : globalThis);
