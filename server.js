// ─────────────────────────────────────────────────────────────────────────────
// API UNIFICADA — un solo servicio Node que monta los 3 antiguos microservicios
// (sheets-api, ventas-service, gestion-service) bajo prefijos de ruta:
//    /sheets/*   → todo lo de sheets-api  (auth, usuarios, CAP, data, gestión call/realzza,
//                  gestión sedes-deriv, maps, permisos)
//    /ventas/*   → todo lo de ventas-service (ventas, margen, atribución, metas, productos)
//    /gestion/*  → todo lo de gestion-service (gestión sedes, call-sedes, entregas, kommo,
//                  cobranza, control-supervisor, inventario)
//
// Cada sub-app es un módulo aparte (scope propio: helpers, pool, esquemas), así que NO
// hay colisión de nombres. Al montar por prefijo, cada request pega a UN solo sub-app,
// evitando que cors/json/compression corran varias veces o choque /health.
//
// Comparten la misma BD (DATABASE_URL). Se despliega como 1 servicio → 1 sola factura.
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// gestion-service llama internamente a las rutas de sheets (/data/sedes, /data/ferre).
// En el servicio unificado esas rutas viven bajo /sheets → apuntar la llamada al self.
// Se setea ANTES de requerir gestion (lee SHEETS_API_URL al cargar el módulo).
if (!process.env.SHEETS_API_URL) {
  process.env.SHEETS_API_URL = `http://localhost:${PORT}/sheets`;
}

app.get('/', (_req, res) => res.json({
  ok: true,
  service: 'api-unificada',
  mounts: ['/sheets', '/ventas', '/gestion'],
  ts: new Date().toISOString(),
}));

app.use('/sheets',  require('./services/sheets'));
app.use('/ventas',  require('./services/ventas'));
app.use('/gestion', require('./services/gestion'));

app.listen(PORT, () => console.log(`✅ API unificada escuchando en http://localhost:${PORT}  (/sheets · /ventas · /gestion)`));
