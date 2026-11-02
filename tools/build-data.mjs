// Convierte los datasets crudos en los archivos compactos de data/.
// Uso: node tools/build-data.mjs <carpeta con routes.json, roads.geojson, land.geojson>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { GRID, haversine } from '../js/engine.js';

const src = process.argv[2];
const out = new URL('../data/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));

// km/h promedio por tipo, calibrado contra OSRM con tools/validate.mjs --osrm.
// Fuera de América y Europa casi todo viene como "Unknown", incluidas autopistas.
const SPEED = {
  'Major Highway': 85, Beltway: 70, Bypass: 70, 'Secondary Highway': 65,
  Road: 55, Track: 30, Unknown: 75, 'Ferry Route': 25, 'Ferry, seasonal': 25,
};
const SNAP = 0.02;      // celda del índice de fusión, en grados
const SNAP_KM = 1.5;    // vértices más cercanos que esto se funden
const STITCH_KM = 8;    // extremos sueltos se pegan al vecino más cercano
const BRIDGE_KM = 30;   // …o a otro componente, si el hueco es por tierra
const SPACING_KM = 12;  // distancia máxima entre nodos del grafo final
const FERRY_BOARDING = 30;
const ACCESS_KM = 30;   // radio para conectar un aeropuerto con la red vial
const ACCESS_MIN_PER_KM = 2;

// ---------- Red vial ----------
const roads = read('roads.geojson');
// Fusión por radio, no por redondeo: dos puntos a 1 km pueden caer en celdas distintas
const snapCells = new Map();
const vLat = [], vLon = [], adj = [];
const vertex = (lon, lat) => {
  const cy = Math.floor(lat / SNAP), cx = Math.floor(lon / SNAP);
  let best = -1, bestD = SNAP_KM;
  for (let a = cy - 1; a <= cy + 1; a++) {
    for (let o = cx - 1; o <= cx + 1; o++) {
      for (const j of snapCells.get(`${a},${o}`) ?? []) {
        const d = haversine(lat, lon, vLat[j], vLon[j]);
        if (d < bestD) { bestD = d; best = j; }
      }
    }
  }
  if (best >= 0) return best;
  const id = vLat.length;
  const key = `${cy},${cx}`;
  if (!snapCells.has(key)) snapCells.set(key, []);
  snapCells.get(key).push(id);
  vLat.push(lat); vLon.push(lon); adj.push([]);
  return id;
};
const link = (a, b, km, min) => {
  if (a === b) return;
  adj[a].push({ to: b, km, min });
  adj[b].push({ to: a, km, min });
};

for (const f of roads.features) {
  const g = f.geometry;
  if (!g) continue;
  const speed = f.properties.expressway ? 95 : SPEED[f.properties.type] ?? 60;
  const ferry = f.properties.type.startsWith('Ferry');
  const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
  for (const line of lines) {
    let prev = null, prevC = null, boarding = ferry ? FERRY_BOARDING : 0;
    for (const c of line) {
      const v = vertex(c[0], c[1]);
      if (prev !== null && v !== prev) {
        const km = haversine(prevC[1], prevC[0], c[1], c[0]);
        link(prev, v, km, (km / speed) * 60 + boarding);
        boarding = 0;
      }
      prev = v; prevC = c;
    }
  }
}
console.log('vértices', vLat.length);

// Índice espacial simple para búsquedas por radio
const BUCKET = 0.25;
const bucketKey = (lat, lon) => `${Math.floor(lat / BUCKET)},${Math.floor(lon / BUCKET)}`;
const buckets = new Map();
for (let i = 0; i < vLat.length; i++) {
  const k = bucketKey(vLat[i], vLon[i]);
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(i);
}
function nearby(lat, lon, km) {
  const res = [];
  const dLat = Math.ceil(km / 111 / BUCKET);
  const dLon = Math.ceil(km / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180))) / BUCKET);
  const bl = Math.floor(lat / BUCKET), bo = Math.floor(lon / BUCKET);
  for (let a = bl - dLat; a <= bl + dLat; a++) {
    for (let o = bo - dLon; o <= bo + dLon; o++) {
      const list = buckets.get(`${a},${o}`);
      if (!list) continue;
      for (const i of list) {
        const d = haversine(lat, lon, vLat[i], vLon[i]);
        if (d <= km) res.push([i, d]);
      }
    }
  }
  return res.sort((x, y) => x[1] - y[1]);
}

