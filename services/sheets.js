require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const compression = require('compression');
const { Pool } = require('pg');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());   // gzip: comprime las respuestas JSON (5-10× menos bytes)
app.use(cors());
// Límite alto porque el control del supervisor puede traer fotos en base64.
app.use(express.json({ limit: '20mb' }));

// 🐘 PostgreSQL (Neon) — para el formulario de registro de gestión.
// La cadena vive en la variable de entorno DATABASE_URL (nunca en el código).
const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// 📤 Subida de archivos en memoria (para el Excel de ventas). Límite 200 MB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// 🔹 Configuración de autenticaciones por tipo
const googleAuthConfigs = {
  // call: new google.auth.GoogleAuth({
  //   keyFile: 'northern-cubist-454520-q8-1292a8b77330.json',
  //   scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  // }),
  claveUnica: new google.auth.GoogleAuth({
    keyFile: 'ffvv-realzza-campo-07c3f6b5b98f.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  }),
};

// 🔹 Configuración de hojas (puedes agregar más fácilmente)
const sheetsConfigs = {
  // NOTA: los formularios de gestión Call (call), Realzza (campo) y KOMMO (kommo) se
  // migraron a PostgreSQL (tablas gestion_call/gestion_realzza/gestion_kommo). Ya no se
  // leen ni se sincronizan desde Google Sheets, por eso se quitaron sus configuraciones.
  postVenta: {
    authKey: 'claveUnica',
    spreadsheetId: '1uJGGD-eLH8But-5rGdPcmgHZQl1tRbdsG5aDrHj-5UU',
    range: 'Form Responses 1!A:ZZZ',
  },
  pvCobranza: {
    authKey: 'claveUnica',
    spreadsheetId: '1-jAzHZamSVRSKur_8nI3RoY7n606syviR1pGO23YavA',
    range: 'Respuestas!A:ZZZ',
  },
  pvControlInterno: {
    authKey: 'claveUnica',
    spreadsheetId: '1g80tGBpZpJxz0C4efKq-DnV4_c2KM09_-SWgB4ZDMqg',
    range: 'Respuestas!A:ZZZ',
  },
  pvCreditos: {
    authKey: 'claveUnica',
    spreadsheetId: '1uwYZ3iulZYottE23bPHrFNahw5QJ2nUh0nsU8hu7TXQ',
    range: 'Respuestas!A:ZZZ',
  },
  pvLogistica: {
    authKey: 'claveUnica',
    spreadsheetId: '1jG0ageh-_985ybeta4DlYSvmpWkujFVxWJKC5Dxp3Zs',
    range: 'Respuestas!A:ZZZ',
  },
  pvOperaciones: {
    authKey: 'claveUnica',
    spreadsheetId: '1v1KJSVaeJtGda7qbZhgqCo2bPeSdGsBtSUvRw4ewiO8',
    range: 'Respuestas!A:ZZZ',
  },
  pvServicioTecnico: {
    authKey: 'claveUnica',
    spreadsheetId: '1XcTPp4BiOqwjeP6m9Y6Ubs0bgsNhPTd3OhC1KxN6yWU',
    range: 'Respuestas!A:ZZZ',
  },
  pvVentas: {
    authKey: 'claveUnica',
    spreadsheetId: '17ZG1N52lg7O7i8a-7D6xbkszaUG-bSQXSUjK3OP-QDs',
    range: 'Respuestas!A:ZZZ',
  },
  ferre: {
    authKey: 'claveUnica',
    spreadsheetId: '1q8flDOGxiZdhmP3Kpz4m8s74AKb6b8j60hgRlqfNpPo',
    range: 'Respuestas de formulario 1!A:ZZZ',
  },
  sedes: {
    authKey: 'claveUnica',
    spreadsheetId: '1bEfZoN_NqqWOKJ3vQrEAmaaaSRl3TsCJ2hDs51ni7Nw',
    range: 'Respuestas de formulario 1!A:ZZZ',
  },
  // Formulario de DERIVACIÓN por sede (Lambayeque / Ferreñafe) → cruce con ventas (atribución sedes).
  sedesDeriv: {
    authKey: 'claveUnica',
    spreadsheetId: '1XHnjRCBncVUmth2a2kTrRTgrGuIghZJPYvNIXZlWtM4',
    range: 'Respuestas de formulario 1!A:ZZZ',
  },
  // CAP de asesores por sede (no es un formulario: es una hoja normal).
  // Se lee de la pestaña "CAP", cuya fila 1 son las cabeceras
  // (VENDEDOR, SEDE, SUPERVISOR, GERENTE DE TIENDA, ZONA, CANAL, ESTADO, DNI).
  capSedes: {
    authKey: 'claveUnica',
    spreadsheetId: '1_mp6v9g6BfWZ4Otbmv2PTcmkicCqq9fhbAihR0CdHgQ',
    range: 'CAP!A:ZZZ',
  },
  usuarios: {
    authKey: 'claveUnica',
    spreadsheetId: '1z7Qx5vvwCkX2TjVbhUIBR8cMCW3IcdAQHXrIalz0_ZI',
    range: 'usuarios!A:F',
  }
};

// 🗃️ Cache en memoria de las hojas de Google Sheets. Evita descargar la hoja
// entera (decenas de miles de filas) en CADA carga: la 1ª petición va a Google
// y las siguientes, dentro del TTL, se sirven de memoria (instantáneas). Se
// cachea el resultado YA transformado (headers + filas) por nombre de hoja; el
// filtro por fecha se aplica después, en cada request. TTL por env (def. 3 min).
// Forzar refresco con ?fresh=1.
const SHEET_CACHE_TTL_MS = parseInt(process.env.SHEET_CACHE_TTL_MS || '180000', 10);
const sheetCache = new Map(); // sheetName -> { ts, headers, jsonData }

// Descarga una hoja en LOTES de filas (varias llamadas chicas) en vez de una sola
// petición gigante: así el JSON de Google que parsea Node es pequeño en cada paso y
// se evita el pico de memoria que agotaba el heap (OOM al parsear hojas grandes como
// KOMMO ~13.7MB). Devuelve todas las filas (array de arrays), igual que values.get.
async function getSheetValuesChunked(sheets, spreadsheetId, range, chunk = 4000) {
  const bang = range.indexOf('!');
  const sheetPart = bang >= 0 ? range.slice(0, bang) : range;
  const colSpec = bang >= 0 ? range.slice(bang + 1) : 'A:ZZZ';
  const parts = colSpec.split(':');
  const startCol = (parts[0] || 'A').replace(/\d+/g, '') || 'A';
  const endCol = (parts[1] || parts[0] || 'ZZZ').replace(/\d+/g, '') || 'ZZZ';
  const q = "'" + sheetPart.replace(/'/g, "''") + "'";   // nombre de hoja citado (tiene espacios)
  const all = [];
  let lo = 1;
  for (;;) {
    const hi = lo + chunk - 1;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${q}!${startCol}${lo}:${endCol}${hi}`,
    });
    const vals = resp.data.values || [];
    for (const row of vals) all.push(row);
    if (vals.length < chunk) break;   // último lote (Google recorta filas vacías finales)
    lo += chunk;
  }
  return all;
}

// 📌 Ruta dinámica: /form/:sheetName
app.get('/data/:sheetName', async (req, res) => {
  const { sheetName } = req.params;
  const config = sheetsConfigs[sheetName];

  if (!config) {
    return res.status(400).json({ error: 'El nombre del formulario no es válido.' });
  }

  try {
    // Cache: si la hoja está en memoria y aún es fresca, se evita la descarga.
    const ahora = Date.now();
    let cached = sheetCache.get(sheetName);
    if (!cached || req.query.fresh || (ahora - cached.ts) >= SHEET_CACHE_TTL_MS) {
      // Autenticación dinámica
      const auth = googleAuthConfigs[config.authKey];
      const client = await auth.getClient();
      const sheets = google.sheets({ version: 'v4', auth: client });

      // Obtener datos de Google Sheets EN LOTES (evita el parse gigante → OOM).
      const rows = await getSheetValuesChunked(sheets, config.spreadsheetId, config.range);
      if (!rows || rows.length === 0) {
        return res.status(404).send('No se encontraron datos en Google Sheets.');
      }

      const [rawHeaders, ...data] = rows;

      // Evita encabezados duplicados
      const headers = [];
      const headerCount = {};
      rawHeaders.forEach((header) => {
        if (!headerCount[header]) {
          headerCount[header] = 1;
          headers.push(header);
        } else {
          const newHeader = `${header} (${headerCount[header]})`;
          headerCount[header]++;
          headers.push(newHeader);
        }
      });

      // Se cachean las filas EN CRUDO (array de arrays, ~igual que el payload) y
      // NO el JSON expandido: en objetos por fila la hoja pesa ~7× más en memoria
      // (30k+ objetos), lo que en el plan Free (512MB) causaba OOM. La expansión a
      // JSON se hace por request (transitoria, se libera al responder).
      cached = { ts: ahora, headers, data };
      sheetCache.set(sheetName, cached);
    }

    const headers = cached.headers;
    const data = cached.data;

    // 🔎 Filtro opcional por fecha, resuelto por ÍNDICE de columna (sin expandir la
    // hoja). p.ej. /data/sedes?desde=2026-07-01&hasta=2026-07-31
    const { desde, hasta } = req.query;
    let colIdx = -1;
    if (desde || hasta) {
      const colFecha = headers.includes('Marca temporal') ? 'Marca temporal'
        : (headers.includes('Timestamp') ? 'Timestamp' : null);
      colIdx = colFecha ? headers.indexOf(colFecha) : -1;
    }
    const toKey = (marca) => {
      if (!marca) return null;
      const p = String(marca).trim().split(' ')[0].split('/'); // d/M/yyyy
      if (p.length !== 3) return null;
      const [d, mo, y] = p;
      if (!y || !mo || !d) return null;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    };
    const pasa = (row) => {
      if (colIdx < 0) return true;
      const k = toKey(row[colIdx]);
      if (!k) return false;
      if (desde && k < desde) return false;
      if (hasta && k > hasta) return false;
      return true;
    };

    // Respuesta en STREAMING por lotes: NO se materializa el array de 30k+ objetos
    // ni el string gigante en memoria (eso agotaba el heap → FATAL "heap out of
    // memory" / exit 134 en Render Free). compression() gzipa el stream al vuelo.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.write('[');
    const H = headers.length;
    let first = true;
    let buf = [];
    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      if (colIdx >= 0 && !pasa(row)) continue;
      const obj = {};
      for (let i = 0; i < H; i++) obj[headers[i]] = row[i] || '';
      buf.push(JSON.stringify(obj));
      if (buf.length >= 500) { res.write((first ? '' : ',') + buf.join(',')); first = false; buf = []; }
    }
    if (buf.length) res.write((first ? '' : ',') + buf.join(','));
    res.write(']');
    res.end();
  } catch (error) {
    console.error(`❌ Error al obtener datos de ${sheetName}:`, error);
    res.status(500).send('Error al obtener datos de Google Sheets');
  }
});

// 🔐 Login: POST /auth/login — valida SOLO contra la BD (usuarios), bcrypt.
// El sheet ya no se usa en runtime (solo sirvió para la migración inicial).
app.post('/auth/login', async (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({ success: false, message: 'Usuario y contraseña requeridos.' });
  }
  if (!pgPool) {
    return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  }

  try {
    await ensureUsuariosSchema();
    const { rows } = await pgPool.query('SELECT * FROM usuarios WHERE lower(usuario) = lower($1)', [usuario]);
    const u = rows[0];
    const ok = u && u.activo && await bcrypt.compare(password, u.password_hash || '');
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas o usuario inactivo.' });
    }
    res.json({
      success: true, nombre: u.nombre || '', rol: u.rol || '', sede: u.sede || '',
      // Sedes asignadas (varias). Si no hay lista, cae a [sede] para compatibilidad.
      sedes: Array.isArray(u.sedes) && u.sedes.length ? u.sedes : (u.sede ? [u.sede] : []),
      vendedor: u.vendedor || '', canal: u.canal || '', vehiculo: u.vehiculo || '',
      modulos: Array.isArray(u.modulos) ? u.modulos : null,   // null = usa default por rol-perfil
      debeCambiarPassword: !!u.debe_cambiar_password,          // forzar cambio en el 1er login
    });
  } catch (error) {
    console.error('❌ Error en /auth/login:', error);
    res.status(500).json({ success: false, message: 'Error al autenticar.' });
  }
});

// POST /auth/cambiar-password — el propio usuario cambia su clave (valida la actual).
// Usado en el "forzar cambio en el primer login" y para autoservicio.
app.post('/auth/cambiar-password', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const { usuario, actual, nueva } = req.body || {};
  if (!usuario || !actual || !nueva) return res.status(400).json({ success: false, message: 'Faltan datos.' });
  if (String(nueva).length < 4) return res.status(400).json({ success: false, message: 'La nueva contraseña es muy corta (mínimo 4).' });
  try {
    await ensureUsuariosSchema();
    const { rows } = await pgPool.query('SELECT * FROM usuarios WHERE lower(usuario) = lower($1)', [usuario]);
    const u = rows[0];
    const ok = u && u.activo && await bcrypt.compare(String(actual), u.password_hash || '');
    if (!ok) return res.status(401).json({ success: false, message: 'La contraseña actual no es correcta.' });
    const hash = await bcrypt.hash(String(nueva), 10);
    await pgPool.query('UPDATE usuarios SET password_hash = $1, debe_cambiar_password = false, actualizado_en = now() WHERE id = $2', [hash, u.id]);
    res.json({ success: true });
  } catch (e) { console.error('❌ /auth/cambiar-password:', e); res.status(500).json({ success: false, message: 'No se pudo cambiar la contraseña.' }); }
});

// GET /auth/marca?usuario=... — sede del usuario (sin contraseña) para personalizar el branding del login.
app.get('/auth/marca', async (req, res) => {
  const usuario = (req.query.usuario || '').toString().trim();
  if (!pgPool || !usuario) return res.json({});
  try {
    await ensureUsuariosSchema();
    const { rows } = await pgPool.query('SELECT sede FROM usuarios WHERE lower(usuario) = lower($1) LIMIT 1', [usuario]);
    res.json({ sede: rows[0] ? (rows[0].sede || '') : '' });
  } catch (e) { console.error('❌ /auth/marca:', e.message); res.json({}); }
});

// Registro de gestión (POST /gestion) → movido a gestion-service (:4004).

// ─────────────────────────────────────────────────────────────────────────────
// 🗺️ Optimización de rutas: POST /maps/optimizar
//
// El frontend envía la lista completa de puntos. Aquí (y SOLO aquí) usamos la
// API Key de Google Maps —vive en la variable de entorno GOOGLE_MAPS_API_KEY,
// nunca en el cliente— para pedir a la ROUTES API (computeRoutes) el orden
// óptimo de los waypoints intermedios (optimizeWaypointOrder: true →
// routes[0].optimizedIntermediateWaypointIndex).
//
// Nota: usamos la Routes API (routes.googleapis.com) en lugar de la Directions
// API "legacy", que Google ya no habilita en proyectos nuevos.
//
// Body esperado:
//   { "coordenadas": [ { "lat": -6.77, "lng": -79.84, "id": "A", "nombre": "Sede" }, ... ],
//     "travelmode": "driving" }   // driving | walking | bicycling | transit
//
// Respuesta:
//   { success, waypointOrder, puntosOptimizados, distanciaMetros, duracionSegundos }
// ─────────────────────────────────────────────────────────────────────────────
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Mapea el modo del frontend al enum de la Routes API.
const TRAVEL_MODE_MAP = {
  driving: 'DRIVE',
  walking: 'WALK',
  bicycling: 'BICYCLE',
  transit: 'TRANSIT',
};

app.post('/maps/optimizar', async (req, res) => {
  const { coordenadas, travelmode = 'driving' } = req.body || {};

  if (!Array.isArray(coordenadas) || coordenadas.length < 2) {
    return res.status(400).json({
      success: false,
      message: 'Se requieren al menos 2 coordenadas (origen y destino).',
    });
  }
  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({
      success: false,
      message: 'Falta configurar GOOGLE_MAPS_API_KEY en el servidor.',
    });
  }

  const esValida = (c) =>
    c && typeof c.lat === 'number' && typeof c.lng === 'number' &&
    c.lat >= -90 && c.lat <= 90 && c.lng >= -180 && c.lng <= 180;

  if (!coordenadas.every(esValida)) {
    return res.status(400).json({ success: false, message: 'Hay coordenadas inválidas.' });
  }

  try {
    const waypoint = (c) => ({ location: { latLng: { latitude: c.lat, longitude: c.lng } } });
    const origin = coordenadas[0];
    const destination = coordenadas[coordenadas.length - 1];
    const intermedios = coordenadas.slice(1, -1);

    const body = {
      origin: waypoint(origin),
      destination: waypoint(destination),
      travelMode: TRAVEL_MODE_MAP[travelmode] || 'DRIVE',
    };
    if (intermedios.length > 0) {
      body.intermediates = intermedios.map(waypoint);
      // 🔑 Parámetro crítico que pide a Google reordenar los waypoints.
      body.optimizeWaypointOrder = true;
    }

    const apiRes = await fetch(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
          'X-Goog-FieldMask':
            'routes.optimizedIntermediateWaypointIndex,routes.distanceMeters,routes.duration',
        },
        body: JSON.stringify(body),
      },
    );
    const data = await apiRes.json();

    if (!apiRes.ok || !data.routes?.length) {
      return res.status(502).json({
        success: false,
        message: `Google Routes: ${data?.error?.status || apiRes.status}${data?.error?.message ? ' — ' + data.error.message : ''}`,
      });
    }

    const route = data.routes[0];
    // Orden óptimo de los intermedios (índices 0-based del tramo intermedio).
    const waypointOrder = route.optimizedIntermediateWaypointIndex || [];

    // Reconstruir la lista completa ya ordenada: origen + intermedios óptimos + destino.
    const intermediosOrdenados = waypointOrder.map((i) => intermedios[i]);
    const puntosOptimizados = [origin, ...intermediosOrdenados, destination];

    // Totales (duration viene como string tipo "1234s").
    const distanciaMetros = route.distanceMeters || 0;
    const duracionSegundos = parseInt(String(route.duration || '0').replace('s', ''), 10) || 0;

    res.json({
      success: true,
      waypointOrder,
      puntosOptimizados,
      distanciaMetros,
      duracionSegundos,
    });
  } catch (error) {
    console.error('❌ Error en /maps/optimizar:', error);
    res.status(500).json({ success: false, message: 'Error al optimizar la ruta.' });
  }
});

// Helper compartido: normaliza a texto (o null si vacío). Usado por gestion-realzza
// y gestion-call. (Ventas/margen se movieron a ventas-service.)
function toStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// 👤 USUARIOS → PostgreSQL (Neon). Contraseñas hasheadas con bcrypt.
// Reemplaza (con fallback) al sheet 'usuarios'. CRUD para el módulo Seguridad.
// ─────────────────────────────────────────────────────────────────────────────
let usuariosSchemaLista = false;
async function ensureUsuariosSchema() {
  if (!pgPool || usuariosSchemaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id             BIGSERIAL PRIMARY KEY,
      usuario        TEXT UNIQUE NOT NULL,
      password_hash  TEXT NOT NULL,
      nombre         TEXT,
      rol            TEXT,
      sede           TEXT,
      activo         BOOLEAN NOT NULL DEFAULT true,
      creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Identidad del vendedor (para "Mi Panel"): su nombre exacto + canal (sede/call/realzza).
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS vendedor TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS canal    TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sedes    JSONB;
    -- Permisos POR USUARIO: lista de módulos (JSONB). NULL = usa el default por rol-perfil.
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS modulos  JSONB;
    -- Vínculo con el CAP: DNI del asesor (usuario/clave por defecto) + forzar cambio 1er login.
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS dni      TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS debe_cambiar_password BOOLEAN NOT NULL DEFAULT false;
    -- Carro de reparto asignado (rol chofer): AZUL / VERDE / NARANJA.
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS vehiculo TEXT;
  `);
  usuariosSchemaLista = true;
}

// Migración única: si la tabla está vacía, importa los usuarios del sheet (hasheando).
async function migrarUsuariosDesdeSheet() {
  if (!pgPool) return;
  await ensureUsuariosSchema();
  const { rows } = await pgPool.query('SELECT COUNT(*)::int AS n FROM usuarios');
  if (rows[0].n > 0) return;
  try {
    const config = sheetsConfigs['usuarios'];
    const auth = googleAuthConfigs[config.authKey];
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range: config.range });
    const data = resp.data.values;
    if (!data || data.length < 2) return;
    const [headers, ...filas] = data;
    const idx = (c) => headers.indexOf(c);
    let n = 0;
    for (const row of filas) {
      const usuario = (row[idx('usuario')] || '').toString().trim();
      const pass = (row[idx('password')] || '').toString();
      if (!usuario || !pass) continue;
      const hash = await bcrypt.hash(pass, 10);
      const activo = (row[idx('activo')] || '').toString().trim().toUpperCase() === 'SI';
      await pgPool.query(
        `INSERT INTO usuarios (usuario, password_hash, nombre, rol, sede, activo)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (usuario) DO NOTHING`,
        [usuario, hash, (row[idx('nombre')] || '').toString().trim(),
         (row[idx('rol')] || '').toString().trim(), (row[idx('sede')] || '').toString().trim(), activo]
      );
      n++;
    }
    console.log(`🔐 Migrados ${n} usuarios del sheet a la BD.`);
  } catch (e) {
    console.error('⚠️ No se pudo migrar usuarios del sheet:', e.message);
  }
}

// GET /usuarios — lista (sin el hash).
app.get('/usuarios', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureUsuariosSchema();
    const { rows } = await pgPool.query(
      'SELECT id, usuario, nombre, rol, sede, sedes, vendedor, canal, modulos, activo, dni, debe_cambiar_password, vehiculo, creado_en, actualizado_en FROM usuarios ORDER BY usuario'
    );
    res.json(rows);
  } catch (e) { console.error('❌ GET /usuarios', e); res.status(500).json({ success: false, message: 'No se pudieron obtener los usuarios.' }); }
});

