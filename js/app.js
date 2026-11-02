import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.14.0/dist/maplibre-gl.mjs';
import { DEFAULTS } from './engine.js';
import { colorAt, CONTOURS } from './colors.js';
import { climate } from './climate.js';
import { osrmLeg, osrmKnown, onOsrm } from './osrm.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- Worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 0;
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  if (data.error) p.reject(new Error(data.error));
  else p.resolve(data.result);
};
const call = (type, args) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, type, args });
});

// ---------- Estado ----------
const MAX_ORIGINS = 4;
const MAX_CANDIDATES = 8;
const LETTERS = 'ABCD';
const SCENARIOS = {
  any: { label: 'Cualquier día', window: 0 },
  weekend: { label: 'Fin de semana', window: 48 * 60, span: 'vie 19:00 → dom 19:00' },
  long: { label: 'Fin de semana largo', window: 72 * 60, span: 'vie 19:00 → lun 19:00' },
};
const APP_DEFAULTS = { scenario: 'any', combine: 'max', weekendTraffic: 1.8 };
const minutes = (v) => fmt(v);
const factor = (v) => `×${v.toFixed(1).replace('.', ',')}`;
const SETTINGS = [
  { key: 'weekendTraffic', label: 'Taco en fin de semana (primeros 60 km)', min: 1, max: 3, step: 0.1, format: factor },
  { key: 'checkin', label: 'En el aeropuerto antes de volar', min: 30, max: 240, step: 15 },
  { key: 'exit', label: 'Salir del aeropuerto al llegar', min: 0, max: 120, step: 5 },
  { key: 'connection', label: 'Escala entre vuelos', min: 30, max: 360, step: 15 },
  { key: 'international', label: 'Extra por migración (internacional)', min: 0, max: 180, step: 15 },
  { key: 'redFrom', label: 'Rojo desde', min: 60, max: 1440, step: 30, viewOnly: true },
];

const load = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ } };

const state = {
  ready: false,
  origins: [],
  candidates: [],
  evals: [],
  dest: null,
  picking: true,
  version: 0,
  params: { ...DEFAULTS, ...APP_DEFAULTS, ...load('qtl-params') },
};
const scenario = () => SCENARIOS[state.params.scenario] ?? SCENARIOS.any;
const engineParams = () => ({
  ...state.params,
  traffic: state.params.scenario === 'any' ? 1 : state.params.weekendTraffic,
});
const viewParams = () => ({ redFrom: state.params.redFrom, window: scenario().window, combine: state.params.combine });

