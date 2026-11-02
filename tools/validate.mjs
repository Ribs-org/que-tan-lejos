// Compara el modelo contra OSRM (ruteo real sobre OpenStreetMap) y muestra viajes de ejemplo.
// Uso: node tools/validate.mjs [--osrm]
import { loadEngine } from './load-node.mjs';

const P = {
  santiago: [-33.44, -70.65], valparaiso: [-33.05, -71.61], concepcion: [-36.83, -73.05], temuco: [-38.74, -72.59],
  puertoMontt: [-41.47, -72.94], laSerena: [-29.90, -71.25], antofagasta: [-23.65, -70.40], mendoza: [-32.89, -68.84],
  buenosAires: [-34.60, -58.38], cordoba: [-31.42, -64.18], lima: [-12.05, -77.04], arequipa: [-16.41, -71.54],
  saoPaulo: [-23.55, -46.63], rio: [-22.91, -43.17], bogota: [4.71, -74.07], medellin: [6.25, -75.57], quito: [-0.18, -78.47],
  mexico: [19.43, -99.13], guadalajara: [20.67, -103.35], losAngeles: [34.05, -118.24], lasVegas: [36.17, -115.14],
  chicago: [41.88, -87.63], newYork: [40.71, -74.01], miami: [25.76, -80.19], madrid: [40.42, -3.70], barcelona: [41.39, 2.17],
  paris: [48.86, 2.35], lyon: [45.76, 4.84], berlin: [52.52, 13.40], munich: [48.14, 11.58], roma: [41.90, 12.50],
  johannesburg: [-26.20, 28.05], capeTown: [-33.92, 18.42], nairobi: [-1.29, 36.82], cairo: [30.04, 31.24],
  delhi: [28.61, 77.21], mumbai: [19.08, 72.88], bangkok: [13.76, 100.50], chiangMai: [18.79, 98.98], tokyo: [35.68, 139.69],
  osaka: [34.69, 135.50], sydney: [-33.87, 151.21], melbourne: [-37.81, 144.96], moscow: [55.76, 37.62], stPetersburg: [59.93, 30.34],
  coyhaique: [-45.57, -72.07], puntaArenas: [-53.16, -70.91], calama: [-22.45, -68.93], pucon: [-39.28, -71.97], castro: [-42.48, -73.76],
};
const DRIVES = [
  ['santiago', 'valparaiso'], ['santiago', 'concepcion'], ['santiago', 'temuco'], ['santiago', 'puertoMontt'], ['santiago', 'laSerena'],
  ['santiago', 'antofagasta'], ['santiago', 'mendoza'], ['santiago', 'pucon'], ['puertoMontt', 'castro'], ['puertoMontt', 'coyhaique'],
  ['buenosAires', 'cordoba'], ['buenosAires', 'mendoza'], ['lima', 'arequipa'], ['saoPaulo', 'rio'], ['bogota', 'medellin'], ['bogota', 'quito'],
  ['mexico', 'guadalajara'], ['losAngeles', 'lasVegas'], ['chicago', 'newYork'], ['newYork', 'miami'], ['madrid', 'barcelona'], ['paris', 'lyon'],
  ['berlin', 'munich'], ['paris', 'berlin'], ['roma', 'munich'], ['johannesburg', 'capeTown'], ['nairobi', 'johannesburg'], ['delhi', 'mumbai'],
  ['bangkok', 'chiangMai'], ['tokyo', 'osaka'], ['sydney', 'melbourne'], ['moscow', 'stPetersburg'],
];
const TRIPS = [
  ['santiago', 'puertoMontt'], ['santiago', 'puntaArenas'], ['santiago', 'calama'], ['santiago', 'coyhaique'], ['santiago', 'castro'],
  ['santiago', 'mendoza'], ['santiago', 'buenosAires'], ['santiago', 'madrid'], ['santiago', 'tokyo'], ['santiago', 'valparaiso'],
];

const hm = (m) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`;
const engine = loadEngine();
const { R, G, M } = engine.roads;
console.log(`nodos viales ${R}, suelo ${G}, aristas ${M}`);

function driveOnly(a, b) {
  const saved = engine.params;
  engine.compute(...P[a], { checkin: 1e7 });
  const t = engine.sample(...P[b]);
  engine.params = saved;
  return t;
}

if (process.argv.includes('--osrm')) {
  const rows = [];
  for (const [a, b] of DRIVES) {
    const url = `https://router.project-osrm.org/route/v1/driving/${P[a][1]},${P[a][0]};${P[b][1]},${P[b][0]}?overview=false`;
    const res = await (await fetch(url, { headers: { 'User-Agent': 'que-tan-lejos-validate' } })).json();
    const real = res.routes?.[0]?.duration / 60;
    const model = driveOnly(a, b);
    rows.push({ a, b, real, model, ratio: model / real });
    console.log(`${(a + ' → ' + b).padEnd(30)} real ${hm(real).padStart(7)}  modelo ${hm(model).padStart(7)}  ratio ${(model / real).toFixed(2)}`);
    await new Promise((r) => setTimeout(r, 1100));
  }
  const errs = rows.map((r) => Math.abs(Math.log(r.ratio))).sort((x, y) => x - y);
  console.log(`error mediano ${(Math.exp(errs[errs.length >> 1]) * 100 - 100).toFixed(0)}%, peor ${(Math.exp(errs.at(-1)) * 100 - 100).toFixed(0)}%`);
}

console.log('\n--- viajes puerta a puerta ---');
for (const [a, b] of TRIPS) {
  const t0 = performance.now();
  engine.compute(...P[a]);
  const t1 = performance.now();
  const trip = engine.trip(...P[b]);
  const legs = trip?.legs.map((l) => {
    if (l.kind === 'flight') return `✈${l.from.iata}-${l.to.iata} ${hm(l.min)}`;
    return `${l.kind} ${hm(l.min)}`;
  }).join(' | ');
  console.log(`${a} → ${b}: ${trip ? hm(trip.total) : 'sin datos'}  [${legs}]  (${(t1 - t0).toFixed(0)} ms)`);
}
