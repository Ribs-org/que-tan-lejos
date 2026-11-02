import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.14.0/dist/maplibre-gl.mjs';
import { DEFAULTS } from './engine.js';
import { colorAt, CONTOURS } from './colors.js';

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
const SETTINGS = [
  { key: 'checkin', label: 'En el aeropuerto antes de volar', min: 30, max: 240, step: 15 },
  { key: 'exit', label: 'Salir del aeropuerto al llegar', min: 0, max: 120, step: 5 },
  { key: 'connection', label: 'Escala entre vuelos', min: 30, max: 360, step: 15 },
  { key: 'international', label: 'Extra por migración (internacional)', min: 0, max: 180, step: 15 },
  { key: 'redFrom', label: 'Rojo desde', min: 60, max: 1440, step: 30, colorsOnly: true },
];
const state = {
  ready: false,
  origin: null,
  dest: null,
  picking: true,
  version: 0,
  params: { ...DEFAULTS, ...loadParams() },
};

function loadParams() {
  try { return JSON.parse(localStorage.getItem('qtl-params')) ?? {}; } catch { return {}; }
}
function saveParams() {
  try { localStorage.setItem('qtl-params', JSON.stringify(state.params)); } catch { /* sin almacenamiento */ }
}

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

// ---------- Mapa ----------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-68, -33],
  zoom: 3.4,
  attributionControl: {
    compact: true,
    customAttribution: 'Caminos: <a href="https://www.naturalearthdata.com/">Natural Earth</a> · Vuelos: <a href="https://github.com/Jonty/airline-route-data">airline-route-data</a>',
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

const pin = (cls) => {
  const el = document.createElement('div');
  el.className = `pin ${cls}`;
  return el;
};
const originMarker = new maplibregl.Marker({ element: pin('pin-origin'), draggable: true, anchor: 'bottom' });
const destMarker = new maplibregl.Marker({ element: pin('pin-dest'), anchor: 'bottom' });
originMarker.on('dragend', () => {
  const { lng, lat } = originMarker.getLngLat();
  setOrigin(lat, lng);
});

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
let computeTimer = null;
async function recompute() {
  if (!state.ready || !state.origin) return;
  setStatus('Calculando…');
  const { lat, lon } = state.origin;
  const res = await call('compute', { lat, lon, params: state.params });
  await mapLoaded;
  refreshTiles();
  setStatus(`Calculado en ${res.ms} ms`, 1500);
  if (state.dest) showTrip();
}
function scheduleRecompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(recompute, 200);
}
function refreshTiles() {
  state.version++;
  map.getSource('heat').setTiles([`heat://{z}/{x}/{y}?v=${state.version}`]);
  map.setLayoutProperty('heat', 'visibility', 'visible');
}

function setOrigin(lat, lon, { fly = false } = {}) {
  state.origin = { lat, lon };
  state.picking = false;
  originMarker.setLngLat([lon, lat]).addTo(map);
  if (fly) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 4.5) });
  name($('origin-name'), lat, lon);
  syncUI();
  writeHash();
  recompute();
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

