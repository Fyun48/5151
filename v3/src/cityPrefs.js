/** 縣市顯示個人化：只隱藏主選擇區，不刪縣市主資料。 */

import { CITIES } from "./regions.js";

export function normalizeHiddenCityIds(value) {
  const allowed = new Set(CITIES.map((city) => Number(city.id)));
  return [...new Set((Array.isArray(value) ? value : []).map(Number).filter((id) => allowed.has(id)))];
}

export function cityDistrictKeys(cityId) {
  const city = CITIES.find((row) => Number(row.id) === Number(cityId));
  if (!city) return [];
  return (city.districts || []).map((district) => `${city.id}-${district.id}`);
}

export function hideCitySelection(settings, cityId) {
  const id = Number(cityId);
  const keys = new Set(cityDistrictKeys(id));
  const watchDistricts = (settings.watchDistricts || []).filter((key) => !keys.has(String(key)));
  const removed = (settings.watchDistricts || []).filter((key) => keys.has(String(key)));
  const hiddenCityIds = normalizeHiddenCityIds([...(settings.hiddenCityIds || []), id]);
  return {
    watchDistricts,
    hiddenCityIds,
    removedDistricts: removed,
    cityId: id,
  };
}

export function restoreCitySelection(settings, cityId) {
  const id = Number(cityId);
  return {
    watchDistricts: [...(settings.watchDistricts || [])],
    hiddenCityIds: normalizeHiddenCityIds(settings.hiddenCityIds).filter((item) => item !== id),
    cityId: id,
  };
}

export function visibleCities(hiddenCityIds = []) {
  const hidden = new Set(normalizeHiddenCityIds(hiddenCityIds));
  return CITIES.filter((city) => !hidden.has(Number(city.id)));
}

export function hiddenCities(hiddenCityIds = []) {
  const hidden = new Set(normalizeHiddenCityIds(hiddenCityIds));
  return CITIES.filter((city) => hidden.has(Number(city.id)));
}
