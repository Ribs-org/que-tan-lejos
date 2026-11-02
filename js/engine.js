// Motor de tiempos. Sin dependencias del navegador: lo usan el worker y las pruebas en Node.
//
// Todo el viaje es un solo grafo:
//   suelo (caminos + aeropuertos) ── check-in ──> embarque ── vuelo ──> llegada
//   llegada ── salida ──> suelo     llegada ── escala ──> embarque
// Un Dijkstra desde el origen da el mejor tiempo a cada nodo, y un barrido sobre
// una grilla mundial lleva ese tiempo a los lugares sin carretera.

export const GRID = { W: 3600, H: 1350, top: 75, left: -180, step: 0.1 };

export const DEFAULTS = {
  checkin: 90,        // llegar antes del vuelo: seguridad, embarque
  exit: 30,           // bajar del avión y salir del aeropuerto
  connection: 120,    // entre un vuelo y el siguiente
  international: 60,  // extra por migración en vuelos entre países
  redFrom: 240,       // minutos en que el mapa se vuelve rojo
};

const OFFROAD_MIN_PER_KM = 2;   // 30 km/h en línea recta: red local no modelada
const MAX_ACCESS_KM = 300;

const RAD = Math.PI / 180;
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function parseRoads(buffer) {
  const [R, A, M] = new Int32Array(buffer, 0, 3);
  const G = R + A;
  let at = 12;
  const take = (Type, n) => {
    const a = new Type(buffer, at, n);
    at += n * Type.BYTES_PER_ELEMENT;
    return a;
  };
  return { R, A, G, M, lat: take(Float32Array, G), lon: take(Float32Array, G),
    offs: take(Int32Array, G + 1), to: take(Int32Array, M), min: take(Float32Array, M) };
}

export function parseLand(buffer) {
  const runs = new Uint32Array(buffer);
  const land = new Uint8Array(GRID.W * GRID.H);
  let at = 0;
  runs.forEach((n, i) => {
    if (i % 2) land.fill(1, at, at + n);
    at += n;
  });
  return land;
}

// Cola de prioridad binaria con entradas duplicadas en vez de decrease-key
class Heap {
  constructor(capacity) {
    this.keys = new Float64Array(capacity);
    this.ids = new Int32Array(capacity);
    this.size = 0;
  }
  push(key, id) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2), v = new Int32Array(this.size * 2);
      k.set(this.keys); v.set(this.ids);
      this.keys = k; this.ids = v;
    }
    const { keys, ids } = this;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p]; ids[i] = ids[p];
      i = p;
    }
    keys[i] = key; ids[i] = id;
  }
  pop() {
    const { keys, ids } = this;
    const top = ids[0];
    this.topKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n], id = ids[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c]; ids[i] = ids[c];
        i = c;
      }
      keys[i] = key; ids[i] = id;
    }
    return top;
  }
}

export class Engine {
  constructor(roads, flights, land) {
    Object.assign(this, { roads, flights, land });
    const { G, A } = roads;
    this.N = G + 2 * A + 1;           // suelo, embarque, llegada, origen
    this.ORIGIN = this.N - 1;
    this.dist = new Float64Array(this.N);
    this.prev = new Int32Array(this.N);
    this.heap = new Heap(1 << 20);
    this.field = new Float32Array(GRID.W * GRID.H);
    this.owner = new Int32Array(GRID.W * GRID.H);
    this.origin = null;
    this.intl = Uint8Array.from(flights.to, () => 0);
    flights.airports.forEach((a, i) => {
      for (let e = flights.offs[i]; e < flights.offs[i + 1]; e++) {
        this.intl[e] = flights.airports[flights.to[e]][4] !== a[4] ? 1 : 0;
      }
    });
    this.kmX = Float32Array.from({ length: GRID.H }, (_, r) =>
      Math.max(0.5, 111.32 * GRID.step * Math.cos((GRID.top - (r + 0.5) * GRID.step) * RAD)));
    this.buildIndex();
    this.buildFriction();
  }