let tripToken = 0;
async function showTrip() {
  if (!state.dest || !state.origin) return;
  const token = ++tripToken;
  const { lat, lon } = state.dest;
  const trip = await call('trip', { lat, lon });
  if (token !== tripToken) return;
  const card = $('trip');
  card.hidden = false;
  if (!trip) {
    card.innerHTML = `<div class="trip-head"><div><span class="label">Destino</span><strong id="dest-name">…</strong></div>
      <button class="icon-btn" id="close-trip" aria-label="Cerrar">×</button></div>
      <p class="muted">No hay forma de llegar con caminos ni vuelos regulares (por ejemplo, en el mar o en una isla sin aeropuerto).</p>`;
  } else {
    const swatch = colorAt(trip.total, state.params.redFrom);
    card.innerHTML = `
      <div class="trip-head">
        <div><span class="label">Destino</span><strong id="dest-name">…</strong></div>
        <button class="icon-btn" id="close-trip" aria-label="Cerrar">×</button>
      </div>
      <div class="total"><span class="swatch" style="background: rgb(${swatch})"></span><span>${fmt(trip.total)}</span></div>
      <div class="timeline">${trip.legs.map((l) => `<span class="${LEG[l.kind].cls}" style="flex-grow:${Math.max(l.min, 1)}" title="${esc(fmt(l.min))}"></span>`).join('')}</div>
      <ol class="legs">${trip.legs.map((l, i) => {
        const { title, sub } = legTitle(l, i, trip.legs);
        return `<li><span class="leg-icon ${LEG[l.kind].cls}" aria-hidden="true">${LEG[l.kind].icon}</span>
          <span class="leg-text"><strong>${esc(title)}</strong><small>${esc(sub)}</small></span>
          <span class="leg-time">${fmt(l.min)}</span></li>`;
      }).join('')}</ol>
      <button class="link-btn" id="use-as-origin">Usar este punto como origen</button>`;
    $('use-as-origin').onclick = () => { const d = state.dest; clearDest(); setOrigin(d.lat, d.lon); };
  }
  $('close-trip').onclick = clearDest;
  name($('dest-name'), lat, lon);
  drawTrip(trip);
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

function drawTrip(trip) {
  const features = (trip?.legs ?? []).filter((l) => l.path).map((l) => ({
    type: 'Feature',
    properties: { kind: l.kind === 'flight' ? 'flight' : 'drive' },
    geometry: { type: 'LineString', coordinates: l.kind === 'flight' ? greatCircle(l.path[0], l.path[1]) : l.path.map((p) => [p.lon, p.lat]) },
  }));
  map.getSource('trip')?.setData({ type: 'FeatureCollection', features });
}

// ---------- Nombres de lugares ----------
const names = new Map();
async function name(el, lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  el.textContent = names.get(key) ?? `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  if (names.has(key)) return;
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=1`);
    const p = (await res.json()).features?.[0]?.properties;
    if (!p) return;
    names.set(key, placeLabel(p));
    if (el.isConnected) el.textContent = names.get(key);
  } catch { /* se queda con las coordenadas */ }
}
function placeLabel(p) {
  const main = p.city || p.name || p.county || p.state;
  const rest = [p.city && p.name !== p.city ? null : p.state, p.country].filter((x) => x && x !== main);
  return [main, ...rest].filter(Boolean).join(', ');
}

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
        if (state.picking || !state.origin) setOrigin(lat, lon, { fly: true });
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
  if (state.picking || !state.origin) setOrigin(lat, lng);
  else setDest(lat, lng);
});

let hoverPending = false, hoverEvent = null;
map.on('mousemove', (e) => {
  hoverEvent = e;
  if (hoverPending || !state.origin || state.picking) return;
  hoverPending = true;
  requestAnimationFrame(async () => {
    const ev = hoverEvent;
    const { lat, lng } = ev.lngLat.wrap();
    const t = await call('probe', { lat, lon: lng });
    hoverPending = false;
    const tip = $('tooltip');
    if (t === null) { tip.hidden = true; return; }
    tip.textContent = fmt(t);
    tip.style.transform = `translate(${ev.point.x + 14}px, ${ev.point.y + 14}px)`;
    tip.hidden = false;
  });
});
map.getCanvas().addEventListener('mouseleave', () => { $('tooltip').hidden = true; });

// ---------- Interfaz ----------
function syncUI() {
  const hasOrigin = !!state.origin;
  $('origin-row').hidden = !hasOrigin || state.picking;
  $('legend').hidden = !hasOrigin;
  $('hint').hidden = hasOrigin && !state.picking;
  $('hint').textContent = hasOrigin
    ? 'Toca el mapa o busca el nuevo punto de partida.'
    : 'Toca el mapa o busca un lugar para elegir tu punto de partida.';
  $('q').placeholder = state.picking || !hasOrigin ? 'Buscar punto de partida…' : 'Buscar destino…';
  $('cancel-pick').hidden = !(hasOrigin && state.picking);
  document.body.classList.toggle('picking', state.picking);
  drawLegend();
}