// Extremos sueltos: casi siempre son cruces en T que no comparten vértice
let stitched = 0;
for (let i = 0; i < vLat.length; i++) {
  if (adj[i].length !== 1) continue;
  const neighbours = new Set([i, adj[i][0].to]);
  for (const [j, d] of nearby(vLat[i], vLon[i], STITCH_KM)) {
    if (neighbours.has(j)) continue;
    link(i, j, d, (d / 40) * 60);
    stitched++;
    break;
  }
}
console.log('empalmes', stitched);

// Huecos del dataset (p. ej. la Ruta 5 entre Loncoche y Lanco): se une cada extremo
// suelto al componente distinto más cercano, solo si el tramo va por tierra
const coverage = rasterizeLand(read('land.geojson'));
const onLand = (lat1, lon1, lat2, lon2) => {
  const steps = Math.ceil(haversine(lat1, lon1, lat2, lon2) / 2);
  for (let s = 0; s <= steps; s++) {
    const la = lat1 + ((lat2 - lat1) * s) / steps, lo = lon1 + ((lon2 - lon1) * s) / steps;
    const r = Math.floor((GRID.top - la) / GRID.step), c = Math.floor((lo - GRID.left) / GRID.step);
    if (r < 0 || r >= GRID.H || !coverage[r * GRID.W + ((c + GRID.W) % GRID.W)]) return false;
  }
  return true;
};
const parent = Int32Array.from({ length: vLat.length }, (_, i) => i);
const findRoot = (i) => {
  while (parent[i] !== i) i = parent[i] = parent[parent[i]];
  return i;
};
for (let i = 0; i < vLat.length; i++) for (const e of adj[i]) parent[findRoot(i)] = findRoot(e.to);
let bridged = 0;
for (let i = 0; i < vLat.length; i++) {
  if (adj[i].length !== 1) continue;
  for (const [j, d] of nearby(vLat[i], vLon[i], BRIDGE_KM)) {
    if (findRoot(j) === findRoot(i)) continue;
    if (!onLand(vLat[i], vLon[i], vLat[j], vLon[j])) continue;
    link(i, j, d, (d / 50) * 60);
    parent[findRoot(i)] = findRoot(j);
    bridged++;
    break;
  }
}
console.log('puentes entre componentes', bridged);

// Contracción: se conservan cruces y un nodo cada SPACING_KM
const keep = new Uint8Array(vLat.length);
for (let i = 0; i < vLat.length; i++) if (adj[i].length !== 2) keep[i] = 1;
const next = (v, from) => (adj[v][0].to === from ? adj[v][1] : adj[v][0]);
for (let i = 0; i < vLat.length; i++) {
  if (!keep[i]) continue;
  for (const e of adj[i]) {
    let prev = i, cur = e.to, km = e.km;
    while (!keep[cur]) {
      if (km >= SPACING_KM) { keep[cur] = 1; break; }
      const n = next(cur, prev);
      km += n.km; prev = cur; cur = n.to;
    }
  }
}
// Anillos sin cruces: lo que no se alcanza caminando desde un nodo conservado
const seen = new Uint8Array(vLat.length);
for (let i = 0; i < vLat.length; i++) {
  if (!keep[i]) continue;
  for (const e of adj[i]) {
    let prev = i, cur = e.to;
    while (!keep[cur]) {
      seen[cur] = 1;
      const n = next(cur, prev);
      prev = cur; cur = n.to;
    }
  }
}
for (let i = 0; i < vLat.length; i++) {
  if (keep[i] || seen[i]) continue;
  let prev = -1, cur = i, km = 0, ringKept = false;
  const ring = [];
  while (!seen[cur] && !keep[cur]) {
    seen[cur] = 1; ring.push(cur);
    const n = prev < 0 ? adj[cur][0] : next(cur, prev);
    km += n.km; prev = cur; cur = n.to;
    if (km >= SPACING_KM) { keep[cur] = 1; km = 0; ringKept = true; }
  }
  if (!ringKept) keep[i] = 1;
}

