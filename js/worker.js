import { Engine, parseRoads, parseLand } from './engine.js';
import { colorLUT, levelLUT, MAX_MIN } from './colors.js';

const TILE = 256;
let engine = null;
let colors = null;
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
  return { airports: flights.airports.length, routes: flights.to.length };
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
      t[j * side + i] = engine.sample(lat, lon);
    }
  }
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
      px[k] = colors[m * 3] * shade;
      px[k + 1] = colors[m * 3 + 1] * shade;
      px[k + 2] = colors[m * 3 + 2] * shade;
      px[k + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(TILE, TILE);
  canvas.getContext('2d').putImageData(new ImageData(px, TILE, TILE), 0, 0);
  return canvas.transferToImageBitmap();
}

const handlers = {
  init,
  compute({ lat, lon, params }) {
    const t0 = performance.now();
    engine.compute(lat, lon, params);
    colors = colorLUT(engine.params.redFrom);
    return { ms: Math.round(performance.now() - t0) };
  },
  colors({ redFrom }) {
    engine.params.redFrom = redFrom;
    colors = colorLUT(redFrom);
  },
  tile({ z, x, y }) {
    if (!engine?.origin) return null;
    return renderTile(z, x, y);
  },
  probe({ lat, lon }) {
    if (!engine?.origin) return null;
    const t = engine.sample(lat, lon);
    return t === Infinity ? null : t;
  },
  trip({ lat, lon }) {
    if (!engine?.origin) return null;
    return engine.trip(lat, lon);
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
