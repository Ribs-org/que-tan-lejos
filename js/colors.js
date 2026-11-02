// Escala verde → rojo. Las paradas son fracciones de "rojo desde": en 1.0 el color
// ya es rojo, y sigue oscureciendo para lo que está mucho más lejos.
const STOPS = [
  [0, [18, 146, 74]],
  [0.35, [124, 195, 90]],
  [0.65, [242, 211, 61]],
  [0.85, [243, 146, 55]],
  [1, [229, 72, 47]],
  [1.6, [196, 36, 44]],
  [3, [140, 16, 42]],
  [6, [74, 10, 30]],
];

export const MAX_MIN = 6000;

// Curvas de nivel (en horas): dan una lectura que no depende del color
export const CONTOURS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 36, 48];

export function colorAt(min, redFrom) {
  const f = min / redFrom;
  for (let i = 1; i < STOPS.length; i++) {
    const [f1, c1] = STOPS[i];
    if (f <= f1) {
      const [f0, c0] = STOPS[i - 1];
      const t = (f - f0) / (f1 - f0);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
    }
  }
  return STOPS.at(-1)[1];
}

export function colorLUT(redFrom) {
  const lut = new Uint8Array((MAX_MIN + 1) * 3);
  for (let m = 0; m <= MAX_MIN; m++) lut.set(colorAt(m, redFrom), m * 3);
  return lut;
}

export function levelLUT() {
  const lut = new Uint8Array(MAX_MIN + 1);
  let level = 0;
  for (let m = 0; m <= MAX_MIN; m++) {
    while (level < CONTOURS.length && m >= CONTOURS[level] * 60) level++;
    lut[m] = level;
  }
  return lut;
}
