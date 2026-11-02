# ¿Qué tan lejos?

Eliges un punto en el mapa y la app pinta todo el mundo según el **tiempo real puerta a puerta** para llegar desde ahí: verde es cerca, rojo es lejos. Al tocar otro punto muestra el desglose del viaje:

```
Santiago → Puerto Montt   4 h 32 min
  🚗 Auto al aeropuerto SCL           28 min
  🛂 Aeropuerto SCL (check-in…)     1 h 30 min
  ✈️ Vuelo SCL → PMC                1 h 46 min   Sky, JetSMART, LATAM
  🧳 Llegada a PMC                      30 min
  🚗 Auto hasta el destino              18 min
```

Todo corre en el navegador: no hay servidor ni API de pago.

## Cómo se calcula

Caminos y vuelos forman **un solo grafo**:

- **Caminos**: red vial mundial de [Natural Earth](https://www.naturalearthdata.com/) (autopistas, rutas principales y ferris), con una velocidad promedio por tipo de camino.
- **Vuelos**: [airline-route-data](https://github.com/Jonty/airline-route-data), con todas las rutas comerciales vigentes y su duración real (se actualiza semanalmente).
- **Aeropuertos**: tiempo antes de volar (check-in y seguridad), salida al llegar, escalas y un extra por migración en vuelos internacionales. Todos se ajustan en la app.

Un Dijkstra desde el origen da el mejor tiempo a cada nodo, y combina solo auto, vuelo o escalas. Después, un barrido sobre una grilla mundial de 0,1° lleva ese tiempo a los lugares sin camino: la velocidad baja a medida que te alejas de la red, y el mar no se cruza.

Calcular un origen nuevo toma ~0,3 s en un Web Worker.

## Precisión

`tools/validate.mjs --osrm` compara los tiempos en auto contra OSRM (ruteo real sobre OpenStreetMap) en 32 rutas de todo el mundo:

- **Chile**: casi todo dentro de ±10 % (Santiago–Temuco, La Serena, Antofagasta, Pucón, Puerto Montt–Castro).
- **Mundo**: error mediano 12 %. En algunos países la red de Natural Earth está mal clasificada y el modelo sale hasta ~35–40 % más lento (Moscú–San Petersburgo, Johannesburgo–Ciudad del Cabo, Bangkok–Chiang Mai). En la cordillera colombiana sale más rápido de lo real.

Lo que no modela: horarios ni frecuencia de vuelos (una ruta semanal cuenta igual que una diaria), tráfico, trenes, buses ni pasos fronterizos terrestres.

## Correr localmente

Es un sitio estático, pero necesita un servidor porque usa módulos y un worker:

```sh
python -m http.server 8000
# abrir http://localhost:8000
```

## Regenerar los datos

```sh
mkdir raw && cd raw
curl -LO https://raw.githubusercontent.com/Jonty/airline-route-data/main/airline_routes.json && mv airline_routes.json routes.json
curl -L -o roads.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson
curl -L -o land.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson
cd ..
node --max-old-space-size=6000 tools/build-data.mjs raw
node tools/validate.mjs --osrm
```

## Créditos

Mapa base © [OpenFreeMap](https://openfreemap.org/), [OpenMapTiles](https://openmaptiles.org/) y colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright). Búsqueda con [Photon](https://photon.komoot.io/). Caminos y costas de Natural Earth (dominio público). Rutas aéreas de airline-route-data.
