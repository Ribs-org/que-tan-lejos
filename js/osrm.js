// Duración real en auto de un tramo, con el servidor público de OSRM (OpenStreetMap).
// Es un servicio de demostración: una consulta por segundo y todo queda en caché.
const KEY = 'qtl-osrm';
const GAP_MS = 1100;

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const known = load();        // clave -> minutos, o null si OSRM no encontró ruta
const queue = [];
const listeners = [];
let busy = false;

const keyOf = (a, b) => `${a.lat.toFixed(4)},${a.lon.toFixed(4)};${b.lat.toFixed(4)},${b.lon.toFixed(4)}`;

export const osrmKnown = (a, b) => known[keyOf(a, b)];
export const onOsrm = (fn) => listeners.push(fn);

export function osrmLeg(a, b) {
  const key = keyOf(a, b);
  if (key in known || queue.includes(key)) return;
  queue.push(key);
  pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const key = queue.shift();
    const [[aLat, aLon], [bLat, bLon]] = key.split(';').map((p) => p.split(','));
    try {
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${aLon},${aLat};${bLon},${bLat}?overview=false`);
      const j = await res.json();
      if (j.code === 'Ok') known[key] = j.routes[0].duration / 60;
      else if (j.code === 'NoRoute' || j.code === 'NoSegment') known[key] = null;
      try { localStorage.setItem(KEY, JSON.stringify(known)); } catch { /* sin almacenamiento */ }
      listeners.forEach((fn) => fn());
    } catch { /* red caída: se reintenta en la próxima evaluación */ }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  busy = false;
}