  // Índice de nodos de suelo en celdas de medio grado
  buildIndex() {
    const { G, lat, lon } = this.roads;
    this.index = new Map();
    for (let i = 0; i < G; i++) {
      const k = this.bucket(lat[i], lon[i]);
      const list = this.index.get(k);
      if (list) list.push(i);
      else this.index.set(k, [i]);
    }
  }
  bucket(lat, lon) { return Math.floor((lat + 90) * 2) * 1000 + Math.floor((lon + 180) * 2); }

  nearNodes(lat, lon, km) {
    const { lat: nLat, lon: nLon } = this.roads;
    const res = [];
    const dA = Math.ceil(km / 55), dO = Math.ceil(km / (55 * Math.max(0.05, Math.cos(lat * RAD))));
    const a0 = Math.floor((lat + 90) * 2), o0 = Math.floor((lon + 180) * 2);
    for (let a = a0 - dA; a <= a0 + dA; a++) {
      for (let o = o0 - dO; o <= o0 + dO; o++) {
        const list = this.index.get(a * 1000 + ((o + 720) % 720));
        if (!list) continue;
        for (const i of list) {
          const d = haversine(lat, lon, nLat[i], nLon[i]);
          if (d <= km) res.push([i, d]);
        }
      }
    }
    return res.sort((x, y) => x[1] - y[1]);
  }

  cellOf(lat, lon) {
    const r = Math.floor((GRID.top - lat) / GRID.step), c = Math.floor((lon - GRID.left) / GRID.step);
    if (r < 0 || r >= GRID.H) return -1;
    return r * GRID.W + ((c % GRID.W) + GRID.W) % GRID.W;
  }

  // Minutos por km fuera de la red: suben con la distancia al camino más cercano
  buildFriction() {
    const { W, H } = GRID;
    const d = new Float32Array(W * H).fill(Infinity);
    const { G, lat, lon } = this.roads;
    for (let i = 0; i < G; i++) {
      const c = this.cellOf(lat[i], lon[i]);
      if (c >= 0) d[c] = 0;
    }
    const ky = 11.132;
    const pass = (dir) => {
      for (let r = dir > 0 ? 0 : H - 1; r >= 0 && r < H; r += dir) {
        const kx = this.kmX[r];
        for (let x = dir > 0 ? 0 : W - 1; x >= 0 && x < W; x += dir) {
          const c = r * W + x;
          let v = d[c];
          const w = x - dir >= 0 && x - dir < W ? d[c - dir] + kx : Infinity;
          if (w < v) v = w;
          const rr = r - dir;
          if (rr >= 0 && rr < H) { const n = d[c - dir * W] + ky; if (n < v) v = n; }
          d[c] = v;
        }
      }
    };
    pass(1); pass(-1);
    this.friction = new Float32Array(W * H);
    for (let c = 0; c < W * H; c++) {
      this.friction[c] = OFFROAD_MIN_PER_KM + Math.min(8, Math.max(0, (d[c] - 40) / 15));
    }
  }

  // Punto arbitrario -> nodos cercanos de la red
  access(lat, lon) {
    let near = this.nearNodes(lat, lon, 40).slice(0, 12);
    if (!near.length) near = this.nearNodes(lat, lon, MAX_ACCESS_KM).slice(0, 4);
    return near;
  }

  dijkstra(lat, lon, p) {
    const { roads, flights, dist, prev, heap, ORIGIN, intl } = this;
    const { G, A, offs, to, min } = roads;
    const DEP = G, ARR = G + A;
    dist.fill(Infinity);
    prev.fill(-1);
    heap.size = 0;
    dist[ORIGIN] = 0;
    for (const [n, km] of this.access(lat, lon)) {
      dist[n] = km * OFFROAD_MIN_PER_KM;
      prev[n] = ORIGIN;
      heap.push(dist[n], n);
    }
    const relax = (v, d, u) => {
      if (d < dist[v]) { dist[v] = d; prev[v] = u; heap.push(d, v); }
    };
    const fOffs = flights.offs, fTo = flights.to, fMin = flights.mins;
    const R = roads.R;
    while (heap.size) {
      const u = heap.pop();
      const d = heap.topKey;
      if (d > dist[u]) continue;
      if (u < G) {
        for (let e = offs[u]; e < offs[u + 1]; e++) relax(to[e], d + min[e], u);
        if (u >= R) relax(DEP + (u - R), d + p.checkin, u);
      } else if (u < ARR) {
        const a = u - DEP;
        for (let e = fOffs[a]; e < fOffs[a + 1]; e++) {
          relax(ARR + fTo[e], d + fMin[e] + (intl[e] ? p.international : 0), u);
        }
      } else if (u !== ORIGIN) {
        const a = u - ARR;
        relax(R + a, d + p.exit, u);
        relax(DEP + a, d + p.connection, u);
      }
    }
  }