const newId = new Int32Array(vLat.length).fill(-1);
const nLat = [], nLon = [];
for (let i = 0; i < vLat.length; i++) {
  if (keep[i]) { newId[i] = nLat.length; nLat.push(vLat[i]); nLon.push(vLon[i]); }
}
const edges = new Map();
const putEdge = (a, b, km, min) => {
  if (a === b) return;
  const k = a < b ? `${a},${b}` : `${b},${a}`;
  const cur = edges.get(k);
  if (!cur || min < cur.min) edges.set(k, { a, b, km, min });
};
for (let i = 0; i < vLat.length; i++) {
  if (!keep[i]) continue;
  for (const e of adj[i]) {
    let prev = i, cur = e.to, km = e.km, min = e.min;
    while (!keep[cur]) {
      const n = next(cur, prev);
      km += n.km; min += n.min; prev = cur; cur = n.to;
    }
    putEdge(newId[i], newId[cur], km, min);
  }
}
const R = nLat.length;
console.log('nodos viales', R, 'aristas', edges.size);

// ---------- Aeropuertos y vuelos ----------
const routes = read('routes.json');
const codes = Object.keys(routes)
  .filter((c) => {
    const a = routes[c];
    return (a.routes || []).length && Number.isFinite(+a.latitude) && Number.isFinite(+a.longitude);
  })
  .sort();
const airportIdx = new Map(codes.map((c, i) => [c, i]));
const carrierIdx = new Map();
const carriers = [];
const carrierId = (name) => {
  if (!carrierIdx.has(name)) { carrierIdx.set(name, carriers.length); carriers.push(name); }
  return carrierIdx.get(name);
};
const airports = [], offs = [0], to = [], mins = [], kms = [], cars = [];
for (const c of codes) {
  const a = routes[c];
  airports.push([c, a.name, a.city_name, a.country, a.country_code, +(+a.latitude).toFixed(4), +(+a.longitude).toFixed(4)]);
  for (const r of a.routes) {
    const b = airportIdx.get(r.iata);
    if (b === undefined || !r.km) continue;
    to.push(b);
    mins.push(r.min > 0 ? r.min : Math.round(30 + (r.km / 800) * 60));
    kms.push(r.km);
    cars.push(r.carriers.slice(0, 3).map((x) => carrierId(x.name)));
  }
  offs.push(to.length);
}
const A = airports.length;
console.log('aeropuertos', A, 'rutas', to.length);

// Índice de nodos viales finales para conectar aeropuertos
buckets.clear();
const idx = new Map();
for (let i = 0; i < R; i++) {
  const k = bucketKey(nLat[i], nLon[i]);
  if (!idx.has(k)) idx.set(k, []);
  idx.get(k).push(i);
}
function nearbyRoad(lat, lon, km) {
  const res = [];
  const dLat = Math.ceil(km / 111 / BUCKET);
  const dLon = Math.ceil(km / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180))) / BUCKET);
  const bl = Math.floor(lat / BUCKET), bo = Math.floor(lon / BUCKET);
  for (let a = bl - dLat; a <= bl + dLat; a++) {
    for (let o = bo - dLon; o <= bo + dLon; o++) {
      for (const i of idx.get(`${a},${o}`) ?? []) {
        const d = haversine(lat, lon, nLat[i], nLon[i]);
        if (d <= km) res.push([i, d]);
      }
    }
  }
  return res.sort((x, y) => x[1] - y[1]);
}
let isolated = 0;
airports.forEach((a, i) => {
  const g = R + i;
  let near = nearbyRoad(a[5], a[6], ACCESS_KM).slice(0, 5);
  if (!near.length) near = nearbyRoad(a[5], a[6], 80).slice(0, 1);
  if (!near.length) isolated++;
  for (const [n, d] of near) putEdge(g, n, d, d * ACCESS_MIN_PER_KM);
});
console.log('aeropuertos sin camino cercano', isolated);