export function fmt(min) {
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) {
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(min / 1440), h = Math.round((min % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}
const fmtKm = (km) => `${Math.round(km).toLocaleString('es-CL')} km`;
const hoursThere = (travel, window) => {
  const h = (window - 2 * travel) / 60;
  return h > 0 ? `${Math.floor(h)} h allá` : 'no alcanza';
};
function combine(values) {
  if (!values.length || values.some((v) => v == null || v === Infinity)) return null;
  return state.params.combine === 'avg' ? values.reduce((s, v) => s + v, 0) / values.length : Math.max(...values);
}
const combineLabel = () => (state.origins.length < 2 ? '' :
  state.params.combine === 'avg' ? `promedio de ${state.origins.length} orígenes` : `el más lejano de ${state.origins.length} orígenes`);
const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

// ---------- Mapa ----------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-68, -33],
  zoom: 3.4,
  attributionControl: {
    compact: true,
    customAttribution: 'Caminos: <a href="https://www.naturalearthdata.com/">Natural Earth</a> · Vuelos: <a href="https://github.com/Jonty/airline-route-data">airline-route-data</a> · Rutas: <a href="https://project-osrm.org/">OSRM</a> · Clima: <a href="https://open-meteo.com/">Open-Meteo</a>',
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
window.__map = map;

const blank = createImageBitmap(new ImageData(1, 1));
maplibregl.addProtocol('heat', async (params) => {
  const [z, x, y] = params.url.match(/^heat:\/\/(\d+)\/(\d+)\/(\d+)/).slice(1).map(Number);
  const bitmap = await call('tile', { z, x, y });
  return { data: bitmap ?? (await blank) };
});

const pin = (cls, label = '') => {
  const el = document.createElement('div');
  el.className = `pin ${cls}`;
  if (label) el.innerHTML = `<span>${esc(label)}</span>`;
  return el;
};
const destMarker = new maplibregl.Marker({ element: pin('pin-dest'), anchor: 'bottom' });
let originMarkers = [];
let candidateMarkers = [];

function syncOriginMarkers() {
  originMarkers.forEach((m) => m.remove());
  originMarkers = state.origins.map((o, i) => {
    const m = new maplibregl.Marker({ element: pin('pin-origin', state.origins.length > 1 ? LETTERS[i] : ''), draggable: true, anchor: 'bottom' })
      .setLngLat([o.lon, o.lat]).addTo(map);
    m.on('dragend', () => {
      const { lng, lat } = m.getLngLat().wrap();
      state.origins[i] = { lat, lon: lng };
      placesChanged({ origins: true });
    });
    return m;
  });
}

function syncCandidateMarkers() {
  candidateMarkers.forEach((m) => m.remove());
  candidateMarkers = state.candidates.map((c, i) => {
    const el = pin('pin-cand', String(i + 1));
    el.addEventListener('click', (e) => { e.stopPropagation(); setDest(c.lat, c.lon); });
    return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([c.lon, c.lat]).addTo(map);
  });
}

const mapLoaded = new Promise((resolve) => map.on('load', resolve));
mapLoaded.then(() => {
  // El calor tapa parques, bosques y zonas urbanas del mapa base; agua, calles y
  // nombres quedan encima
  const layers = map.getStyle().layers;
  const above = layers.find((l) => l.type !== 'background' && l.type !== 'fill' && l.type !== 'raster')?.id;
  map.addSource('heat', { type: 'raster', tiles: ['heat://{z}/{x}/{y}?v=0'], tileSize: 256, maxzoom: 10 });
  map.addLayer({
    id: 'heat', type: 'raster', source: 'heat',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.75, 'raster-resampling': 'linear', 'raster-fade-duration': 150 },
  }, above);
  for (const l of layers) if (l.type === 'fill' && /water|ocean|lake/.test(l.id)) map.moveLayer(l.id, above);
  map.addSource('trip', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'trip-casing', type: 'line', source: 'trip',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'trip-drive', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'drive'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1f2430', 'line-width': 3 } });
  map.addLayer({ id: 'trip-flight', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'flight'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#1f2430', 'line-width': 2.5, 'line-dasharray': [0.5, 2] } });
});

// ---------- Cálculo ----------
let computeTimer = null, computeToken = 0;
async function recompute() {
  if (!state.ready) return;
  const token = ++computeToken;
  await mapLoaded;
  if (!state.origins.length) {
    map.setLayoutProperty('heat', 'visibility', 'none');
    return;
  }
  setStatus('Calculando…');
  const res = await call('compute', { origins: state.origins, params: engineParams() });
  if (token !== computeToken) return;
  await call('view', viewParams());
  refreshTiles();
  setStatus(`Calculado en ${res.ms} ms`, 1500);
  if (state.dest) showTrip();
  evaluateCandidates();
}
function scheduleRecompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(recompute, 200);
}
async function refreshView() {
  if (!state.ready || !state.origins.length) return;
  await call('view', viewParams());
  refreshTiles();
  if (state.dest) showTrip();
  renderCandidates();
}
function refreshTiles() {
  state.version++;
  map.getSource('heat').setTiles([`heat://{z}/{x}/{y}?v=${state.version}`]);
  map.setLayoutProperty('heat', 'visibility', 'visible');
}

function placesChanged({ origins = false, candidates = false } = {}) {
  save('qtl-places', { origins: state.origins, candidates: state.candidates });
  writeHash();
  if (origins) { syncOriginMarkers(); renderOrigins(); recompute(); }
  if (candidates) { syncCandidateMarkers(); evaluateCandidates(); }
  syncUI();
}

function addOrigin(lat, lon, { fly = false } = {}) {
  if (state.origins.length >= MAX_ORIGINS) return;
  state.origins.push({ lat, lon });
  state.picking = false;
  if (fly) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 4.5) });
  placesChanged({ origins: true });
}
function removeOrigin(i) {
  state.origins.splice(i, 1);
  if (!state.origins.length) { state.picking = true; clearDest(); }
  placesChanged({ origins: true });
}

function setDest(lat, lon) {
  state.dest = { lat, lon };
  destMarker.setLngLat([lon, lat]).addTo(map);
  writeHash();
  showTrip();
}
function clearDest() {
  state.dest = null;
  destMarker.remove();
  map.getSource('trip')?.setData({ type: 'FeatureCollection', features: [] });
  $('trip').hidden = true;
  writeHash();
}

// ---------- Viaje ----------
const LEG = {
  drive: { icon: '🚗', cls: 'leg-drive' },
  checkin: { icon: '🛂', cls: 'leg-airport' },
  border: { icon: '🛃', cls: 'leg-airport' },
  connection: { icon: '⏳', cls: 'leg-airport' },
  flight: { icon: '✈️', cls: 'leg-flight' },
  exit: { icon: '🧳', cls: 'leg-airport' },
};

function legTitle(leg, i, legs) {
  switch (leg.kind) {
    case 'drive': {
      const next = legs[i + 1];
      if (legs.length === 1) return { title: 'En auto, directo', sub: fmtKm(leg.km) };
      if (next?.kind === 'checkin') return { title: `Auto al aeropuerto ${next.airport.iata}`, sub: `${next.airport.city} · ${fmtKm(leg.km)}` };
      return { title: 'Auto hasta el destino', sub: fmtKm(leg.km) };
    }
    case 'checkin': return { title: `Aeropuerto ${leg.airport.iata}`, sub: 'Check-in, seguridad y embarque' };
    case 'border': return { title: 'Migración', sub: 'Extra por vuelo internacional' };
    case 'connection': return { title: `Escala en ${leg.airport.iata}`, sub: leg.airport.city };
    case 'flight': return {
      title: `Vuelo ${leg.from.iata} → ${leg.to.iata}`,
      sub: `${leg.to.city} · ${fmtKm(leg.km)}${leg.carriers.length ? ' · ' + leg.carriers.join(', ') : ''}`,
    };
    case 'exit': return { title: `Llegada a ${leg.airport.iata}`, sub: 'Bajar del avión y salir del aeropuerto' };
  }
}

function legsHTML(trip) {
  return `
    <div class="timeline">${trip.legs.map((l) => `<span class="${LEG[l.kind].cls}" style="flex-grow:${Math.max(l.min, 1)}" title="${esc(fmt(l.min))}"></span>`).join('')}</div>
    <ol class="legs">${trip.legs.map((l, i) => {
      const { title, sub } = legTitle(l, i, trip.legs);
      return `<li><span class="leg-icon ${LEG[l.kind].cls}" aria-hidden="true">${LEG[l.kind].icon}</span>
        <span class="leg-text"><strong>${esc(title)}</strong><small>${esc(sub)}</small></span>
        <span class="leg-time">${fmt(l.min)}</span></li>`;
    }).join('')}</ol>`;
}

const originLabel = (i) => $(`origin-name-${i}`)?.textContent || `Origen ${LETTERS[i]}`;

let tripToken = 0;
async function showTrip() {
  if (!state.dest || !state.origins.length) return;
  const token = ++tripToken;
  const { lat, lon } = state.dest;
  const res = await call('trip', { lat, lon });
  if (token !== tripToken || !res) return;
  const { trips } = res;
  const total = combine(trips.map((t) => t?.total));
  const card = $('trip');
  const saved = state.candidates.some((c) => samePlace(c, state.dest));
  const sc = scenario();
  card.hidden = false;
  const head = `<div class="trip-head">
      <div><span class="label">Destino</span><strong id="dest-name">…</strong></div>
      <button class="icon-btn" id="close-trip" aria-label="Cerrar">×</button>
    </div>`;
  if (total === null) {
    card.innerHTML = `${head}<p class="muted">No hay forma de llegar con caminos ni vuelos regulares${state.origins.length > 1 ? ' desde todos los orígenes' : ''} (por ejemplo, en el mar o en una isla sin aeropuerto).</p>`;
  } else {
    const swatch = colorAt(total, state.params.redFrom);
    const context = [combineLabel(), sc.window ? 'con taco de fin de semana' : '', state.params.flights ? '' : 'solo auto'].filter(Boolean).join(' · ');
    const perOrigin = trips.length === 1 ? legsHTML(trips[0]) : trips.map((t, i) => `
      <details class="per-origin"${i === 0 ? ' open' : ''}>
        <summary><span class="badge">${LETTERS[i]}</span><span>Desde ${esc(originLabel(i))}</span><strong>${t ? fmt(t.total) : '—'}</strong></summary>
        ${t ? legsHTML(t) : '<p class="muted">Sin conexión</p>'}
      </details>`).join('');
    card.innerHTML = `${head}
      <div class="total"><span class="swatch" style="background: rgb(${swatch})"></span><span>${fmt(total)}</span></div>
      ${context ? `<p class="context">${esc(context)}</p>` : ''}
      ${sc.window ? `<p class="useful"><strong>${hoursThere(total, sc.window)}</strong> en un ${sc.label.toLowerCase()} (${sc.span})</p>` : ''}
      ${perOrigin}
      <div class="climate" id="trip-climate"><span class="muted">Cargando clima…</span></div>
      <div class="row wrap">
        <button class="chip" id="save-cand" ${saved || state.candidates.length >= MAX_CANDIDATES ? 'disabled' : ''}>${saved ? '★ Guardado como candidato' : '☆ Guardar como candidato'}</button>
        ${state.origins.length < MAX_ORIGINS ? '<button class="link-btn" id="use-as-origin">Agregar como origen</button>' : ''}
      </div>`;
    $('save-cand').onclick = () => {
      state.candidates.push({ ...state.dest });
      placesChanged({ candidates: true });
      showTrip();
    };
    const asOrigin = $('use-as-origin');
    if (asOrigin) asOrigin.onclick = () => { const d = state.dest; clearDest(); addOrigin(d.lat, d.lon); };
    climate(lat, lon).then((c) => {
      const el = $('trip-climate');
      if (el && token === tripToken) el.innerHTML = climateHTML(c, lat);
    });
  }
  $('close-trip').onclick = clearDest;
  name($('dest-name'), lat, lon);
  drawTrip(trips.filter(Boolean));
}

function climateHTML(c, lat) {
  if (!c) return '<span class="muted">Clima no disponible</span>';
  const summer = lat < 0 ? 'dic–feb' : 'jun–ago';
  return `<span class="label">Clima (promedio 2016–2025)</span>
    <div class="climate-grid">
      <span>🌧 <strong>${c.rainDays}</strong> días de lluvia al año</span>
      <span>💧 <strong>${c.rainMm.toLocaleString('es-CL')}</strong> mm al año</span>
      <span>🌡 <strong>${c.summerMax}°</strong> máx. en verano (${summer})</span>
      <span>🧥 <strong>${c.winterMax}°</strong> máx. en invierno</span>
      <span>☀️ <strong>${c.sunHours.toLocaleString('es-CL')}</strong> h de sol al día</span>
    </div>`;
}

function greatCircle(a, b, steps = 64) {
  const toV = (p) => {
    const la = (p.lat * Math.PI) / 180, lo = (p.lon * Math.PI) / 180;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const va = toV(a), vb = toV(b);
  const omega = Math.acos(Math.min(1, va.reduce((s, v, i) => s + v * vb[i], 0)));
  const pts = [];
  let prevLon = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const k1 = omega ? Math.sin((1 - t) * omega) / Math.sin(omega) : 1 - t;
    const k2 = omega ? Math.sin(t * omega) / Math.sin(omega) : t;
    const v = va.map((x, j) => k1 * x + k2 * vb[j]);
    let lon = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
    const lat = (Math.atan2(v[2], Math.hypot(v[0], v[1])) * 180) / Math.PI;
    if (prevLon !== null) while (lon - prevLon > 180) lon -= 360;
    if (prevLon !== null) while (prevLon - lon > 180) lon += 360;
    prevLon = lon;
    pts.push([lon, lat]);
  }
  return pts;
}

function drawTrip(trips) {
  const features = trips.flatMap((trip) => trip.legs.filter((l) => l.path).map((l) => ({
    type: 'Feature',
    properties: { kind: l.kind === 'flight' ? 'flight' : 'drive' },
    geometry: { type: 'LineString', coordinates: l.kind === 'flight' ? greatCircle(l.path[0], l.path[1]) : l.path.map((p) => [p.lon, p.lat]) },
  })));
  map.getSource('trip')?.setData({ type: 'FeatureCollection', features });
}

// ---------- Candidatos ----------
let evalToken = 0;
async function evaluateCandidates() {
  const token = ++evalToken;
  if (!state.ready || !state.origins.length || !state.candidates.length) {
    state.evals = [];
    renderCandidates();
    return;
  }
  state.evals = [];
  renderCandidates();
  const out = await call('evaluate', {
    origins: state.origins, candidates: state.candidates,
    params: { ...state.params, traffic: 1 }, traffic: state.params.weekendTraffic,
  });
  if (token !== evalToken) return;
  state.evals = out;
  renderCandidates();
  // Ruta exacta para los tramos en auto (OSRM sobre OpenStreetMap)
  for (const perOrigin of out) for (const o of perOrigin) for (const leg of o.trip?.legs ?? []) {
    if (leg.kind === 'drive' && leg.km >= 1) osrmLeg(leg.path[0], leg.path.at(-1));
  }
  state.candidates.forEach((c) => climate(c.lat, c.lon).then(renderCandidates));
}
onOsrm(() => renderCandidates());

// Tiempo normal con los tramos en auto corregidos por OSRM cuando ya llegaron
function refined(trip) {
  let total = trip.total, exact = true;
  for (const leg of trip.legs) {
    if (leg.kind !== 'drive' || leg.km < 1) continue;
    const real = osrmKnown(leg.path[0], leg.path.at(-1));
    if (real == null) exact = false;
    else total += real - leg.min;
  }
  return { total, exact };
}

function candidateStats(i) {
  const ev = state.evals[i];
  if (!ev) return null;
  if (ev.some((o) => !o.trip)) return { unreachable: true };
  const per = ev.map((o) => {
    const r = refined(o.trip);
    return { normal: r.total, taco: r.total + (o.taco - o.trip.total), exact: r.exact, flight: o.trip.legs.some((l) => l.kind === 'flight') };
  });
  return {
    normal: combine(per.map((p) => p.normal)),
    taco: combine(per.map((p) => p.taco)),
    exact: per.every((p) => p.exact),
    flight: per.some((p) => p.flight),
  };
}

function renderCandidates() {
  const sec = $('candidates');
  sec.hidden = !state.candidates.length;
  if (sec.hidden) return;
  $('cand-context').textContent = [combineLabel(), state.params.flights ? 'auto + avión' : 'solo auto'].filter(Boolean).join(' · ');
  const rows = state.candidates.map((c, i) => ({ c, i, s: candidateStats(i) }));
  rows.sort((a, b) => (a.s?.taco ?? Infinity) - (b.s?.taco ?? Infinity));
  $('cand-list').innerHTML = rows.map(({ c, i, s }) => {
    const nm = names.get(placeKey(c.lat, c.lon)) ?? `${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`;
    const cl = climateCache(c.lat, c.lon);
    let body;
    if (!s) body = '<small class="muted">Calculando…</small>';
    else if (s.unreachable) body = '<small class="muted">Sin conexión desde algún origen</small>';
    else body = `
      <span class="cand-stats">
        <span><b>${fmt(s.normal)}</b>normal</span>
        <span><b>${fmt(s.taco)}</b>viernes con taco</span>
        <span><b>${hoursThere(s.taco, SCENARIOS.weekend.window)}</b>fin de semana</span>
        <span><b>${hoursThere(s.taco, SCENARIOS.long.window)}</b>fds largo</span>
      </span>
      <small class="muted">${[
        s.exact ? '✓ ruta exacta' : 'ruta estimada…',
        s.flight ? 'incluye vuelo' : '',
        cl ? `🌧 ${cl.rainDays} días · 🌡 ${cl.summerMax}° verano · ☀️ ${cl.sunHours.toLocaleString('es-CL')} h` : '',
      ].filter(Boolean).join(' · ')}</small>`;
    return `<li class="cand">
      <button class="cand-main" data-i="${i}"><span class="cand-num">${i + 1}</span>
        <span class="cand-body"><strong>${esc(nm)}</strong>${body}</span></button>
      <button class="icon-btn" data-remove="${i}" aria-label="Quitar candidato">×</button>
    </li>`;
  }).join('');
  $('cand-list').querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => {
      const c = state.candidates[+b.dataset.i];
      setDest(c.lat, c.lon);
      map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 6) });
    };
  });
  $('cand-list').querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = () => {
      state.candidates.splice(+b.dataset.remove, 1);
      placesChanged({ candidates: true });
      if (state.dest) showTrip();
    };
  });
  for (const c of state.candidates) {
    const key = placeKey(c.lat, c.lon);
    if (!names.has(key) && !naming.has(key)) {
      naming.add(key);
      reverse(c.lat, c.lon).then(() => renderCandidates());
    }
  }
}

