# API Unificada — Leoncito

Un **solo servicio Node/Express** que reemplaza a los 3 microservicios
(`sheets-api`, `ventas-service`, `gestion-service`) montándolos bajo prefijos:

| Prefijo | Contenido (antes era) |
|---|---|
| `/sheets/*`  | sheets-api: auth, usuarios, CAP, `/data/*`, gestión call/realzza, sedes-deriv, maps, permisos |
| `/ventas/*`  | ventas-service: ventas, margen, atribución, metas, productos |
| `/gestion/*` | gestion-service: gestión sedes, call-sedes, entregas, KOMMO, cobranza, control-supervisor, inventario |

Comparten la **misma base de datos** (Supabase). Cada sub-app es un módulo con su
propio scope, así que no hay colisión de nombres. Al montar por prefijo, cada request
pega a un solo sub-app (nada de `cors`/`json`/`compression` corriendo de más ni `/health`
en conflicto). **1 servicio = 1 sola factura** (antes 3 × $7 = $21 → ahora $7).

## Correr en local
```bash
cp .env.example .env      # y completar DATABASE_URL, etc.
# dejar el keyfile ffvv-realzza-campo-07c3f6b5b98f.json en esta carpeta
npm install
npm start                 # http://localhost:3000
```
Prueba: `GET /`, `GET /ventas/health`, `GET /gestion/health`.

## Docker
```bash
docker build -t api-unificada .
docker run --env-file .env -p 3000:3000 api-unificada
```

## Desplegar en Render (1 solo Web Service)
1. Nuevo **Web Service** apuntando a este repo/carpeta.
   - Build: `npm install`  ·  Start: `node server.js`
2. **Environment** → agregar: `DATABASE_URL`, `GOOGLE_MAPS_API_KEY`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (y las cachés si se usan).
   `SHEETS_API_URL` NO hace falta (el server la apunta al self).
3. **Secret Files** → subir `ffvv-realzza-campo-07c3f6b5b98f.json` (mismo nombre).
4. Apagar los 3 servicios antiguos (sheets-api, ventas-service, gestion-service).

## Cambio en el frontend (Dashboard)
Apuntar los 3 bases al mismo host, con su prefijo:
```ts
apiBase:     'https://<tu-servicio>.onrender.com/sheets',
ventasBase:  'https://<tu-servicio>.onrender.com/ventas',
gestionBase: 'https://<tu-servicio>.onrender.com/gestion',
```