  // Lleva los tiempos de la red a toda la grilla; el agua no se cruza
  sweep() {
    const { W, H } = GRID;
    const { field, owner, land, friction, kmX } = this;
    const { G, lat, lon } = this.roads;
    const { dist } = this;
    field.fill(Infinity);
    owner.fill(-1);
    for (let i = 0; i < G; i++) {
      if (dist[i] === Infinity) continue;
      const c = this.cellOf(lat[i], lon[i]);
      if (c >= 0 && dist[i] < field[c]) { field[c] = dist[i]; owner[c] = i; }
    }
    const ky = 11.132;
    for (let round = 0; round < 2; round++) {
      for (let dir = 1; dir >= -1; dir -= 2) {
        for (let r = dir > 0 ? 0 : H - 1; r >= 0 && r < H; r += dir) {
          const kx = kmX[r], kd = Math.hypot(kx, ky);
          const hasRow = r - dir >= 0 && r - dir < H;
          for (let x = dir > 0 ? 0 : W - 1; x >= 0 && x < W; x += dir) {
            const c = r * W + x;
            if (!land[c]) continue;
            const f = friction[c];
            let best = field[c], own = -1;
            const side = (x - dir + W) % W;
            const rowStart = r * W;
            let v = field[rowStart + side] + kx * f;
            if (v < best) { best = v; own = rowStart + side; }
            if (hasRow) {
              const up = (r - dir) * W;
              v = field[up + x] + ky * f;
              if (v < best) { best = v; own = up + x; }
              v = field[up + side] + kd * f;
              if (v < best) { best = v; own = up + side; }
              const other = (x + dir + W) % W;
              v = field[up + other] + kd * f;
              if (v < best) { best = v; own = up + other; }
            }
            if (own >= 0) { field[c] = best; owner[c] = owner[own]; }
          }
        }
      }
    }
  }

  compute(lat, lon, params) {
    const p = { ...DEFAULTS, ...params };
    this.origin = { lat, lon };
    this.params = p;
    this.dijkstra(lat, lon, p);
    this.sweep();
  }

  // Tiempo en un punto: interpola la grilla ignorando celdas sin dato
  sample(lat, lon) {
    if (lat > GRID.top - GRID.step / 2 || lat < GRID.top - GRID.H * GRID.step + GRID.step / 2) return Infinity;
    const fy = (GRID.top - lat) / GRID.step - 0.5;
    const fx = (lon - GRID.left) / GRID.step - 0.5;
    const r0 = Math.floor(fy), x0 = Math.floor(fx);
    const ty = fy - r0, tx = fx - x0;
    const { W } = GRID, { field } = this;
    const a = (x0 + W) % W, b = (x0 + 1 + W) % W;
    const c00 = field[r0 * W + a], c10 = field[r0 * W + b];
    const c01 = field[(r0 + 1) * W + a], c11 = field[(r0 + 1) * W + b];
    let sum = 0, weight = 0;
    const add = (v, w) => { if (v !== Infinity) { sum += v * w; weight += w; } };
    add(c00, (1 - tx) * (1 - ty)); add(c10, tx * (1 - ty));
    add(c01, (1 - tx) * ty); add(c11, tx * ty);
    if (weight < 0.15) return Infinity;
    const t = sum / weight;
    const direct = this.directMinutes(lat, lon);
    return direct < t ? direct : t;
  }

