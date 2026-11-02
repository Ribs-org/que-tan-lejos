// Carga el motor en Node con los mismos archivos que usa el navegador.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Engine, parseRoads, parseLand } from '../js/engine.js';

const gz = (name) => {
  const buf = zlib.gunzipSync(fs.readFileSync(new URL(`../data/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

export function loadEngine() {
  const flights = JSON.parse(fs.readFileSync(new URL('../data/flights.json', import.meta.url), 'utf8'));
  return new Engine(parseRoads(gz('roads.bin.gz')), flights, parseLand(gz('land.bin.gz')));
}