// POST /usuarios — crea (hashea la contraseña).
app.post('/usuarios', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const b = req.body || {};
  const usuario = (b.usuario || '').toString().trim();
  const password = (b.password || '').toString();
  if (!usuario || !password) return res.status(400).json({ success: false, message: 'Usuario y contraseña son obligatorios.' });
  try {
    await ensureUsuariosSchema();
    const hash = await bcrypt.hash(password, 10);
    const modulos = Array.isArray(b.modulos) ? JSON.stringify(b.modulos) : null;
    const sedesArr = Array.isArray(b.sedes) ? b.sedes.filter(Boolean) : [];
    const sedesJson = sedesArr.length ? JSON.stringify(sedesArr) : null;
    const sedePrincipal = ((b.sede || '').toString().trim()) || sedesArr[0] || '';
    const { rows } = await pgPool.query(
      `INSERT INTO usuarios (usuario, password_hash, nombre, rol, sede, vendedor, canal, modulos, sedes, activo, dni, debe_cambiar_password, vehiculo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
       RETURNING id, usuario, nombre, rol, sede, sedes, vendedor, canal, modulos, activo, dni, vehiculo`,
      [usuario, hash, (b.nombre || '').toString().trim(), (b.rol || '').toString().trim(),
       sedePrincipal,
       (b.vendedor || '').toString().trim() || null, (b.canal || '').toString().trim() || null,
       modulos, sedesJson, b.activo !== false,
       (b.dni || '').toString().trim() || null, !!b.debe_cambiar_password,
       (b.vehiculo || '').toString().trim().toUpperCase() || null]
    );
    res.json({ success: true, usuario: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ success: false, message: 'Ya existe un usuario con ese nombre de acceso.' });
    console.error('❌ POST /usuarios', e); res.status(500).json({ success: false, message: 'No se pudo crear el usuario.' });
  }
});