// ---------- Binario de la red terrestre ----------
const G = R + A;
const allLat = new Float32Array(G), allLon = new Float32Array(G);
allLat.set(nLat); allLon.set(nLon);
airports.forEach((a, i) => { allLat[R + i] = a[5]; allLon[R + i] = a[6]; });

const degree = new Int32Array(G + 1);
for (const e of edges.values()) { degree[e.a + 1]++; degree[e.b + 1]++; }
for (let i = 0; i < G; i++) degree[i + 1] += degree[i];
const M = degree[G];
const eTo = new Int32Array(M), eMin = new Float32Array(M);
const fill = degree.slice();
for (const e of edges.values()) {
  eTo[fill[e.a]] = e.b; eMin[fill[e.a]++] = e.min;
  eTo[fill[e.b]] = e.a; eMin[fill[e.b]++] = e.min;
}
const header = Int32Array.from([R, A, M]);
const roadBin = Buffer.concat([header, allLat, allLon, degree, eTo, eMin].map((a) => Buffer.from(a.buffer)));
fs.writeFileSync(new URL('roads.bin.gz', out), zlib.gzipSync(roadBin, { level: 9 }));
fs.writeFileSync(new URL('flights.json', out), JSON.stringify({ airports, carriers, offs, to, mins, kms, cars }));

// ---------- Máscara de tierra ----------
// Largos de racha alternados (agua, tierra, agua…)
const runs = [];
let run = 0, state = 0;
for (let i = 0; i < coverage.length; i++) {
  const v = coverage[i];
  if (v === state) run++;
  else { runs.push(run); run = 1; state = v; }
}
runs.push(run);
fs.writeFileSync(new URL('land.bin.gz', out), zlib.gzipSync(Buffer.from(Uint32Array.from(runs).buffer), { level: 9 }));

for (const f of fs.readdirSync(out)) console.log(f, (fs.statSync(new URL(f, out)).size / 1e6).toFixed(2), 'MB');

// Celda = tierra si al menos 2 de sus 9 submuestras caen dentro de un polígono
function rasterizeLand(land) {
  const SS = 3;
  const rows = GRID.H * SS, cols = GRID.W * SS;
  const crossings = Array.from({ length: rows }, () => []);
  const ringEdges = (ring) => {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      const r1 = (GRID.top - y1) / GRID.step * SS - 0.5, r2 = (GRID.top - y2) / GRID.step * SS - 0.5;
      if (r1 === r2) continue;
      const lo = Math.max(0, Math.ceil(Math.min(r1, r2))), hi = Math.min(rows - 1, Math.ceil(Math.max(r1, r2)) - 1);
      for (let r = lo; r <= hi; r++) crossings[r].push(x1 + ((r - r1) / (r2 - r1)) * (x2 - x1));
    }
  };
  for (const f of land.features) {
    const g = f.geometry;
    for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) poly.forEach(ringEdges);
  }
  const count = new Uint8Array(GRID.W * GRID.H);
  for (let r = 0; r < rows; r++) {
    const xs = crossings[r].sort((a, b) => a - b);
    const row = Math.floor(r / SS) * GRID.W;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.ceil((xs[i] - GRID.left) / GRID.step * SS - 0.5));
      const c1 = Math.min(cols - 1, Math.floor((xs[i + 1] - GRID.left) / GRID.step * SS - 0.5));
      for (let c = c0; c <= c1; c++) count[row + Math.floor(c / SS)]++;
    }
  }
  return count.map((n) => (n >= 2 ? 1 : 0));
}