$('change-origin').onclick = () => { state.picking = true; syncUI(); $('q').focus(); };
$('cancel-pick').onclick = () => { state.picking = false; syncUI(); };

function drawLegend() {
  const red = state.params.redFrom;
  const max = red * 4;
  const stops = Array.from({ length: 25 }, (_, i) => `rgb(${colorAt((max * i) / 24, red)}) ${(i / 24) * 100}%`);
  $('legend-bar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  const ticks = [0, red, red * 2, red * 3, max];
  $('legend-ticks').innerHTML = ticks.map((t) =>
    `<span style="left:${(t / max) * 100}%">${t === 0 ? '0' : fmt(t).replace(' 0 min', '')}${t === max ? '+' : ''}</span>`).join('');
  $('legend-red').textContent = fmt(red);
  $('legend-lines').textContent = `${CONTOURS.slice(0, 6).join(', ')}, ${CONTOURS.slice(6, 9).join(', ')}… h`;
}

function buildSettings() {
  $('settings-body').innerHTML = SETTINGS.map((s) => `
    <label class="setting">
      <span class="setting-head"><span>${s.label}</span><output id="out-${s.key}"></output></span>
      <input type="range" id="in-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}">
    </label>`).join('') + '<button class="link-btn" id="reset">Restaurar valores</button>';
  for (const s of SETTINGS) {
    const input = $(`in-${s.key}`), out = $(`out-${s.key}`);
    input.value = state.params[s.key];
    out.textContent = fmt(state.params[s.key]);
    input.addEventListener('input', () => {
      state.params[s.key] = +input.value;
      out.textContent = fmt(+input.value);
      saveParams();
      if (s.colorsOnly) {
        drawLegend();
        if (state.origin && state.ready) call('colors', { redFrom: +input.value }).then(refreshTiles);
        if (state.dest) showTrip();
      } else scheduleRecompute();
    });
  }
  $('reset').onclick = () => {
    state.params = { ...DEFAULTS };
    saveParams();
    buildSettings();
    drawLegend();
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
function writeHash() {
  const parts = [];
  if (state.origin) parts.push(`o=${state.origin.lat.toFixed(4)},${state.origin.lon.toFixed(4)}`);
  if (state.dest) parts.push(`d=${state.dest.lat.toFixed(4)},${state.dest.lon.toFixed(4)}`);
  history.replaceState(null, '', parts.length ? `#${parts.join('&')}` : location.pathname);
}
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const pt = (k) => {
    const v = params.get(k)?.split(',').map(Number);
    return v?.length === 2 && v.every(Number.isFinite) ? { lat: v[0], lon: v[1] } : null;
  };
  return { origin: pt('o'), dest: pt('d') };
}

function applyHash() {
  const { origin, dest } = readHash();
  if (!origin) return;
  map.jumpTo({ center: [origin.lon, origin.lat], zoom: Math.max(map.getZoom(), 4) });
  if (dest) { state.dest = dest; destMarker.setLngLat([dest.lon, dest.lat]).addTo(map); }
  else clearDest();
  setOrigin(origin.lat, origin.lon);
}

// ---------- Inicio ----------
buildSettings();
syncUI();
setStatus('Cargando caminos y vuelos del mundo…');
call('init').then(async ({ airports, routes }) => {
  state.ready = true;
  $('data-stats').textContent = `${airports.toLocaleString('es-CL')} aeropuertos y ${routes.toLocaleString('es-CL')} rutas aéreas.`;
  setStatus('');
  applyHash();
  window.addEventListener('hashchange', applyHash);
}).catch((err) => {
  console.error(err);
  setStatus('No se pudieron cargar los datos. Recarga la página.');
});