  directMinutes(lat, lon) {
    const { origin } = this;
    const dLat = (lat - origin.lat) * 111.32;
    const dLon = (lon - origin.lon) * 111.32 * Math.cos(origin.lat * RAD);
    if (Math.abs(dLat) > 60 || Math.abs(dLon) > 60) return Infinity;
    return Math.hypot(dLat, dLon) * OFFROAD_MIN_PER_KM;
  }

  // Desglose del mejor viaje hasta un punto
  trip(lat, lon) {
    const total = this.sample(lat, lon);
    if (total === Infinity) return null;
    const { roads, flights, dist, prev, ORIGIN, params: p } = this;
    const { R, G, A } = roads;
    const DEP = G, ARR = G + A;
    const here = { lat, lon };
    const originPt = this.origin;

    if (total === this.directMinutes(lat, lon)) {
      return { total, legs: [{ kind: 'drive', min: total, km: haversine(originPt.lat, originPt.lon, lat, lon), path: [originPt, here] }] };
    }

    let end = this.ownerNear(lat, lon);
    if (end < 0) return null;
    const chain = [];
    for (let n = end; n !== -1 && n !== ORIGIN; n = prev[n]) chain.push(n);
    chain.reverse();

    const point = (n) => {
      const g = n < G ? n : R + ((n - G) % A);
      return { lat: roads.lat[g], lon: roads.lon[g] };
    };
    const airport = (n) => {
      const a = flights.airports[n < G ? n - R : (n - G) % A];
      return { iata: a[0], name: a[1], city: a[2], country: a[3] };
    };

    const legs = [];
    let drive = null;
    const startDrive = (pt, t) => { drive = { kind: 'drive', min: 0, km: 0, path: [pt], from: t }; };
    const endDrive = (pt, t) => {
      if (!drive) return;
      drive.path.push(pt);
      drive.min = t - drive.from;
      for (let i = 1; i < drive.path.length; i++) {
        const a = drive.path[i - 1], b = drive.path[i];
        drive.km += haversine(a.lat, a.lon, b.lat, b.lon);
      }
      delete drive.from;
      if (drive.min >= 0.5) legs.push(drive);
      drive = null;
    };

    startDrive(originPt, 0);
    for (let i = 0; i < chain.length; i++) {
      const n = chain[i];
      if (n < G) {
        if (drive) drive.path.push(point(n));
        else startDrive(point(n), dist[n]);
        continue;
      }
      const before = chain[i - 1];
      if (n < ARR && before < G) {
        endDrive(point(before), dist[before]);
        legs.push({ kind: 'checkin', min: p.checkin, airport: airport(n) });
      } else if (n < ARR) {
        legs.push({ kind: 'connection', min: p.connection, airport: airport(n) });
      } else {
        const from = before - DEP, b = n - ARR;
        let e = flights.offs[from];
        while (flights.to[e] !== b) e++;
        const extra = this.intl[e] ? p.international : 0;
        if (extra) legs.push({ kind: 'border', min: extra, airport: airport(before) });
        legs.push({ kind: 'flight', min: flights.mins[e], km: flights.kms[e],
          from: airport(before), to: airport(n), carriers: flights.cars[e].map((c) => flights.carriers[c]),
          path: [point(before), point(n)] });
        const next = chain[i + 1];
        if (next === undefined || next < G) legs.push({ kind: 'exit', min: p.exit, airport: airport(n) });
      }
    }
    endDrive(here, total);
    if (!legs.some((l) => l.kind === 'flight') && !legs.length) {
      legs.push({ kind: 'drive', min: total, km: 0, path: [originPt, here] });
    }
    return { total, legs };
  }

  // Dueño de la celda del punto, o de la celda vecina con dato (costas)
  ownerNear(lat, lon) {
    const { W } = GRID;
    const c = this.cellOf(lat, lon);
    if (c < 0) return -1;
    let best = -1, bestT = Infinity;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dx = -2; dx <= 2; dx++) {
        const n = c + dr * W + dx;
        if (n < 0 || n >= this.field.length || this.owner[n] < 0) continue;
        if (this.field[n] < bestT) { bestT = this.field[n]; best = this.owner[n]; }
      }
    }
    return best;
  }
}