// 👥 ALTA MASIVA de usuarios de una SEDE desde el CAP (cap_asesores ACTIVO con DNI).
// Crea un usuario "vendedor de sede" por cada asesor: usuario=DNI, contraseña=DNI, canal=sede,
// forzar cambio en el 1er login. Omite los que ya existen (por usuario o DNI).
//   GET  /usuarios/bulk-cap?sede=lambayeque → previsualiza (quiénes se crearían / ya existen)
//   POST /usuarios/bulk-cap { sede }        → crea los que faltan y devuelve el resumen.
function normSedeKey(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ñ/g, 'n').replace(/[^a-z0-9]/g, '').replace(/^sederelenor/, '');
}
// Asesores ACTIVOS con DNI de la sede (normalizada) + si ya tienen usuario creado.
async function capAsesoresDeSede(sedeKey) {
  const { rows } = await pgPool.query(`
    SELECT c.vendedor, TRIM(c.dni) AS dni,
      EXISTS(SELECT 1 FROM usuarios u WHERE u.usuario = TRIM(c.dni) OR u.dni = TRIM(c.dni)
             OR UPPER(TRIM(u.vendedor)) = UPPER(TRIM(c.vendedor))) AS existe
    FROM cap_asesores c
    WHERE c.estado = 'ACTIVO' AND c.dni IS NOT NULL AND TRIM(c.dni) <> ''
      AND regexp_replace(lower(translate(c.sede,'ñÑ','nn')),'[^a-z0-9]','','g') = $1
    ORDER BY c.vendedor`, [sedeKey]);
  return rows;
}
app.get('/usuarios/bulk-cap', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureUsuariosSchema(); await ensureCapSchema();
    const sedeKey = normSedeKey(req.query.sede);
    if (!sedeKey) return res.status(400).json({ success: false, message: 'Falta la sede.' });
    const filas = await capAsesoresDeSede(sedeKey);
    res.json({
      success: true, sede: sedeKey, total: filas.length,
      nuevos: filas.filter(f => !f.existe).length,
      existentes: filas.filter(f => f.existe).length,
      detalle: filas,
    });
  } catch (e) { console.error('❌ GET /usuarios/bulk-cap', e); res.status(500).json({ success: false, message: 'No se pudo leer el CAP.' }); }
});
app.post('/usuarios/bulk-cap', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureUsuariosSchema(); await ensureCapSchema();
    const body = req.body || {};
    const sedeKey = normSedeKey(body.sede);
    if (!sedeKey) return res.status(400).json({ success: false, message: 'Falta la sede.' });
    // Permisos: si viene un array `modulos`, se asigna EXPLÍCITO a todos; si no, NULL = default rol-perfil.
    const modulos = Array.isArray(body.modulos) ? JSON.stringify(body.modulos.filter(Boolean)) : null;
    const filas = await capAsesoresDeSede(sedeKey);
    const creados = [], omitidos = [];
    for (const f of filas) {
      if (f.existe) { omitidos.push({ vendedor: f.vendedor, dni: f.dni, motivo: 'ya existe' }); continue; }
      const dni = (f.dni || '').toString().trim();
      try {
        const hash = await bcrypt.hash(dni, 10);
        const { rowCount } = await pgPool.query(
          `INSERT INTO usuarios (usuario, password_hash, nombre, rol, sede, vendedor, canal, modulos, sedes, activo, dni, debe_cambiar_password)
           VALUES ($1,$2,$3,'vendedor',$4,$5,'sede',$8::jsonb,$6::jsonb,true,$7,true)
           ON CONFLICT (usuario) DO NOTHING`,
          [dni, hash, f.vendedor, sedeKey, f.vendedor, JSON.stringify([sedeKey]), dni, modulos]
        );
        if (rowCount > 0) creados.push({ vendedor: f.vendedor, dni, usuario: dni });
        else omitidos.push({ vendedor: f.vendedor, dni, motivo: 'ya existe' });
      } catch (e) { omitidos.push({ vendedor: f.vendedor, dni, motivo: 'error' }); }
    }
    res.json({ success: true, sede: sedeKey, creados: creados.length, omitidos: omitidos.length, detalle: { creados, omitidos } });
  } catch (e) { console.error('❌ POST /usuarios/bulk-cap', e); res.status(500).json({ success: false, message: 'No se pudo crear los usuarios.' }); }
});

// PUT /usuarios/:id — edita; si mandan password (no vacío) se rehashea.
app.put('/usuarios/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const b = req.body || {};
  const id = parseInt(req.params.id, 10);
  const usuario = (b.usuario || '').toString().trim();
  if (!usuario) return res.status(400).json({ success: false, message: 'El usuario es obligatorio.' });
  try {
    await ensureUsuariosSchema();
    const sedesArr = Array.isArray(b.sedes) ? b.sedes.filter(Boolean) : [];
    const sedesJson = sedesArr.length ? JSON.stringify(sedesArr) : null;
    const sedePrincipal = ((b.sede || '').toString().trim()) || sedesArr[0] || '';
    const campos = ['usuario = $2', 'nombre = $3', 'rol = $4', 'sede = $5', 'activo = $6',
                    'vendedor = $7', 'canal = $8', 'sedes = $9::jsonb', 'actualizado_en = now()'];
    const params = [id, usuario, (b.nombre || '').toString().trim(), (b.rol || '').toString().trim(),
                    sedePrincipal, b.activo !== false,
                    (b.vendedor || '').toString().trim() || null, (b.canal || '').toString().trim() || null,
                    sedesJson];
    if (b.dni !== undefined) { params.push((b.dni || '').toString().trim() || null); campos.push(`dni = $${params.length}`); }
    if (b.debe_cambiar_password !== undefined) { params.push(!!b.debe_cambiar_password); campos.push(`debe_cambiar_password = $${params.length}`); }
    if (b.vehiculo !== undefined) { params.push((b.vehiculo || '').toString().trim().toUpperCase() || null); campos.push(`vehiculo = $${params.length}`); }
    if (b.password && b.password.toString().trim() !== '') {
      const hash = await bcrypt.hash(b.password.toString(), 10);
      params.push(hash);
      campos.push(`password_hash = $${params.length}`);
    }
    const { rows } = await pgPool.query(
      `UPDATE usuarios SET ${campos.join(', ')} WHERE id = $1
       RETURNING id, usuario, nombre, rol, sede, sedes, vendedor, canal, activo`, params
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    res.json({ success: true, usuario: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ success: false, message: 'Ya existe un usuario con ese nombre de acceso.' });
    console.error('❌ PUT /usuarios/:id', e); res.status(500).json({ success: false, message: 'No se pudo actualizar el usuario.' });
  }
});

// PATCH /usuarios/:id/estado — activar / desactivar.
app.patch('/usuarios/:id/estado', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const id = parseInt(req.params.id, 10);
  const activo = !!(req.body && req.body.activo);
  try {
    await ensureUsuariosSchema();
    const { rows } = await pgPool.query(
      'UPDATE usuarios SET activo = $2, actualizado_en = now() WHERE id = $1 RETURNING id, usuario, activo', [id, activo]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    res.json({ success: true, usuario: rows[0] });
  } catch (e) { console.error('❌ PATCH /usuarios/:id/estado', e); res.status(500).json({ success: false, message: 'No se pudo cambiar el estado.' }); }
});

// DELETE /usuarios/:id — borra el usuario de la BD (real, no solo desactivar).
// Guardia: no permite borrar el ÚLTIMO admin activo (evita quedarse sin acceso).
app.delete('/usuarios/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, message: 'Id inválido.' });
  try {
    await ensureUsuariosSchema();
    const { rows: objetivo } = await pgPool.query('SELECT id, usuario, rol FROM usuarios WHERE id = $1', [id]);
    if (!objetivo.length) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    if ((objetivo[0].rol || '').toLowerCase() === 'admin') {
      const { rows: adm } = await pgPool.query(`SELECT COUNT(*)::int n FROM usuarios WHERE LOWER(rol) = 'admin' AND activo = true`);
      if (adm[0].n <= 1) return res.status(409).json({ success: false, message: 'No se puede eliminar el único administrador.' });
    }
    await pgPool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    res.json({ success: true, id, usuario: objetivo[0].usuario });
  } catch (e) { console.error('❌ DELETE /usuarios/:id', e); res.status(500).json({ success: false, message: 'No se pudo eliminar el usuario.' }); }
});