// ---------- Nombres de lugares ----------
const names = new Map(Object.entries(load('qtl-names') ?? {}));
const naming = new Set();
const placeKey = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
async function reverse(lat, lon) {
  const key = placeKey(lat, lon);
  if (names.has(key)) return names.get(key);
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=1`);
    const p = (await res.json()).features?.[0]?.properties;
    if (!p) return null;
    names.set(key, placeLabel(p));
    save('qtl-names', Object.fromEntries([...names].slice(-200)));
    return names.get(key);
  } catch {
    return null;
  }
}
async function name(el, lat, lon) {
  el.textContent = names.get(placeKey(lat, lon)) ?? `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  const label = await reverse(lat, lon);
  if (label && el.isConnected) el.textContent = label;
}
function placeLabel(p) {
  const main = p.city || p.name || p.county || p.state;
  const rest = [p.city && p.name !== p.city ? null : p.state, p.country].filter((x) => x && x !== main);
  return [main, ...rest].filter(Boolean).join(', ');
}

// ---------- Clima ----------
const climateCache = (lat, lon) => climate.cached(lat, lon);

// ---------- Búsqueda ----------
let searchTimer = null, searchToken = 0;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 250);
});
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('results').querySelector('button')?.click(); }
  if (e.key === 'Escape') { $('results').innerHTML = ''; }
});
async function search() {
  const q = $('q').value.trim();
  const token = ++searchToken;
  if (q.length < 2) { $('results').innerHTML = ''; return; }
  const c = map.getCenter();
  try {
    const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=${c.lat}&lon=${c.lng}`);
    const features = (await res.json()).features ?? [];
    if (token !== searchToken) return;
    $('results').innerHTML = features.map((f, i) => {
      const p = f.properties;
      const detail = [p.city !== p.name ? p.city : null, p.state, p.country].filter(Boolean).join(', ');
      return `<li><button data-i="${i}"><strong>${esc(p.name)}</strong><small>${esc(detail)}</small></button></li>`;
    }).join('') || '<li class="muted">Sin resultados</li>';
    $('results').querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const [lon, lat] = features[+b.dataset.i].geometry.coordinates;
        $('results').innerHTML = '';
        $('q').value = '';
        if (state.picking || !state.origins.length) addOrigin(lat, lon, { fly: true });
        else { setDest(lat, lon); map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 4.5) }); }
      };
    });
  } catch {
    $('results').innerHTML = '<li class="muted">No se pudo buscar</li>';
  }
}

// ---------- Clic y hover ----------
map.on('click', (e) => {
  if (!state.ready) return;
  const { lat, lng } = e.lngLat.wrap();
  if (state.picking || !state.origins.length) addOrigin(lat, lng);
  else setDest(lat, lng);
});

let hoverPending = false, hoverEvent = null;
map.on('mousemove', (e) => {
  hoverEvent = e;
  if (hoverPending || !state.origins.length || state.picking) return;
  hoverPending = true;
  requestAnimationFrame(async () => {
    const ev = hoverEvent;
    const { lat, lng } = ev.lngLat.wrap();
    const t = await call('probe', { lat, lon: lng });
    hoverPending = false;
    const tip = $('tooltip');
    if (t === null) { tip.hidden = true; return; }
    const w = scenario().window;
    tip.textContent = w ? `${fmt(t)} · ${hoursThere(t, w)}` : fmt(t);
    tip.style.transform = `translate(${ev.point.x + 14}px, ${ev.point.y + 14}px)`;
    tip.hidden = false;
  });
});
map.getCanvas().addEventListener('mouseleave', () => { $('tooltip').hidden = true; });

// ---------- Interfaz ----------
function renderOrigins() {
  $('origin-list').innerHTML = state.origins.map((o, i) => `
    <li><span class="badge">${state.origins.length > 1 ? LETTERS[i] : '●'}</span>
      <button class="origin-name" data-fly="${i}" id="origin-name-${i}">…</button>
      <button class="icon-btn" data-remove-origin="${i}" aria-label="Quitar origen">×</button></li>`).join('');
  state.origins.forEach((o, i) => name($(`origin-name-${i}`), o.lat, o.lon));
  $('origin-list').querySelectorAll('[data-fly]').forEach((b) => {
    b.onclick = () => { const o = state.origins[+b.dataset.fly]; map.flyTo({ center: [o.lon, o.lat], zoom: Math.max(map.getZoom(), 6) }); };
  });
  $('origin-list').querySelectorAll('[data-remove-origin]').forEach((b) => { b.onclick = () => removeOrigin(+b.dataset.removeOrigin); });
}

function syncUI() {
  const n = state.origins.length;
  $('origins').hidden = !n;
  $('scenario-box').hidden = !n;
  $('legend').hidden = !n;
  $('hint').hidden = n > 0 && !state.picking;
  $('hint').textContent = n
    ? 'Toca el mapa o busca el nuevo origen (por ejemplo, la casa de tus papás o la oficina).'
    : 'Toca el mapa o busca un lugar para elegir tu punto de partida.';
  $('q').placeholder = state.picking || !n ? 'Buscar punto de partida…' : 'Buscar destino…';
  $('cancel-pick').hidden = !(n && state.picking);
  $('add-origin').hidden = n >= MAX_ORIGINS || state.picking;
  $('combine-row').hidden = n < 2;
  for (const [group, key] of [['seg-flights', 'flights'], ['seg-scenario', 'scenario'], ['seg-combine', 'combine']]) {
    $(group).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(state.params[key]))));
  }
  document.body.classList.toggle('picking', state.picking);
  drawLegend();
}

$('add-origin').onclick = () => { state.picking = true; syncUI(); $('q').focus(); };
$('cancel-pick').onclick = () => { state.picking = false; syncUI(); };

function segmented(id, key, parse, after) {
  $(id).querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      state.params[key] = parse(b.dataset.value);
      save('qtl-params', state.params);
      syncUI();
      after();
    };
  });
}
segmented('seg-flights', 'flights', (v) => v === 'true', scheduleRecompute);
segmented('seg-scenario', 'scenario', (v) => v, scheduleRecompute);
segmented('seg-combine', 'combine', (v) => v, refreshView);

function drawLegend() {
  const red = state.params.redFrom;
  const max = red * 4;
  const w = scenario().window;
  const stops = Array.from({ length: 25 }, (_, i) => {
    const t = (max * i) / 24;
    return `${w && t >= w / 2 ? 'rgb(150,155,165)' : `rgb(${colorAt(t, red)})`} ${(i / 24) * 100}%`;
  });
  $('legend-bar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  const ticks = [0, red, red * 2, red * 3, max];
  const label = (t) => (w ? `${Math.max(0, Math.round((w - 2 * t) / 60))} h` : t === 0 ? '0' : fmt(t));
  $('legend-ticks').innerHTML = ticks.map((t) =>
    `<span style="left:${(t / max) * 100}%">${label(t)}${t === max && !w ? '+' : ''}</span>`).join('');
  $('legend-title').textContent = w
    ? `Horas que alcanzas a estar allá (${scenario().span}, ida y vuelta con taco)`
    : 'Tiempo de viaje puerta a puerta';
  $('legend-red').textContent = fmt(red);
  $('legend-lines').textContent = `${CONTOURS.slice(0, 6).join(', ')}, ${CONTOURS.slice(6, 9).join(', ')}… h`;
  $('legend-nogo').hidden = !w;
}

function buildSettings() {
  $('settings-body').innerHTML = SETTINGS.map((s) => `
    <label class="setting">
      <span class="setting-head"><span>${s.label}</span><output id="out-${s.key}"></output></span>
      <input type="range" id="in-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}">
    </label>`).join('') + '<button class="link-btn" id="reset">Restaurar valores</button>';
  for (const s of SETTINGS) {
    const input = $(`in-${s.key}`), out = $(`out-${s.key}`);
    const show = s.format ?? minutes;
    input.value = state.params[s.key];
    out.textContent = show(state.params[s.key]);
    input.addEventListener('input', () => {
      state.params[s.key] = +input.value;
      out.textContent = show(+input.value);
      save('qtl-params', state.params);
      if (s.viewOnly) { drawLegend(); refreshView(); } else scheduleRecompute();
    });
  }
  $('reset').onclick = () => {
    const { scenario: sc, combine: cb, flights } = state.params;
    state.params = { ...DEFAULTS, ...APP_DEFAULTS, scenario: sc, combine: cb, flights };
    save('qtl-params', state.params);
    buildSettings();
    syncUI();
    scheduleRecompute();
  };
}

let statusTimer = null;
function setStatus(text, hideAfter) {
  const el = $('status');
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(statusTimer);
  if (hideAfter) statusTimer = setTimeout(() => { el.hidden = true; }, hideAfter);
}

// ---------- Enlace compartible ----------
const pts = (list) => list.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(';');
function writeHash() {
  const parts = [];
  if (state.origins.length) parts.push(`o=${pts(state.origins)}`);
  if (state.dest) parts.push(`d=${pts([state.dest])}`);
  if (state.candidates.length) parts.push(`c=${pts(state.candidates)}`);
  history.replaceState(null, '', parts.length ? `#${parts.join('&')}` : location.pathname);
}
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const list = (k) => (params.get(k) ?? '').split(';').map((s) => s.split(',').map(Number))
    .filter((v) => v.length === 2 && v.every(Number.isFinite)).map(([lat, lon]) => ({ lat, lon }));
  return { origins: list('o').slice(0, MAX_ORIGINS), dest: list('d')[0] ?? null, candidates: list('c').slice(0, MAX_CANDIDATES), present: params.has('o') };
}

