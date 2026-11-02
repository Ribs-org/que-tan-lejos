import { Engine, parseRoads, parseLand } from './engine.js';
import { colorLUT, levelLUT, MAX_MIN } from './colors.js';

const TILE = 256;
const NO_TRIP = [150, 155, 165];   // gris: no alcanza a ir y volver
let engine = null;
let layers = [];                   // una capa por origen
let pool = [];
let scratch = null;                // capa sin grilla para evaluar candidatos
let colors = null;
let view = { redFrom: 240, window: 0, combine: 'max' };
const levels = levelLUT();

// Algunos servidores ya descomprimen el .gz por su cuenta: se mira la firma
async function loadBinary(name) {
  const buf = await (await fetch(new URL(`../data/${name}`, import.meta.url))).arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

async function init() {
  const [roads, land, flights] = await Promise.all([
    loadBinary('roads.bin.gz'),
    loadBinary('land.bin.gz'),
    fetch(new URL('../data/flights.json', import.meta.url)).then((r) => r.json()),
  ]);
  engine = new Engine(parseRoads(roads), flights, parseLand(land));
  scratch = engine.layer({ field: false });
  return { airports: flights.airports.length, routes: flights.to.length };
}

const combine = (values) => {
  if (values.some((v) => v === null || v === Infinity)) return Infinity;
  return view.combine === 'avg' ? values.reduce((s, v) => s + v, 0) / values.length : Math.max(...values);
};

function combined(lat, lon) {
  if (layers.length === 1) return engine.sample(layers[0], lat, lon);
  let max = 0, sum = 0;
  for (const l of layers) {
    const t = engine.sample(l, lat, lon);
    if (t === Infinity) return Infinity;
    sum += t;
    if (t > max) max = t;
  }
  return view.combine === 'avg' ? sum / layers.length : max;
}

function renderTile(z, x, y) {
  const n = 2 ** z;
  const side = TILE + 1;
  const t = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    const my = (y + (j + 0.5) / TILE) / n;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
    for (let i = 0; i < side; i++) {
      const lon = ((x + (i + 0.5) / TILE) / n) * 360 - 180;
      t[j * side + i] = combined(lat, lon);
    }
  }
  const limit = view.window ? view.window / 2 : Infinity;
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      const v = t[j * side + i];
      if (v === Infinity) continue;
      const m = Math.min(MAX_MIN, v | 0);
      const right = t[j * side + i + 1], down = t[(j + 1) * side + i];
      const lv = levels[m];
      const edge = (right !== Infinity && levels[Math.min(MAX_MIN, right | 0)] !== lv) ||
        (down !== Infinity && levels[Math.min(MAX_MIN, down | 0)] !== lv);
      const k = (j * TILE + i) * 4;
      const shade = edge ? 0.62 : 1;
      const rgb = v >= limit ? NO_TRIP : [colors[m * 3], colors[m * 3 + 1], colors[m * 3 + 2]];
      px[k] = rgb[0] * shade;
      px[k + 1] = rgb[1] * shade;
      px[k + 2] = rgb[2] * shade;
      px[k + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(TILE, TILE);
  canvas.getContext('2d').putImageData(new ImageData(px, TILE, TILE), 0, 0);
  return canvas.transferToImageBitmap();
}

const handlers = {
  init,
  compute({ origins, params }) {
    const t0 = performance.now();
    while (pool.length < origins.length) pool.push(engine.layer());
    layers = origins.map((o, i) => {
      engine.compute(pool[i], o.lat, o.lon, params);
      return pool[i];
    });
    return { ms: Math.round(performance.now() - t0) };
  },
  view(next) {
    if (next.redFrom !== view.redFrom || !colors) colors = colorLUT(next.redFrom);
    view = next;
  },
  tile({ z, x, y }) {
    if (!layers.length) return null;
    return renderTile(z, x, y);
  },
  probe({ lat, lon }) {
    if (!layers.length) return null;
    const t = combined(lat, lon);
    return t === Infinity ? null : t;
  },
  trip({ lat, lon }) {
    if (!layers.length) return null;
    const trips = layers.map((l) => engine.trip(l, lat, lon));
    return { trips, total: combine(trips.map((t) => t?.total ?? null)) };
  },
  // Por candidato y origen: viaje normal (con su detalle) y tiempo con taco
  evaluate({ origins, candidates, params, traffic }) {
    const out = candidates.map(() => origins.map(() => ({ trip: null, taco: Infinity })));
    origins.forEach((o, oi) => {
      engine.compute(scratch, o.lat, o.lon, { ...params, traffic: 1 }, { full: false });
      candidates.forEach((c, ci) => {
        const trip = engine.trip(scratch, c.lat, c.lon);
        out[ci][oi].trip = trip;
        out[ci][oi].taco = trip ? trip.total : Infinity;
      });
      if (traffic > 1) {
        engine.compute(scratch, o.lat, o.lon, { ...params, traffic }, { full: false });
        candidates.forEach((c, ci) => { out[ci][oi].taco = engine.timeAt(scratch, c.lat, c.lon); });
      }
    });
    return out;
  },
};

self.onmessage = async ({ data: { id, type, args } }) => {
  try {
    const result = await handlers[type](args);
    const transfer = result instanceof ImageBitmap ? [result] : [];
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