// PATCH /usuarios/:id/modulos — permisos POR USUARIO (lista de módulos). null = usa default rol-perfil.
app.patch('/usuarios/:id/modulos', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const id = parseInt(req.params.id, 10);
  const modulos = Array.isArray(req.body && req.body.modulos) ? JSON.stringify(req.body.modulos) : null;
  try {
    await ensureUsuariosSchema();
    const { rows } = await pgPool.query(
      'UPDATE usuarios SET modulos = $2::jsonb, actualizado_en = now() WHERE id = $1 RETURNING id, usuario, modulos', [id, modulos]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    res.json({ success: true, usuario: rows[0] });
  } catch (e) { console.error('❌ PATCH /usuarios/:id/modulos', e); res.status(500).json({ success: false, message: 'No se pudieron guardar los permisos.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔑 PERMISOS (matriz Rol+Perfil → módulos) → PostgreSQL (Neon).
// Reemplaza el localStorage del navegador para que Seguridad sea centralizada.
// ─────────────────────────────────────────────────────────────────────────────
let permisosSchemaLista = false;
async function ensurePermisosSchema() {
  if (!pgPool || permisosSchemaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS permisos (
      clave          TEXT PRIMARY KEY,
      modulos        JSONB NOT NULL DEFAULT '[]'::jsonb,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  permisosSchemaLista = true;
}

// GET /permisos → { 'gerente-call': [...módulos], ... }
app.get('/permisos', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensurePermisosSchema();
    const { rows } = await pgPool.query('SELECT clave, modulos FROM permisos');
    const map = {};
    rows.forEach(r => { map[r.clave] = r.modulos || []; });
    res.json(map);
  } catch (e) { console.error('❌ GET /permisos', e); res.status(500).json({ success: false, message: 'No se pudieron obtener los permisos.' }); }
});

// PUT /permisos → body = { clave: [módulos], ... } (upsert de todas las claves).
app.put('/permisos', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const map = req.body || {};
  try {
    await ensurePermisosSchema();
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      for (const [clave, modulos] of Object.entries(map)) {
        await client.query(
          `INSERT INTO permisos (clave, modulos, actualizado_en) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (clave) DO UPDATE SET modulos = EXCLUDED.modulos, actualizado_en = now()`,
          [clave, JSON.stringify(Array.isArray(modulos) ? modulos : [])]
        );
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /permisos', e); res.status(500).json({ success: false, message: 'No se pudieron guardar los permisos.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 📋 GESTIÓN REALZZA → PostgreSQL (Neon). Reemplaza el Google Form de campo.
// La tabla guarda las 29 columnas del form + marca_temporal (real) + origen.
// GET devuelve las MISMAS cabeceras de la hoja para que los módulos que hoy
// consumen /data/campo funcionen igual cambiando una sola línea.
// ─────────────────────────────────────────────────────────────────────────────

// Columnas de la tabla, en el orden del INSERT.
const GRZ_COLS = [
  'marca_temporal', 'marca_temporal_raw', 'asesor_realzza', 'sede', 'tipo_base',
  'dni_cliente', 'celular_gestionado', 'estado_gestion', 'medio_primer_contacto',
  'resultado_gestion', 'producto_interes', 'motivo_interes', 'motivo_agendamiento',
  'fecha_interes_agendamiento', 'hora_interes_agendamiento', 'comentario_agendamiento',
  'fecha_interes_derivacion', 'hora_interes_derivacion', 'comentario_derivacion',
  'motivo_no_interes', 'comentario_no_interes', 'motivo_no_atendible', 'comentario_no_atendible',
  'motivos_tercero_relacionado', 'fecha_rellamada', 'hora_rellamada', 'numero_titular_actual',
  'motivo_no_contacto', 'motivo_no_cierre', 'comentario_venta_no_concretada', 'origen',
];

let grzSchemaLista = false;
async function ensureGestionRealzzaSchema() {
  if (!pgPool || grzSchemaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS gestion_realzza (
      id                            BIGSERIAL PRIMARY KEY,
      marca_temporal                TIMESTAMP,
      marca_temporal_raw            TEXT,
      asesor_realzza                TEXT,
      sede                          TEXT,
      tipo_base                     TEXT,
      dni_cliente                   TEXT,
      celular_gestionado            TEXT,
      estado_gestion                TEXT,
      medio_primer_contacto         TEXT,
      resultado_gestion             TEXT,
      producto_interes              TEXT,
      motivo_interes                TEXT,
      motivo_agendamiento           TEXT,
      fecha_interes_agendamiento    TEXT,
      hora_interes_agendamiento     TEXT,
      comentario_agendamiento       TEXT,
      fecha_interes_derivacion      TEXT,
      hora_interes_derivacion       TEXT,
      comentario_derivacion         TEXT,
      motivo_no_interes             TEXT,
      comentario_no_interes         TEXT,
      motivo_no_atendible           TEXT,
      comentario_no_atendible       TEXT,
      motivos_tercero_relacionado   TEXT,
      fecha_rellamada               TEXT,
      hora_rellamada                TEXT,
      numero_titular_actual         TEXT,
      motivo_no_contacto            TEXT,
      motivo_no_cierre              TEXT,
      comentario_venta_no_concretada TEXT,
      origen                        TEXT NOT NULL DEFAULT 'app',
      creado_en                     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_grz_marca  ON gestion_realzza (marca_temporal);
    CREATE INDEX IF NOT EXISTS ix_grz_asesor ON gestion_realzza (asesor_realzza);
    CREATE INDEX IF NOT EXISTS ix_grz_dni    ON gestion_realzza (dni_cliente);
  `);
  grzSchemaLista = true;
}

// "14/10/2025 9:18:07" → Date. Devuelve null si no parsea.
function parseMarcaTemporal(s) {
  if (!s) return null;
  const [fecha, hora] = s.toString().trim().split(' ');
  const [d, m, y] = (fecha || '').split('/').map(Number);
  if (!d || !m || !y) return null;
  const [hh = 0, mm = 0, ss = 0] = (hora || '').split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0);
  return isNaN(dt) ? null : dt;
}
function formatMarca(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${d.getHours()}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Fecha/hora actual en Perú (America/Lima, UTC-5) SIN depender de la zona del
// servidor (en Render es UTC → +5h). Devuelve:
//  - ts:  'yyyy-mm-dd HH:mm:ss'  para la columna TIMESTAMP (se guarda tal cual).
//  - raw: 'd/m/yyyy H:mm:ss'     mismo formato que formatMarca (marca_temporal_raw).
function ahoraLima() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = {};
  for (const x of parts) if (x.type !== 'literal') p[x.type] = x.value;
  const hh = p.hour === '24' ? '00' : p.hour;   // Intl a veces da '24' a medianoche
  return {
    ts: `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`,
    raw: `${+p.day}/${+p.month}/${+p.year} ${+hh}:${p.minute}:${p.second}`,
  };
}

// Fila de la hoja (objeto por cabecera) → arreglo en el orden de GRZ_COLS.
function mapRealzzaRow(r, origen) {
  return [
    parseMarcaTemporal(r['Marca temporal']),
    toStr(r['Marca temporal']),
    toStr(r['ASESOR REALZZA']), toStr(r['SEDE']), toStr(r['TIPO DE BASE']),
    toStr(r['DNI CLIENTE']), toStr(r['CELULAR GESTIONADO']), toStr(r['ESTADO DE GESTIÓN']),
    toStr(r['MEDIO DE PRIMER CONTACTO']), toStr(r['RESULTADO DE GESTIÓN']), toStr(r['PRODUCTO INTERÉS']),
    toStr(r['MOTIVO INTERÉS']), toStr(r['MOTIVO AGENDAMIENTO']), toStr(r['FECHA DE INTERÉS AGENDAMIENTO']),
    toStr(r['HORA APROXIMADA INTERÉS AGENDAMIENTO']), toStr(r['COMENTARIO ADICIONAL AGENDAMIENTO']),
    toStr(r['FECHA DE INTERÉS DERIVACIÓN']), toStr(r['HORA APROXIMADA INTERÉS DERIVACIÓN']),
    toStr(r['COMENTARIO ADICIONAL DERIVACIÓN']), toStr(r['MOTIVO NO INTERÉS']), toStr(r['COMENTARIO ADICIONAL NO INTERÉS']),
    toStr(r['MOTIVO NO ATENDIBLE']), toStr(r['COMENTARIO ADICIONAL NO ATENDIBLE']), toStr(r['MOTIVOS TERCERO RELACIONADO']),
    toStr(r['FECHA DE RE-LLAMADA']), toStr(r['HORA DE RELLAMADA']), toStr(r['NÚMERO TITULAR ACTUAL']),
    toStr(r['MOTIVO NO CONTACTO']), toStr(r['MOTIVO DE NO CIERRE']), toStr(r['COMENTARIO VENTA NO CONCRETADA']),
    origen,
  ];
}

// Fila de la BD → objeto con las MISMAS cabeceras de la hoja (para los consumidores).
function grzRowToSheet(row) {
  return {
    id: row.id,
    'Marca temporal': row.marca_temporal_raw || '',
    'ASESOR REALZZA': row.asesor_realzza || '',
    'SEDE': row.sede || '',
    'TIPO DE BASE': row.tipo_base || '',
    'DNI CLIENTE': row.dni_cliente || '',
    'CELULAR GESTIONADO': row.celular_gestionado || '',
    'ESTADO DE GESTIÓN': row.estado_gestion || '',
    'MEDIO DE PRIMER CONTACTO': row.medio_primer_contacto || '',
    'RESULTADO DE GESTIÓN': row.resultado_gestion || '',
    'PRODUCTO INTERÉS': row.producto_interes || '',
    'MOTIVO INTERÉS': row.motivo_interes || '',
    'MOTIVO AGENDAMIENTO': row.motivo_agendamiento || '',
    'FECHA DE INTERÉS AGENDAMIENTO': row.fecha_interes_agendamiento || '',
    'HORA APROXIMADA INTERÉS AGENDAMIENTO': row.hora_interes_agendamiento || '',
    'COMENTARIO ADICIONAL AGENDAMIENTO': row.comentario_agendamiento || '',
    'FECHA DE INTERÉS DERIVACIÓN': row.fecha_interes_derivacion || '',
    'HORA APROXIMADA INTERÉS DERIVACIÓN': row.hora_interes_derivacion || '',
    'COMENTARIO ADICIONAL DERIVACIÓN': row.comentario_derivacion || '',
    'MOTIVO NO INTERÉS': row.motivo_no_interes || '',
    'COMENTARIO ADICIONAL NO INTERÉS': row.comentario_no_interes || '',
    'MOTIVO NO ATENDIBLE': row.motivo_no_atendible || '',
    'COMENTARIO ADICIONAL NO ATENDIBLE': row.comentario_no_atendible || '',
    'MOTIVOS TERCERO RELACIONADO': row.motivos_tercero_relacionado || '',
    'FECHA DE RE-LLAMADA': row.fecha_rellamada || '',
    'HORA DE RELLAMADA': row.hora_rellamada || '',
    'NÚMERO TITULAR ACTUAL': row.numero_titular_actual || '',
    'MOTIVO NO CONTACTO': row.motivo_no_contacto || '',
    'MOTIVO DE NO CIERRE': row.motivo_no_cierre || '',
    'COMENTARIO VENTA NO CONCRETADA': row.comentario_venta_no_concretada || '',
  };
}

// (Removido) La gestión Realzza ya NO se migra desde Google Sheets: se registra
// directo en la BD (tabla gestion_realzza, POST /gestion-realzza) y se lee de ahí.

// ─────────────────────────────────────────────────────────────────────────────
// 🏬 GESTIÓN SEDES — DERIVACIÓN (Lambayeque / Ferreñafe) → tabla `gestion_sedes_deriv`
// Formulario de Google independiente; se sincroniza a la BD para poder cruzarlo con
// `ventas` en la atribución de sedes (mismo cruce por DNI que Call/Realzza).
// ─────────────────────────────────────────────────────────────────────────────
const SD_COLS = [
  'marca_temporal', 'marca_temporal_raw', 'sede', 'asesor_lambayeque', 'asesor_ferrenafe',
  'dni_cliente', 'celular_gestionado', 'tipo_base', 'tipo_cliente', 'estado_gestion',
  'medio_primer_contacto', 'resultado_gestion', 'producto_interes', 'motivo_interes',
  'fecha_interes_derivacion', 'hora_interes_derivacion', 'comentario_derivacion',
];
let sdSchemaLista = false;
async function ensureGestionSedesDerivSchema() {
  if (!pgPool || sdSchemaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS gestion_sedes_deriv (
      id                    BIGSERIAL PRIMARY KEY,
      marca_temporal        TIMESTAMP,
      marca_temporal_raw    TEXT,
      sede                  TEXT,
      asesor_lambayeque     TEXT,
      asesor_ferrenafe      TEXT,
      dni_cliente           TEXT,
      celular_gestionado    TEXT,
      tipo_base             TEXT,
      tipo_cliente          TEXT,
      estado_gestion        TEXT,
      medio_primer_contacto TEXT,
      resultado_gestion     TEXT,
      producto_interes      TEXT,
      motivo_interes        TEXT,
      fecha_interes_derivacion TEXT,
      hora_interes_derivacion  TEXT,
      comentario_derivacion    TEXT,
      creado_en             TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_gsd_dni   ON gestion_sedes_deriv (dni_cliente);
    CREATE INDEX IF NOT EXISTS ix_gsd_marca ON gestion_sedes_deriv (marca_temporal);
    -- origen: 'sheet' (importado del formulario, se re-sincroniza) | 'app' (registrado por plataforma, se conserva).
    ALTER TABLE gestion_sedes_deriv ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'sheet';
    -- hash de la fila del formulario → el sync solo AGREGA lo nuevo (no borra ni duplica).
    ALTER TABLE gestion_sedes_deriv ADD COLUMN IF NOT EXISTS hash_row TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_gsd_hash ON gestion_sedes_deriv (hash_row) WHERE hash_row IS NOT NULL;
  `);
  sdSchemaLista = true;
}
async function leerSedesDerivSheet() {
  const config = sheetsConfigs['sedesDeriv'];
  const auth = googleAuthConfigs[config.authKey];
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range: config.range });
  const rows = resp.data.values || [];
  if (rows.length < 2) return [];
  const [headersRaw, ...data] = rows;
  const seen = {}; const H = [];
  headersRaw.forEach(h => { if (!seen[h]) { seen[h] = 1; H.push(h); } else { H.push(`${h} (${seen[h]})`); seen[h]++; } });
  return data.map(row => H.reduce((acc, h, i) => { acc[h] = row[i] || ''; return acc; }, {}));
}
function mapSedesDerivRow(r) {
  return [
    parseMarcaTemporal(r['Marca temporal']),
    toStr(r['Marca temporal']),
    toStr(r['SEDE']),
    toStr(r['ASESOR LAMBAYEQUE']),
    toStr(r['ASESOR FERREÑAFE']),
    toStr(r['DNI CLIENTE']),
    toStr(r['CELULAR GESTIONADO']),
    toStr(r['TIPO DE BASE']),
    toStr(r['TIPO DE CLIENTE']),
    toStr(r['ESTADO DE GESTIÓN']),
    toStr(r['MEDIO DE PRIMER CONTACTO']),
    toStr(r['RESULTADO DE GESTIÓN']),
    toStr(r['PRODUCTO INTERÉS']),
    toStr(r['MOTIVO INTERÉS']),
    toStr(r['FECHA DE INTERÉS DERIVACIÓN']),
    toStr(r['HORA APROXIMADA INTERÉS DERIVACIÓN']),
    toStr(r['COMENTARIO ADICIONAL DERIVACIÓN']),
  ];
}
// POST /gestion-sedes-deriv/sync — reemplaza toda la tabla con lo que hay en el sheet.
app.post('/gestion-sedes-deriv/sync', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionSedesDerivSchema();
    const data = await leerSedesDerivSheet();
    const filas = data.filter(r =>
      (r['Marca temporal'] || '').toString().trim() !== '' || (r['DNI CLIENTE'] || '').toString().trim() !== '');
    const crypto = require('crypto');
    const hashDeriv = (r) => crypto.createHash('sha1').update([
      toStr(r['Marca temporal']), toStr(r['DNI CLIENTE']),
      toStr(r['ASESOR LAMBAYEQUE']) || toStr(r['ASESOR FERREÑAFE']),
      toStr(r['MOTIVO INTERÉS']), toStr(r['CELULAR GESTIONADO']),
    ].join('|')).digest('hex');
    const cols = [...SD_COLS, 'hash_row'];
    const client = await pgPool.connect();
    let insertados = 0;
    try {
      // Limpieza puntual de filas 'sheet' legado sin hash (para pasar al modo aditivo).
      // Las registradas por plataforma (origen 'app') NUNCA se tocan.
      await client.query(`DELETE FROM gestion_sedes_deriv WHERE origen = 'sheet' AND hash_row IS NULL`);
      const CHUNK = 500;
      for (let i = 0; i < filas.length; i += CHUNK) {
        const chunk = filas.slice(i, i + CHUNK);
        const params = [];
        const tuples = chunk.map((r, idx) => {
          const arr = [...mapSedesDerivRow(r), hashDeriv(r)];
          const base = idx * cols.length;
          params.push(...arr);
          return '(' + cols.map((_, j) => `$${base + j + 1}`).join(',') + ')';
        });
        const rr = await client.query(
          `INSERT INTO gestion_sedes_deriv (${cols.join(',')}) VALUES ${tuples.join(',')}
           ON CONFLICT (hash_row) WHERE hash_row IS NOT NULL DO NOTHING`, params);
        insertados += rr.rowCount;
      }
    } finally { client.release(); }
    res.json({ success: true, leidas: data.length, insertados });
  } catch (e) {
    console.error('❌ POST /gestion-sedes-deriv/sync:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /gestion-sedes-deriv?asesor=&sede=&desde=&hasta= — lista derivaciones (para Mi Panel).
app.get('/gestion-sedes-deriv', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionSedesDerivSchema();
    res.set('Cache-Control', 'no-store');
    const FECHA = `COALESCE(marca_temporal, creado_en AT TIME ZONE 'America/Lima')`;
    const cond = [], params = [];
    if (req.query.asesor) {
      params.push(String(req.query.asesor).trim());
      cond.push(`(upper(trim(asesor_ferrenafe)) = upper(trim($${params.length})) OR upper(trim(asesor_lambayeque)) = upper(trim($${params.length})))`);
    }
    if (req.query.sede)  { params.push(`%${String(req.query.sede)}%`); cond.push(`sede ILIKE $${params.length}`); }
    if (req.query.desde) { params.push(String(req.query.desde)); cond.push(`${FECHA}::date >= $${params.length}`); }
    if (req.query.hasta) { params.push(String(req.query.hasta)); cond.push(`${FECHA}::date <= $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(
      `SELECT id, to_char(${FECHA}, 'DD/MM/YYYY HH24:MI:SS') AS marca, sede,
              COALESCE(NULLIF(asesor_ferrenafe,''), asesor_lambayeque) AS asesor,
              dni_cliente, celular_gestionado, tipo_base, tipo_cliente, producto_interes, motivo_interes,
              fecha_interes_derivacion, hora_interes_derivacion, comentario_derivacion, origen
       FROM gestion_sedes_deriv ${where} ORDER BY ${FECHA} DESC`, params);
    res.json(rows);
  } catch (e) { console.error('❌ GET /gestion-sedes-deriv:', e); res.status(500).json({ success: false, message: e.message }); }
});

// POST /gestion-sedes-deriv — registro de una derivación de venta desde la plataforma
// (origen 'app', se conserva al re-sincronizar). El asesor va a la columna de su sede.
app.post('/gestion-sedes-deriv', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const b = req.body || {};
  const sede = toStr(b.sede);
  const asesor = toStr(b.asesor);
  if (!sede || !asesor || !toStr(b.dni_cliente)) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (sede, asesor, dni_cliente).' });
  }
  try {
    await ensureGestionSedesDerivSchema();
    const esFerre = sede.toUpperCase().includes('FERRE');
    const t = ahoraLima();   // hora Lima (marca_temporal = t.ts, NO `new Date()` UTC → evitaba el +5h)
    const vals = [
      t.ts, t.raw, sede,
      esFerre ? '' : asesor,   // asesor_lambayeque
      esFerre ? asesor : '',   // asesor_ferrenafe
      toStr(b.dni_cliente), toStr(b.celular_gestionado), toStr(b.tipo_base), toStr(b.tipo_cliente),
      toStr(b.estado_gestion), toStr(b.medio_primer_contacto), toStr(b.resultado_gestion),
      toStr(b.producto_interes), (toStr(b.motivo_interes) || 'VENTA DERIVADA PARA CIERRE A SEDE'),
      toStr(b.fecha_interes_derivacion), toStr(b.hora_interes_derivacion), toStr(b.comentario_derivacion),
      'app',
    ];
    const cols = [...SD_COLS, 'origen'];
    const { rows } = await pgPool.query(
      `INSERT INTO gestion_sedes_deriv (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
    res.json({ success: true, id: rows[0].id });
  } catch (e) { console.error('❌ POST /gestion-sedes-deriv:', e); res.status(500).json({ success: false, message: e.message }); }
});

// PUT /gestion-sedes-deriv/:id — editar una derivación (persiste en BD). El asesor va a la
// columna de su sede (Ferreñafe → asesor_ferrenafe, resto → asesor_lambayeque).
app.put('/gestion-sedes-deriv/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const id = String(req.params.id || '').trim();
  const b = req.body || {};
  if (!id) return res.status(400).json({ success: false, message: 'Falta id.' });
  try {
    await ensureGestionSedesDerivSchema();
    const sede = toStr(b.sede);
    const asesor = toStr(b.asesor);
    const esFerre = sede.toUpperCase().includes('FERRE');
    // Solo se editan las columnas visibles del módulo; estado_gestion / medio_primer_contacto /
    // resultado_gestion se conservan intactos (no se sobreescriben para no borrarlos).
    const { rowCount } = await pgPool.query(
      `UPDATE gestion_sedes_deriv SET
         sede = $2, asesor_lambayeque = $3, asesor_ferrenafe = $4,
         dni_cliente = $5, celular_gestionado = $6, tipo_base = $7, tipo_cliente = $8,
         producto_interes = $9, motivo_interes = $10,
         fecha_interes_derivacion = $11, hora_interes_derivacion = $12, comentario_derivacion = $13
       WHERE id = $1`,
      [id, sede, esFerre ? '' : asesor, esFerre ? asesor : '',
       toStr(b.dni_cliente), toStr(b.celular_gestionado), toStr(b.tipo_base), toStr(b.tipo_cliente),
       toStr(b.producto_interes), toStr(b.motivo_interes),
       toStr(b.fecha_interes_derivacion), toStr(b.hora_interes_derivacion), toStr(b.comentario_derivacion)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'No existe la derivación.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /gestion-sedes-deriv/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /gestion-sedes-deriv/:id — elimina una derivación de la BD.
app.delete('/gestion-sedes-deriv/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ success: false, message: 'Falta id.' });
  try {
    await ensureGestionSedesDerivSchema();
    const { rowCount } = await pgPool.query(`DELETE FROM gestion_sedes_deriv WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'No existe la derivación.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /gestion-sedes-deriv/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// 👥 MAESTRO CAP (asesores por sede) — migrado de la hoja "CAP" a Postgres.
// Tabla cap_asesores editable (alta/baja/edición) desde el módulo "Maestro CAP".
// Fuente única del roster: CapSedesService ahora lee GET /cap (no la hoja).
// ═════════════════════════════════════════════════════════════════════════════
const CAP_COLS = ['vendedor', 'sede', 'supervisor', 'gerente', 'zona', 'canal', 'estado', 'dni'];
let capSchemaLista = false;
async function ensureCapSchema() {
  if (!pgPool || capSchemaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS cap_asesores (
      id             BIGSERIAL PRIMARY KEY,
      vendedor       TEXT NOT NULL,
      sede           TEXT,
      supervisor     TEXT,
      gerente        TEXT,
      zona           TEXT,
      canal          TEXT,
      estado         TEXT NOT NULL DEFAULT 'ACTIVO',
      dni            TEXT,
      creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_cap_sede   ON cap_asesores (sede);
    CREATE INDEX IF NOT EXISTS ix_cap_estado ON cap_asesores (estado);
  `);
  capSchemaLista = true;
}
// Tablas maestras: cap_sedes (gerente/zona por sede) y cap_supervisores (por sede).
// Se auto-siembran desde cap_asesores la primera vez (migración transparente).
let capMaestrosLista = false;
async function ensureCapMaestros() {
  if (!pgPool || capMaestrosLista) return;
  await ensureCapSchema();
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS cap_sedes (
      id BIGSERIAL PRIMARY KEY,
      nombre TEXT NOT NULL UNIQUE,
      gerente TEXT, zona TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cap_supervisores (
      id BIGSERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      sede TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_capsup_sede ON cap_supervisores (sede);
    CREATE TABLE IF NOT EXISTS cap_gerentes (
      id BIGSERIAL PRIMARY KEY,
      nombre TEXT NOT NULL UNIQUE,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const sc = await pgPool.query('SELECT count(*)::int n FROM cap_sedes');
  if (sc.rows[0].n === 0) {
    await pgPool.query(`
      INSERT INTO cap_sedes (nombre, gerente, zona)
      SELECT sede, mode() WITHIN GROUP (ORDER BY NULLIF(gerente,'')),
                   mode() WITHIN GROUP (ORDER BY NULLIF(zona,''))
      FROM cap_asesores WHERE COALESCE(sede,'') <> '' GROUP BY sede
      ON CONFLICT (nombre) DO NOTHING`);
  }
  const vc = await pgPool.query('SELECT count(*)::int n FROM cap_supervisores');
  if (vc.rows[0].n === 0) {
    await pgPool.query(`
      INSERT INTO cap_supervisores (nombre, sede)
      SELECT DISTINCT supervisor, sede FROM cap_asesores WHERE COALESCE(supervisor,'') <> ''`);
  }
  const gc = await pgPool.query('SELECT count(*)::int n FROM cap_gerentes');
  if (gc.rows[0].n === 0) {
    await pgPool.query(`
      INSERT INTO cap_gerentes (nombre)
      SELECT DISTINCT gerente FROM cap_sedes WHERE COALESCE(gerente,'') <> ''
      ON CONFLICT (nombre) DO NOTHING`);
  }
  capMaestrosLista = true;
}
// Lee la hoja "CAP" (para la migración inicial).
async function leerCapSheet() {
  const config = sheetsConfigs['capSedes'];
  const auth = googleAuthConfigs[config.authKey];
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range: config.range });
  const rows = resp.data.values || [];
  if (rows.length < 2) return [];
  const [headersRaw, ...data] = rows;
  const seen = {}; const H = [];
  headersRaw.forEach(h => { if (!seen[h]) { seen[h] = 1; H.push(h); } else { H.push(`${h} (${seen[h]})`); seen[h]++; } });
  return data.map(row => H.reduce((acc, h, i) => { acc[h] = row[i] || ''; return acc; }, {}));
}
function mapCapRow(r) {
  return [
    toStr(r['VENDEDOR']), toStr(r['SEDE']), toStr(r['SUPERVISOR']),
    toStr(r['GERENTE DE TIENDA']), toStr(r['ZONA']), toStr(r['CANAL']),
    (toStr(r['ESTADO']) || 'ACTIVO'), toStr(r['DNI']),
  ];
}

// POST /cap/sync — migración/refresco: reemplaza la tabla con lo que hay en la hoja CAP.
app.post('/cap/sync', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapSchema();
    const data = await leerCapSheet();
    const filas = data.filter(r => (r['VENDEDOR'] || '').toString().trim() !== '');
    const client = await pgPool.connect();
    let insertados = 0;
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE cap_asesores RESTART IDENTITY');
      const CHUNK = 500;
      for (let i = 0; i < filas.length; i += CHUNK) {
        const chunk = filas.slice(i, i + CHUNK);
        const params = [];
        const tuples = chunk.map((r, idx) => {
          const arr = mapCapRow(r);
          const base = idx * CAP_COLS.length;
          params.push(...arr);
          return '(' + CAP_COLS.map((_, j) => `$${base + j + 1}`).join(',') + ')';
        });
        await client.query(`INSERT INTO cap_asesores (${CAP_COLS.join(',')}) VALUES ${tuples.join(',')}`, params);
        insertados += chunk.length;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.json({ success: true, leidas: data.length, insertados });
  } catch (e) {
    console.error('❌ POST /cap/sync:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /cap?sede=&estado=&canal= — lista el CAP (fuente del CapSedesService).
app.get('/cap', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    res.set('Cache-Control', 'no-store');
    const cond = [], params = [];
    if (req.query.sede)   { params.push(`%${String(req.query.sede)}%`); cond.push(`a.sede ILIKE $${params.length}`); }
    if (req.query.estado) { params.push(String(req.query.estado).toUpperCase()); cond.push(`upper(a.estado) = $${params.length}`); }
    if (req.query.canal)  { params.push(`%${String(req.query.canal)}%`); cond.push(`a.canal ILIKE $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    // gerente/zona vienen del maestro de sedes (autoritativo); si la sede no está en el
    // maestro, se cae al valor propio del asesor.
    const { rows } = await pgPool.query(
      `SELECT a.id, a.vendedor, a.sede, a.supervisor,
              COALESCE(NULLIF(s.gerente,''), a.gerente) AS gerente,
              COALESCE(NULLIF(s.zona,''),    a.zona)    AS zona,
              a.canal, a.estado, a.dni
       FROM cap_asesores a
       LEFT JOIN cap_sedes s ON upper(trim(s.nombre)) = upper(trim(a.sede))
       ${where} ORDER BY a.sede NULLS LAST, a.vendedor`, params);
    res.json(rows);
  } catch (e) { console.error('❌ GET /cap:', e); res.status(500).json({ success: false, message: e.message }); }
});

// GET /cap/meta — catálogos para el formulario del Maestro CAP:
//   sedes:        [{ sede, gerente, zona }]  gerente/zona = el más frecuente de esa sede
//   supervisores: [{ sede, nombre }]         distinct por sede (para el select filtrado)
//   canales:      [ ... ]                     valores de canal existentes (como el sheet)
app.get('/cap/meta', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    res.set('Cache-Control', 'no-store');
    const sedes = await pgPool.query(`SELECT nombre AS sede, gerente, zona FROM cap_sedes ORDER BY nombre`);
    const sup = await pgPool.query(`SELECT id, sede, nombre FROM cap_supervisores ORDER BY sede, nombre`);
    const canales = await pgPool.query(`
      SELECT DISTINCT canal FROM cap_asesores WHERE COALESCE(canal,'') <> '' ORDER BY canal`);
    res.json({
      sedes: sedes.rows,
      supervisores: sup.rows,
      canales: canales.rows.map(r => r.canal),
    });
  } catch (e) { console.error('❌ GET /cap/meta:', e); res.status(500).json({ success: false, message: e.message }); }
});

// ── Maestro de SEDES (cap_sedes): gerente + zona por sede ──────────────────────
app.get('/cap/sedes', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros(); res.set('Cache-Control', 'no-store');
    const { rows } = await pgPool.query(`SELECT id, nombre, gerente, zona FROM cap_sedes ORDER BY nombre`);
    res.json(rows);
  } catch (e) { console.error('❌ GET /cap/sedes:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.post('/cap/sedes', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    const b = req.body || {};
    const nombre = String(b.nombre ?? '').trim();
    if (!nombre) return res.status(400).json({ success: false, message: 'El nombre de la sede es obligatorio.' });
    const { rows } = await pgPool.query(
      `INSERT INTO cap_sedes (nombre, gerente, zona) VALUES ($1,$2,$3)
       ON CONFLICT (nombre) DO UPDATE SET gerente=EXCLUDED.gerente, zona=EXCLUDED.zona, actualizado_en=now()
       RETURNING id`,
      [nombre, String(b.gerente ?? '').trim(), String(b.zona ?? '').trim().toUpperCase()]);
    res.json({ success: true, id: rows[0].id });
  } catch (e) { console.error('❌ POST /cap/sedes:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.put('/cap/sedes/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    const b = req.body || {};
    const sets = [], vals = [];
    const add = (c, v, up = false) => { let s = String(v ?? '').trim(); if (up) s = s.toUpperCase(); vals.push(s); sets.push(`${c} = $${vals.length}`); };
    if (b.nombre  !== undefined) add('nombre', b.nombre);
    if (b.gerente !== undefined) add('gerente', b.gerente);
    if (b.zona    !== undefined) add('zona', b.zona, true);
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nada para actualizar.' });
    sets.push('actualizado_en = now()'); vals.push(parseInt(req.params.id, 10));
    const { rowCount } = await pgPool.query(`UPDATE cap_sedes SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Sede no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /cap/sedes/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.delete('/cap/sedes/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    const { rowCount } = await pgPool.query('DELETE FROM cap_sedes WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Sede no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /cap/sedes/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// ── Maestro de SUPERVISORES (cap_supervisores) por sede ────────────────────────
app.get('/cap/supervisores', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros(); res.set('Cache-Control', 'no-store');
    const cond = [], params = [];
    if (req.query.sede) { params.push(String(req.query.sede)); cond.push(`upper(trim(sede)) = upper(trim($${params.length}))`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(`SELECT id, nombre, sede FROM cap_supervisores ${where} ORDER BY sede, nombre`, params);
    res.json(rows);
  } catch (e) { console.error('❌ GET /cap/supervisores:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.post('/cap/supervisores', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    const b = req.body || {};
    const nombre = String(b.nombre ?? '').trim();
    if (!nombre) return res.status(400).json({ success: false, message: 'El nombre del supervisor es obligatorio.' });
    const { rows } = await pgPool.query(
      `INSERT INTO cap_supervisores (nombre, sede) VALUES ($1,$2) RETURNING id`,
      [nombre, String(b.sede ?? '').trim()]);
    res.json({ success: true, id: rows[0].id });
  } catch (e) { console.error('❌ POST /cap/supervisores:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.put('/cap/supervisores/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    const b = req.body || {};
    const sets = [], vals = [];
    const add = (c, v) => { vals.push(String(v ?? '').trim()); sets.push(`${c} = $${vals.length}`); };
    if (b.nombre !== undefined) add('nombre', b.nombre);
    if (b.sede   !== undefined) add('sede', b.sede);
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nada para actualizar.' });
    sets.push('actualizado_en = now()'); vals.push(parseInt(req.params.id, 10));
    const { rowCount } = await pgPool.query(`UPDATE cap_supervisores SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Supervisor no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /cap/supervisores/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.delete('/cap/supervisores/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    const { rowCount } = await pgPool.query('DELETE FROM cap_supervisores WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Supervisor no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /cap/supervisores/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// ── Maestro de GERENTES (cap_gerentes) — se eligen al editar una sede ──────────
app.get('/cap/gerentes', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros(); res.set('Cache-Control', 'no-store');
    const { rows } = await pgPool.query(`SELECT id, nombre FROM cap_gerentes ORDER BY nombre`);
    res.json(rows);
  } catch (e) { console.error('❌ GET /cap/gerentes:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.post('/cap/gerentes', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    const nombre = String((req.body || {}).nombre ?? '').trim();
    if (!nombre) return res.status(400).json({ success: false, message: 'El nombre del gerente es obligatorio.' });
    const { rows } = await pgPool.query(
      `INSERT INTO cap_gerentes (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET actualizado_en=now() RETURNING id`, [nombre]);
    res.json({ success: true, id: rows[0].id });
  } catch (e) { console.error('❌ POST /cap/gerentes:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.put('/cap/gerentes/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    const nombre = String((req.body || {}).nombre ?? '').trim();
    if (!nombre) return res.status(400).json({ success: false, message: 'El nombre del gerente es obligatorio.' });
    // Renombra el gerente y propaga a las sedes que lo tenían.
    const prev = await pgPool.query('SELECT nombre FROM cap_gerentes WHERE id=$1', [parseInt(req.params.id, 10)]);
    if (!prev.rowCount) return res.status(404).json({ success: false, message: 'Gerente no encontrado.' });
    await pgPool.query('UPDATE cap_gerentes SET nombre=$1, actualizado_en=now() WHERE id=$2', [nombre, parseInt(req.params.id, 10)]);
    await pgPool.query('UPDATE cap_sedes SET gerente=$1, actualizado_en=now() WHERE gerente=$2', [nombre, prev.rows[0].nombre]);
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /cap/gerentes/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.delete('/cap/gerentes/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapMaestros();
    const { rowCount } = await pgPool.query('DELETE FROM cap_gerentes WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Gerente no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /cap/gerentes/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// POST /cap — alta de un asesor.
app.post('/cap', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapSchema();
    const b = req.body || {};
    const vendedor = String(b.vendedor ?? '').trim();
    if (!vendedor) return res.status(400).json({ success: false, message: 'El nombre del asesor (vendedor) es obligatorio.' });
    const vals = [vendedor, String(b.sede ?? '').trim(), String(b.supervisor ?? '').trim(),
      String(b.gerente ?? '').trim(), String(b.zona ?? '').trim().toUpperCase(),
      String(b.canal ?? '').trim().toUpperCase(), (String(b.estado ?? '').trim().toUpperCase() || 'ACTIVO'),
      String(b.dni ?? '').trim()];
    const { rows } = await pgPool.query(
      `INSERT INTO cap_asesores (${CAP_COLS.join(',')}) VALUES (${CAP_COLS.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
    res.json({ success: true, id: rows[0].id });
  } catch (e) { console.error('❌ POST /cap:', e); res.status(500).json({ success: false, message: e.message }); }
});

// PUT /cap/:id — edición (solo los campos que llegan).
app.put('/cap/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapSchema();
    const b = req.body || {};
    const sets = [], vals = [];
    const add = (col, val, upper = false) => { let s = String(val ?? '').trim(); if (upper) s = s.toUpperCase(); vals.push(s); sets.push(`${col} = $${vals.length}`); };
    if (b.vendedor   !== undefined) add('vendedor', b.vendedor);
    if (b.sede       !== undefined) add('sede', b.sede);
    if (b.supervisor !== undefined) add('supervisor', b.supervisor);
    if (b.gerente    !== undefined) add('gerente', b.gerente);
    if (b.zona       !== undefined) add('zona', b.zona, true);
    if (b.canal      !== undefined) add('canal', b.canal, true);
    if (b.estado     !== undefined) add('estado', b.estado, true);
    if (b.dni        !== undefined) add('dni', b.dni);
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nada para actualizar.' });
    sets.push('actualizado_en = now()');
    vals.push(parseInt(req.params.id, 10));
    const { rowCount } = await pgPool.query(`UPDATE cap_asesores SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Asesor no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /cap/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /cap/:id — baja definitiva (para "renuncia" usar estado=RENUNCIA con PUT).
app.delete('/cap/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCapSchema();
    const { rowCount } = await pgPool.query('DELETE FROM cap_asesores WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Asesor no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /cap/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// GET /gestion-sedes-deriv/live — respuestas del formulario EN VIVO (lee la hoja, NO la BD).
// Lo usa ventas-service para cruzar la atribución de sedes directo del formulario, así no
// depende de re-sincronizar la tabla espejo.
app.get('/gestion-sedes-deriv/live', async (req, res) => {
  try {
    const data = await leerSedesDerivSheet();
    const out = data
      .filter(r => (r['DNI CLIENTE'] || '').toString().trim() !== '')
      .map(r => ({
        marca_temporal: parseMarcaTemporal(r['Marca temporal']),
        sede: toStr(r['SEDE']),
        dni_cliente: toStr(r['DNI CLIENTE']),
        tipo_base: toStr(r['TIPO DE BASE']),
        asesor: toStr(r['ASESOR LAMBAYEQUE']) || toStr(r['ASESOR FERREÑAFE']),
        motivo_interes: toStr(r['MOTIVO INTERÉS']),
      }));
    res.json(out);
  } catch (e) {
    console.error('❌ GET /gestion-sedes-deriv/live:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /gestion-realzza — registra una gestión nueva desde la app (origen = 'app').
app.post('/gestion-realzza', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const b = req.body || {};
  if (!b.asesor_realzza || !b.dni_cliente || !b.estado_gestion) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (asesor, dni, estado de gestión).' });
  }
  try {
    await ensureGestionRealzzaSchema();
    const t = ahoraLima();
    const valorDe = {
      marca_temporal: t.ts, marca_temporal_raw: t.raw, origen: 'app',
      asesor_realzza: b.asesor_realzza, sede: b.sede || 'REALZZA', tipo_base: b.tipo_base,
      dni_cliente: b.dni_cliente, celular_gestionado: b.celular_gestionado, estado_gestion: b.estado_gestion,
      medio_primer_contacto: b.medio_primer_contacto, resultado_gestion: b.resultado_gestion,
      producto_interes: b.producto_interes, motivo_interes: b.motivo_interes, motivo_agendamiento: b.motivo_agendamiento,
      fecha_interes_agendamiento: b.fecha_interes_agendamiento, hora_interes_agendamiento: b.hora_interes_agendamiento,
      comentario_agendamiento: b.comentario_agendamiento, fecha_interes_derivacion: b.fecha_interes_derivacion,
      hora_interes_derivacion: b.hora_interes_derivacion, comentario_derivacion: b.comentario_derivacion,
      motivo_no_interes: b.motivo_no_interes, comentario_no_interes: b.comentario_no_interes,
      motivo_no_atendible: b.motivo_no_atendible, comentario_no_atendible: b.comentario_no_atendible,
      motivos_tercero_relacionado: b.motivos_tercero_relacionado, fecha_rellamada: b.fecha_rellamada,
      hora_rellamada: b.hora_rellamada, numero_titular_actual: b.numero_titular_actual,
      motivo_no_contacto: b.motivo_no_contacto, motivo_no_cierre: b.motivo_no_cierre,
      comentario_venta_no_concretada: b.comentario_venta_no_concretada,
    };
    const params = GRZ_COLS.map(c => {
      const v = valorDe[c];
      return v === undefined || v === '' ? null : v;
    });
    const ph = GRZ_COLS.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pgPool.query(
      `INSERT INTO gestion_realzza (${GRZ_COLS.join(',')}) VALUES (${ph}) RETURNING id`, params);
    res.json({ success: true, id: rows[0].id, marca_temporal: valorDe.marca_temporal_raw });
  } catch (e) {
    console.error('❌ POST /gestion-realzza:', e);
    res.status(500).json({ success: false, message: 'No se pudo guardar la gestión.' });
  }
});

// Emite un array JSON en STREAMING por lotes (mapeando cada fila) sin materializar
// todo el array ni el string gigante en memoria → evita OOM con decenas de miles
// de filas. compression() lo gzipa al vuelo.
function streamJsonRows(res, rows, mapFn) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.write('[');
  let first = true; let buf = [];
  for (let i = 0; i < rows.length; i++) {
    buf.push(JSON.stringify(mapFn(rows[i])));
    if (buf.length >= 500) { res.write((first ? '' : ',') + buf.join(',')); first = false; buf = []; }
  }
  if (buf.length) res.write((first ? '' : ',') + buf.join(','));
  res.write(']');
  res.end();
}

// GET /gestion-realzza?desde=&hasta= — filas con las cabeceras de la hoja.
app.get('/gestion-realzza', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionRealzzaSchema();
    const cond = []; const params = [];
    if (req.query.desde) { params.push(`${req.query.desde} 00:00:00`); cond.push(`marca_temporal >= $${params.length}`); }
    if (req.query.hasta) { params.push(`${req.query.hasta} 23:59:59`); cond.push(`marca_temporal <= $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(
      `SELECT * FROM gestion_realzza ${where} ORDER BY marca_temporal DESC NULLS LAST`, params);
    streamJsonRows(res, rows, grzRowToSheet);
  } catch (e) {
    console.error('❌ GET /gestion-realzza:', e);
    res.status(500).json({ success: false, message: 'No se pudieron obtener las gestiones.' });
  }
});

// Mapa cabecera de hoja → columna BD (Realzza), para editar desde el grid.
const REALZZA_SHEET_TO_COL = {
  'ASESOR REALZZA': 'asesor_realzza', 'SEDE': 'sede', 'TIPO DE BASE': 'tipo_base', 'DNI CLIENTE': 'dni_cliente',
  'CELULAR GESTIONADO': 'celular_gestionado', 'ESTADO DE GESTIÓN': 'estado_gestion', 'MEDIO DE PRIMER CONTACTO': 'medio_primer_contacto',
  'RESULTADO DE GESTIÓN': 'resultado_gestion', 'PRODUCTO INTERÉS': 'producto_interes', 'MOTIVO INTERÉS': 'motivo_interes',
  'MOTIVO AGENDAMIENTO': 'motivo_agendamiento', 'FECHA DE INTERÉS AGENDAMIENTO': 'fecha_interes_agendamiento',
  'HORA APROXIMADA INTERÉS AGENDAMIENTO': 'hora_interes_agendamiento', 'COMENTARIO ADICIONAL AGENDAMIENTO': 'comentario_agendamiento',
  'FECHA DE INTERÉS DERIVACIÓN': 'fecha_interes_derivacion', 'HORA APROXIMADA INTERÉS DERIVACIÓN': 'hora_interes_derivacion',
  'COMENTARIO ADICIONAL DERIVACIÓN': 'comentario_derivacion', 'MOTIVO NO INTERÉS': 'motivo_no_interes',
  'COMENTARIO ADICIONAL NO INTERÉS': 'comentario_no_interes', 'MOTIVO NO ATENDIBLE': 'motivo_no_atendible',
  'COMENTARIO ADICIONAL NO ATENDIBLE': 'comentario_no_atendible', 'MOTIVOS TERCERO RELACIONADO': 'motivos_tercero_relacionado',
  'FECHA DE RE-LLAMADA': 'fecha_rellamada', 'HORA DE RELLAMADA': 'hora_rellamada', 'NÚMERO TITULAR ACTUAL': 'numero_titular_actual',
  'MOTIVO NO CONTACTO': 'motivo_no_contacto',
  'MOTIVO DE NO CIERRE': 'motivo_no_cierre', 'COMENTARIO VENTA NO CONCRETADA': 'comentario_venta_no_concretada',
};

// Construye SET clause aceptando claves de hoja o snake_case (no toca marca_temporal/origen/id).
function construirUpdate(body, sheetToCol, colsSnake) {
  const sets = [], params = [];
  for (const [k, v] of Object.entries(body || {})) {
    const col = sheetToCol[k] || (colsSnake.includes(k) ? k : null);
    if (!col || col === 'marca_temporal' || col === 'marca_temporal_raw' || col === 'origen') continue;
    params.push(v === '' ? null : v);
    sets.push(`${col} = $${params.length}`);
  }
  return { sets, params };
}

// PUT /gestion-realzza/:id — edita una gestión.
app.put('/gestion-realzza/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionRealzzaSchema();
    const { sets, params } = construirUpdate(req.body, REALZZA_SHEET_TO_COL, GRZ_COLS);
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nada para actualizar.' });
    params.push(parseInt(req.params.id, 10));
    const { rowCount } = await pgPool.query(`UPDATE gestion_realzza SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Gestión no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /gestion-realzza/:id', e); res.status(500).json({ success: false, message: 'No se pudo actualizar.' }); }
});

// DELETE /gestion-realzza/:id — elimina una gestión.
app.delete('/gestion-realzza/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionRealzzaSchema();
    const { rowCount } = await pgPool.query('DELETE FROM gestion_realzza WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Gestión no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /gestion-realzza/:id', e); res.status(500).json({ success: false, message: 'No se pudo eliminar.' }); }
});

// POST /gestion-realzza/match — { dnis: [...] } → { <dni>: {asesor, tipo_base, sede, celular} } (última gestión).
app.post('/gestion-realzza/match', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionRealzzaSchema();
    const dnis = Array.from(new Set((req.body?.dnis || []).map(d => String(d).replace(/\D/g, '').replace(/^0+/, '')).filter(Boolean)));
    if (!dnis.length) return res.json({});
    const { rows } = await pgPool.query(`
      SELECT DISTINCT ON (dnin) dnin, asesor_realzza, tipo_base, sede, celular_gestionado
      FROM (
        SELECT regexp_replace(regexp_replace(dni_cliente, '\\D', '', 'g'), '^0+', '') AS dnin,
               asesor_realzza, tipo_base, sede, celular_gestionado, marca_temporal
        FROM gestion_realzza
        WHERE regexp_replace(regexp_replace(dni_cliente, '\\D', '', 'g'), '^0+', '') = ANY($1)
      ) t
      ORDER BY dnin, marca_temporal DESC NULLS LAST
    `, [dnis]);
    const map = {};
    rows.forEach(r => { map[r.dnin] = { asesor: r.asesor_realzza || '', tipo_base: r.tipo_base || '', sede: r.sede || '', celular: r.celular_gestionado || '' }; });
    res.json(map);
  } catch (e) { console.error('❌ POST /gestion-realzza/match', e); res.status(500).json({ success: false, message: 'No se pudo hacer el match.' }); }
});

// Control Supervisor (control_supervisor) → movido a gestion-service (:4004).
// (Endpoints /control-supervisor → movidos a gestion-service.)

// ─────────────────────────────────────────────────────────────────────────────
// 📞 GESTIÓN CALL CENTER → PostgreSQL (Neon). Reemplaza el Google Form de call.
// Misma mecánica que gestión realzza (30 columnas del form + marca_temporal + origen).
// GET devuelve las MISMAS cabeceras de la hoja /data/call.
// ─────────────────────────────────────────────────────────────────────────────
const GC_COLS = [
  'marca_temporal', 'marca_temporal_raw', 'asesor_contact', 'dni_cliente', 'tipo_cliente',
  'estado_gestion', 'medio_primer_contacto', 'celular_gestionado', 'resultado_gestion',
  'producto_interes', 'motivo_interes', 'motivo_agendamiento', 'fecha_interes_agendamiento',
  'hora_interes_agendamiento', 'fecha_interes_derivacion', 'hora_interes_derivacion',
  'comentario_derivacion', 'comentario_agendamiento', 'motivo_no_interes', 'comentario_no_interes',
  'motivo_no_atendible', 'comentario_no_atendible', 'motivos_tercero_relacionado', 'fecha_rellamada',
  'hora_rellamada', 'numero_titular_actual', 'motivo_no_contacto', 'sede', 'kommo',
  'motivo_no_cierre', 'comentario_venta_no_concretada', 'origen',
];

let gcSchemaLista = false;
async function ensureGestionCallSchema() {
  if (!pgPool || gcSchemaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS gestion_call (
      id                             BIGSERIAL PRIMARY KEY,
      marca_temporal                 TIMESTAMP,
      marca_temporal_raw             TEXT,
      asesor_contact                 TEXT,
      dni_cliente                    TEXT,
      tipo_cliente                   TEXT,
      estado_gestion                 TEXT,
      medio_primer_contacto          TEXT,
      celular_gestionado             TEXT,
      resultado_gestion              TEXT,
      producto_interes               TEXT,
      motivo_interes                 TEXT,
      motivo_agendamiento            TEXT,
      fecha_interes_agendamiento     TEXT,
      hora_interes_agendamiento      TEXT,
      fecha_interes_derivacion       TEXT,
      hora_interes_derivacion        TEXT,
      comentario_derivacion          TEXT,
      comentario_agendamiento        TEXT,
      motivo_no_interes              TEXT,
      comentario_no_interes          TEXT,
      motivo_no_atendible            TEXT,
      comentario_no_atendible        TEXT,
      motivos_tercero_relacionado    TEXT,
      fecha_rellamada                TEXT,
      hora_rellamada                 TEXT,
      numero_titular_actual          TEXT,
      motivo_no_contacto             TEXT,
      sede                           TEXT,
      kommo                          TEXT,
      motivo_no_cierre               TEXT,
      comentario_venta_no_concretada TEXT,
      origen                         TEXT NOT NULL DEFAULT 'app',
      creado_en                      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_gc_marca  ON gestion_call (marca_temporal);
    CREATE INDEX IF NOT EXISTS ix_gc_asesor ON gestion_call (asesor_contact);
    CREATE INDEX IF NOT EXISTS ix_gc_dni    ON gestion_call (dni_cliente);
  `);
  gcSchemaLista = true;
}

function mapCallRow(r, origen) {
  return [
    parseMarcaTemporal(r['Marca temporal']), toStr(r['Marca temporal']),
    toStr(r['ASESOR CONTACT']), toStr(r['DNI CLIENTE']), toStr(r['TIPO DE CLIENTE']), toStr(r['ESTADO DE GESTIÓN']),
    toStr(r['MEDIO DE PRIMER CONTACTO']), toStr(r['CELULAR GESTIONADO']), toStr(r['RESULTADO DE GESTIÓN']),
    toStr(r['PRODUCTO INTERÉS']), toStr(r['MOTIVO INTERÉS']), toStr(r['MOTIVO AGENDAMIENTO']),
    toStr(r['FECHA DE INTERÉS AGENDAMIENTO']), toStr(r['HORA APROXIMADA INTERÉS AGENDAMIENTO']),
    toStr(r['FECHA DE INTERÉS DERIVACIÓN']), toStr(r['HORA APROXIMADA INTERÉS DERIVACIÓN']),
    toStr(r['COMENTARIO ADICIONAL DERIVACIÓN']), toStr(r['COMENTARIO ADICIONAL AGENDAMIENTO']),
    toStr(r['MOTIVO NO INTERÉS']), toStr(r['COMENTARIO ADICIONAL NO INTERES']),
    toStr(r['MOTIVO NO ATENDIBLE']), toStr(r['COMENTARIO ADICIONAL NO ATENDIBLE']),
    toStr(r['MOTIVOS TERCERO RELACIONADO']), toStr(r['FECHA DE RE-LLAMADA']), toStr(r['HORA DE RELLAMADA']),
    toStr(r['NÚMERO TITULAR ACTUAL']), toStr(r['MOTIVO NO CONTACTO']), toStr(r['SEDE']), toStr(r['KOMMO']),
    toStr(r['MOTIVO DE NO CIERRE']), toStr(r['COMENTARIO VENTA NO CONCRETADA']),
    origen,
  ];
}

function gcRowToSheet(row) {
  return {
    id: row.id,
    'Marca temporal': row.marca_temporal_raw || '',
    'ASESOR CONTACT': row.asesor_contact || '',
    'DNI CLIENTE': row.dni_cliente || '',
    'TIPO DE CLIENTE': row.tipo_cliente || '',
    'ESTADO DE GESTIÓN': row.estado_gestion || '',
    'MEDIO DE PRIMER CONTACTO': row.medio_primer_contacto || '',
    'CELULAR GESTIONADO': row.celular_gestionado || '',
    'RESULTADO DE GESTIÓN': row.resultado_gestion || '',
    'PRODUCTO INTERÉS': row.producto_interes || '',
    'MOTIVO INTERÉS': row.motivo_interes || '',
    'MOTIVO AGENDAMIENTO': row.motivo_agendamiento || '',
    'FECHA DE INTERÉS AGENDAMIENTO': row.fecha_interes_agendamiento || '',
    'HORA APROXIMADA INTERÉS AGENDAMIENTO': row.hora_interes_agendamiento || '',
    'FECHA DE INTERÉS DERIVACIÓN': row.fecha_interes_derivacion || '',
    'HORA APROXIMADA INTERÉS DERIVACIÓN': row.hora_interes_derivacion || '',
    'COMENTARIO ADICIONAL DERIVACIÓN': row.comentario_derivacion || '',
    'COMENTARIO ADICIONAL AGENDAMIENTO': row.comentario_agendamiento || '',
    'MOTIVO NO INTERÉS': row.motivo_no_interes || '',
    'COMENTARIO ADICIONAL NO INTERES': row.comentario_no_interes || '',
    'MOTIVO NO ATENDIBLE': row.motivo_no_atendible || '',
    'COMENTARIO ADICIONAL NO ATENDIBLE': row.comentario_no_atendible || '',
    'MOTIVOS TERCERO RELACIONADO': row.motivos_tercero_relacionado || '',
    'FECHA DE RE-LLAMADA': row.fecha_rellamada || '',
    'HORA DE RELLAMADA': row.hora_rellamada || '',
    'NÚMERO TITULAR ACTUAL': row.numero_titular_actual || '',
    'MOTIVO NO CONTACTO': row.motivo_no_contacto || '',
    'SEDE': row.sede || '',
    'KOMMO': row.kommo || '',
    'MOTIVO DE NO CIERRE': row.motivo_no_cierre || '',
    'COMENTARIO VENTA NO CONCRETADA': row.comentario_venta_no_concretada || '',
  };
}

// (Removido) La gestión Call ya NO se migra desde Google Sheets: se registra
// directo en la BD (tabla gestion_call, POST /gestion-call) y se lee de ahí.

app.post('/gestion-call', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const b = req.body || {};
  if (!b.asesor_contact || !b.dni_cliente || !b.estado_gestion) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (asesor, dni, estado de gestión).' });
  }
  try {
    await ensureGestionCallSchema();
    const t = ahoraLima();
    const valorDe = {
      marca_temporal: t.ts, marca_temporal_raw: t.raw, origen: 'app',
      asesor_contact: b.asesor_contact, dni_cliente: b.dni_cliente, tipo_cliente: b.tipo_cliente,
      estado_gestion: b.estado_gestion, medio_primer_contacto: b.medio_primer_contacto,
      celular_gestionado: b.celular_gestionado, resultado_gestion: b.resultado_gestion,
      producto_interes: b.producto_interes, motivo_interes: b.motivo_interes, motivo_agendamiento: b.motivo_agendamiento,
      fecha_interes_agendamiento: b.fecha_interes_agendamiento, hora_interes_agendamiento: b.hora_interes_agendamiento,
      fecha_interes_derivacion: b.fecha_interes_derivacion, hora_interes_derivacion: b.hora_interes_derivacion,
      comentario_derivacion: b.comentario_derivacion, comentario_agendamiento: b.comentario_agendamiento,
      motivo_no_interes: b.motivo_no_interes, comentario_no_interes: b.comentario_no_interes,
      motivo_no_atendible: b.motivo_no_atendible, comentario_no_atendible: b.comentario_no_atendible,
      motivos_tercero_relacionado: b.motivos_tercero_relacionado, fecha_rellamada: b.fecha_rellamada,
      hora_rellamada: b.hora_rellamada, numero_titular_actual: b.numero_titular_actual,
      motivo_no_contacto: b.motivo_no_contacto, sede: b.sede, kommo: b.kommo,
      motivo_no_cierre: b.motivo_no_cierre, comentario_venta_no_concretada: b.comentario_venta_no_concretada,
    };
    const params = GC_COLS.map(c => { const v = valorDe[c]; return v === undefined || v === '' ? null : v; });
    const ph = GC_COLS.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pgPool.query(`INSERT INTO gestion_call (${GC_COLS.join(',')}) VALUES (${ph}) RETURNING id`, params);
    res.json({ success: true, id: rows[0].id, marca_temporal: valorDe.marca_temporal_raw });
  } catch (e) { console.error('❌ POST /gestion-call:', e); res.status(500).json({ success: false, message: 'No se pudo guardar la gestión.' }); }
});

app.get('/gestion-call', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionCallSchema();
    const cond = []; const params = [];
    if (req.query.desde) { params.push(`${req.query.desde} 00:00:00`); cond.push(`marca_temporal >= $${params.length}`); }
    if (req.query.hasta) { params.push(`${req.query.hasta} 23:59:59`); cond.push(`marca_temporal <= $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(`SELECT * FROM gestion_call ${where} ORDER BY marca_temporal DESC NULLS LAST`, params);
    streamJsonRows(res, rows, gcRowToSheet);
  } catch (e) { console.error('❌ GET /gestion-call:', e); res.status(500).json({ success: false, message: 'No se pudieron obtener las gestiones.' }); }
});

// Mapa cabecera de hoja → columna BD (Call), para editar desde el grid.
const CALL_SHEET_TO_COL = {
  'ASESOR CONTACT': 'asesor_contact', 'DNI CLIENTE': 'dni_cliente', 'TIPO DE CLIENTE': 'tipo_cliente',
  'ESTADO DE GESTIÓN': 'estado_gestion', 'MEDIO DE PRIMER CONTACTO': 'medio_primer_contacto', 'CELULAR GESTIONADO': 'celular_gestionado',
  'RESULTADO DE GESTIÓN': 'resultado_gestion', 'PRODUCTO INTERÉS': 'producto_interes', 'MOTIVO INTERÉS': 'motivo_interes',
  'MOTIVO AGENDAMIENTO': 'motivo_agendamiento', 'FECHA DE INTERÉS AGENDAMIENTO': 'fecha_interes_agendamiento',
  'HORA APROXIMADA INTERÉS AGENDAMIENTO': 'hora_interes_agendamiento', 'FECHA DE INTERÉS DERIVACIÓN': 'fecha_interes_derivacion',
  'HORA APROXIMADA INTERÉS DERIVACIÓN': 'hora_interes_derivacion', 'COMENTARIO ADICIONAL DERIVACIÓN': 'comentario_derivacion',
  'COMENTARIO ADICIONAL AGENDAMIENTO': 'comentario_agendamiento', 'MOTIVO NO INTERÉS': 'motivo_no_interes',
  'COMENTARIO ADICIONAL NO INTERES': 'comentario_no_interes', 'MOTIVO NO ATENDIBLE': 'motivo_no_atendible',
  'COMENTARIO ADICIONAL NO ATENDIBLE': 'comentario_no_atendible', 'MOTIVOS TERCERO RELACIONADO': 'motivos_tercero_relacionado',
  'FECHA DE RE-LLAMADA': 'fecha_rellamada', 'HORA DE RELLAMADA': 'hora_rellamada', 'NÚMERO TITULAR ACTUAL': 'numero_titular_actual',
  'MOTIVO NO CONTACTO': 'motivo_no_contacto', 'SEDE': 'sede', 'KOMMO': 'kommo',
  'MOTIVO DE NO CIERRE': 'motivo_no_cierre', 'COMENTARIO VENTA NO CONCRETADA': 'comentario_venta_no_concretada',
};

// PUT /gestion-call/:id — edita una gestión.
app.put('/gestion-call/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionCallSchema();
    const { sets, params } = construirUpdate(req.body, CALL_SHEET_TO_COL, GC_COLS);
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nada para actualizar.' });
    params.push(parseInt(req.params.id, 10));
    const { rowCount } = await pgPool.query(`UPDATE gestion_call SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Gestión no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /gestion-call/:id', e); res.status(500).json({ success: false, message: 'No se pudo actualizar.' }); }
});

// DELETE /gestion-call/:id — elimina una gestión.
app.delete('/gestion-call/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionCallSchema();
    const { rowCount } = await pgPool.query('DELETE FROM gestion_call WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Gestión no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /gestion-call/:id', e); res.status(500).json({ success: false, message: 'No se pudo eliminar.' }); }
});

// POST /gestion-call/migrar-brenda-realzza?key=brenda-sep-2026 — migración one-shot.
// Mueve las gestiones de BRENDA (BERNAL BAZAN BRENDA) de gestion_call → gestion_realzza
// para septiembre-2026 en adelante (su pase de canal). Transaccional e idempotente:
// solo mueve las filas que sigan en gestion_call. tipo_cliente → tipo_base; kommo se
// descarta (no existe en Realzza). asesor_contact → asesor_realzza.
app.post('/gestion-call/migrar-brenda-realzza', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  if (req.query.key !== 'brenda-sep-2026') return res.status(403).json({ success: false, message: 'Clave inválida.' });
  const cliente = await pgPool.connect();
  try {
    await ensureGestionCallSchema();
    await ensureGestionRealzzaSchema();
    const WHERE = `asesor_contact ILIKE '%BERNAL BAZAN BRENDA%'
      AND marca_temporal >= '2026-09-01' AND marca_temporal < '2026-10-01'`;
    await cliente.query('BEGIN');
    const antes = await cliente.query(`SELECT COUNT(*)::int AS n FROM gestion_call WHERE ${WHERE}`);
    const ins = await cliente.query(`
      INSERT INTO gestion_realzza (
        marca_temporal, marca_temporal_raw, asesor_realzza, sede, tipo_base,
        dni_cliente, celular_gestionado, estado_gestion, medio_primer_contacto,
        resultado_gestion, producto_interes, motivo_interes, motivo_agendamiento,
        fecha_interes_agendamiento, hora_interes_agendamiento, comentario_agendamiento,
        fecha_interes_derivacion, hora_interes_derivacion, comentario_derivacion,
        motivo_no_interes, comentario_no_interes, motivo_no_atendible, comentario_no_atendible,
        motivos_tercero_relacionado, fecha_rellamada, hora_rellamada, numero_titular_actual,
        motivo_no_contacto, motivo_no_cierre, comentario_venta_no_concretada, origen)
      SELECT
        marca_temporal, marca_temporal_raw, asesor_contact, sede, tipo_cliente,
        dni_cliente, celular_gestionado, estado_gestion, medio_primer_contacto,
        resultado_gestion, producto_interes, motivo_interes, motivo_agendamiento,
        fecha_interes_agendamiento, hora_interes_agendamiento, comentario_agendamiento,
        fecha_interes_derivacion, hora_interes_derivacion, comentario_derivacion,
        motivo_no_interes, comentario_no_interes, motivo_no_atendible, comentario_no_atendible,
        motivos_tercero_relacionado, fecha_rellamada, hora_rellamada, numero_titular_actual,
        motivo_no_contacto, motivo_no_cierre, comentario_venta_no_concretada, COALESCE(origen,'app')
      FROM gestion_call WHERE ${WHERE}`);
    const del = await cliente.query(`DELETE FROM gestion_call WHERE ${WHERE}`);
    await cliente.query('COMMIT');
    res.json({ success: true, encontradas: antes.rows[0].n, insertadas: ins.rowCount, eliminadas: del.rowCount });
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    console.error('❌ POST /gestion-call/migrar-brenda-realzza', e);
    res.status(500).json({ success: false, message: 'No se pudo migrar.' });
  } finally { cliente.release(); }
});

// POST /gestion-call/match — { dnis: [...] } → { <dni>: {asesor, tipo_cliente, sede, kommo, celular} }
// Devuelve la ÚLTIMA gestión Call de cada DNI (para atribuir las ventas del Excel).
app.post('/gestion-call/match', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionCallSchema();
    const dnis = Array.from(new Set((req.body?.dnis || []).map(d => String(d).replace(/\D/g, '').replace(/^0+/, '')).filter(Boolean)));
    if (!dnis.length) return res.json({});
    const { rows } = await pgPool.query(`
      SELECT DISTINCT ON (dnin) dnin, asesor_contact, tipo_cliente, sede, kommo, celular_gestionado
      FROM (
        SELECT regexp_replace(regexp_replace(dni_cliente, '\\D', '', 'g'), '^0+', '') AS dnin,
               asesor_contact, tipo_cliente, sede, kommo, celular_gestionado, marca_temporal
        FROM gestion_call
        WHERE regexp_replace(regexp_replace(dni_cliente, '\\D', '', 'g'), '^0+', '') = ANY($1)
      ) t
      ORDER BY dnin, marca_temporal DESC NULLS LAST
    `, [dnis]);
    const map = {};
    rows.forEach(r => { map[r.dnin] = { asesor: r.asesor_contact || '', tipo_cliente: r.tipo_cliente || '', sede: r.sede || '', kommo: r.kommo || '', celular: r.celular_gestionado || '' }; });
    res.json(map);
  } catch (e) { console.error('❌ POST /gestion-call/match', e); res.status(500).json({ success: false, message: 'No se pudo hacer el match.' }); }
});

// (Unificado) Sin app.listen: el servidor unificado (server.js) escucha en un solo
// puerto. Se conserva la inicialización de esquemas al cargar el módulo.
Promise.all([ensureUsuariosSchema(), ensurePermisosSchema(), ensureGestionRealzzaSchema(), ensureGestionCallSchema()])
  .then(async () => {
    if (!pgPool) return;
    console.log('🐘 [sheets] Esquemas verificados (usuarios, permisos, gestión realzza, gestión call).');
    await migrarUsuariosDesdeSheet();
  })
  .catch((e) => console.error('❌ [sheets] No se pudo verificar el esquema:', e));

module.exports = app;
