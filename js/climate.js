// Resumen climático de un punto con 10 años de datos diarios de Open-Meteo (ERA5).
const START = '2016-01-01', END = '2025-12-31', YEARS = 10;
const KEY = 'qtl-climate';

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const store = load();
const inflight = new Map();
const RETRY_MS = 2 * 60 * 1000;
let downUntil = 0;           // Open-Meteo a veces responde 503 por sobrecarga: se espera antes de reintentar
const keyOf = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

export function summarize(daily, lat) {
  const { time, temperature_2m_max: tmax, precipitation_sum: rain, sunshine_duration: sun } = daily;
  const summer = lat < 0 ? [12, 1, 2] : [6, 7, 8];
  const winter = lat < 0 ? [6, 7, 8] : [12, 1, 2];
  let rainSum = 0, rainDays = 0, sunSum = 0, sunN = 0;
  const s = [0, 0], w = [0, 0];
  time.forEach((day, i) => {
    const month = +day.slice(5, 7);
    if (rain[i] != null) { rainSum += rain[i]; if (rain[i] >= 1) rainDays++; }
    if (sun[i] != null) { sunSum += sun[i]; sunN++; }
    if (tmax[i] == null) return;
    if (summer.includes(month)) { s[0] += tmax[i]; s[1]++; }
    if (winter.includes(month)) { w[0] += tmax[i]; w[1]++; }
  });
  return {
    rainMm: Math.round(rainSum / YEARS / 10) * 10,
    rainDays: Math.round(rainDays / YEARS),
    summerMax: Math.round(s[0] / s[1]),
    winterMax: Math.round(w[0] / w[1]),
    sunHours: Math.round((sunSum / sunN / 3600) * 10) / 10,
  };
}

export function climate(lat, lon) {
  const key = keyOf(lat, lon);
  if (store[key]) return Promise.resolve(store[key]);
  if (inflight.has(key)) return inflight.get(key);
  if (Date.now() < downUntil) return Promise.resolve(null);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
    `&start_date=${START}&end_date=${END}&daily=temperature_2m_max,precipitation_sum,sunshine_duration&timezone=UTC`;
  const job = fetch(url)
    .then((r) => {
      if (r.ok) return r.json();
      if (r.status >= 500 || r.status === 429) downUntil = Date.now() + RETRY_MS;
      return null;
    })
    .then((j) => {
      if (!j?.daily?.time?.length) return null;
      store[key] = summarize(j.daily, lat);
      try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* sin almacenamiento */ }
      return store[key];
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

climate.cached = (lat, lon) => store[keyOf(lat, lon)];