function applyPlaces({ origins, dest, candidates }) {
  state.origins = origins;
  state.candidates = candidates;
  state.picking = !origins.length;
  if (origins.length) map.jumpTo({ center: [origins[0].lon, origins[0].lat], zoom: Math.max(map.getZoom(), 4) });
  if (dest) { state.dest = dest; destMarker.setLngLat([dest.lon, dest.lat]).addTo(map); } else clearDest();
  placesChanged({ origins: true, candidates: true });
}

// ---------- Inicio ----------
buildSettings();
syncUI();
setStatus('Cargando caminos y vuelos del mundo…');
call('init').then(async ({ airports, routes }) => {
  state.ready = true;
  $('data-stats').textContent = `${airports.toLocaleString('es-CL')} aeropuertos y ${routes.toLocaleString('es-CL')} rutas aéreas.`;
  setStatus('');
  const fromHash = readHash();
  const stored = load('qtl-places');
  applyPlaces(fromHash.present ? fromHash : {
    origins: (stored?.origins ?? []).slice(0, MAX_ORIGINS), dest: null,
    candidates: (stored?.candidates ?? []).slice(0, MAX_CANDIDATES),
  });
  window.addEventListener('hashchange', () => { const h = readHash(); if (h.present) applyPlaces(h); });
}).catch((err) => {
  console.error(err);
  setStatus('No se pudieron cargar los datos. Recarga la página.');
});
