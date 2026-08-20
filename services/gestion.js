// ─────────────────────────────────────────────────────────────────────────────
// gestion-service — Microservicio Leoncito
// Extraído de sheets-api (strangler-fig). Bloque "gestión en BD" (Postgres/Neon):
//   • Registro de Gestión   → POST /gestion
//   • Control Supervisor     → POST/GET/PUT/DELETE /control-supervisor  (incl. fotos base64)
// Misma BD y mismas tablas (gestion, control_supervisor) que usaba el monolito.
// Timezone: marca_temporal se guarda como hora de Lima (ahoraLima), igual que antes.
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4004;

app.use(compression());   // gzip: comprime las respuestas JSON (5-10× menos bytes)
app.use(cors());
// Límite alto: el control del supervisor trae fotos en base64.
app.use(express.json({ limit: '20mb' }));

const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ── Helpers compartidos (portados idénticos del monolito) ────────────────────
// Fecha/hora actual en America/Lima como string (no se convierte a UTC al insertar).
function ahoraLima() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = {};
  for (const x of parts) if (x.type !== 'literal') p[x.type] = x.value;
  const hh = p.hour === '24' ? '00' : p.hour;
  return {
    ts: `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`,
    raw: `${+p.day}/${+p.month}/${+p.year} ${+hh}:${p.minute}:${p.second}`,
  };
}

// Construye el SET de un UPDATE a partir del body (ignora marca_temporal/id).
function construirUpdate(body, sheetToCol, colsSnake) {
  const sets = [], params = [];
  for (const [k, v] of Object.entries(body || {})) {
    const col = sheetToCol[k] || (colsSnake.includes(k) ? k : null);
    if (!col || col === 'marca_temporal' || col === 'marca_temporal_raw' || col === 'origen' || col === 'fotos') continue;
    params.push(v === '' ? null : v);
    sets.push(`${col} = $${params.length}`);
  }
  return { sets, params };
}

// La columna `fotos` guarda un JSON array. Tras migrar a Storage son RUTAS del bucket
// (p.ej. "123/0.jpg"); las filas antiguas podrían tener aún data-URIs base64.
function parseFotos(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

// ── Supabase Storage (fotos del supervisor, bucket privado) ──────────────────
// En la BD `fotos` guarda RUTAS; al leer se devuelven URLs firmadas (temporales).
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const FOTOS_BUCKET = 'supervisor-fotos';
const storageOn = () => !!(SB_URL && SB_KEY);
const sbHeaders = (extra = {}) => ({ Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY, ...extra });

// Sube un data-URI base64 y devuelve su ruta en el bucket. Si no es base64 o no hay
// Storage configurado, devuelve el valor tal cual (compatibilidad hacia atrás).
async function subirFoto(dataUri, id, i) {
  if (typeof dataUri !== 'string' || !dataUri.startsWith('data:') || !storageOn()) return dataUri;
  const m = /^data:(image\/\w+);base64,(.*)$/s.exec(dataUri);
  if (!m) return dataUri;
  const mime = m[1], buf = Buffer.from(m[2], 'base64');
  const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1];
  const path = `${id}/${i}.${ext}`;
  const r = await fetch(`${SB_URL}/storage/v1/object/${FOTOS_BUCKET}/${path}`, {
    method: 'POST', headers: sbHeaders({ 'Content-Type': mime, 'x-upsert': 'true' }), body: buf,
  });
  if (!r.ok) throw new Error('Storage upload ' + r.status);
  return path;
}
// Sube todas las fotos de un registro → array de rutas (o el base64 si no hay Storage).
async function subirFotos(arr, id) {
  if (!Array.isArray(arr) || !arr.length) return [];
  if (!storageOn()) return arr;
  const out = []; let i = 0;
  for (const d of arr) { out.push(await subirFoto(d, id, i)); i++; }
  return out;
}
// Ruta del bucket → URL firmada temporal (2 h). data:/http se devuelven igual.
async function urlFirmada(v) {
  if (typeof v !== 'string' || !v || v.startsWith('data:') || v.startsWith('http') || !storageOn()) return v;
  try {
    const r = await fetch(`${SB_URL}/storage/v1/object/sign/${FOTOS_BUCKET}/${v}`, {
      method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: 7200 }),
    });
    if (!r.ok) return v;
    const j = await r.json();
    return j.signedURL ? `${SB_URL}/storage/v1${j.signedURL}` : v;
  } catch { return v; }
}
const firmarFotos = (arr) => Promise.all((arr || []).map(urlFirmada));

// ─────────────────────────────────────────────────────────────────────────────
// 📝 REGISTRO DE GESTIÓN → tabla `gestion`
// ─────────────────────────────────────────────────────────────────────────────
let gestionSchemaLista = false;
async function ensureGestionSchema() {
  if (!pgPool || gestionSchemaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS gestion (
      id                  BIGSERIAL PRIMARY KEY,
      creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
      registrado_por      TEXT,
      dni_cliente         TEXT NOT NULL,
      sede                TEXT NOT NULL,
      asesor              TEXT NOT NULL,
      tipo_gestion        TEXT NOT NULL,
      resultado           TEXT NOT NULL,
      motivo_contacto     TEXT,
      motivo_no_contacto  TEXT,
      fecha_compromiso    DATE,
      valor_venta         NUMERIC,
      producto_interes    TEXT,
      detalle_contacto    TEXT,
      celular_actualizado TEXT
    );
  `);
  // Columnas para migración/sincronización desde la hoja "sedes":
  //   marca_temporal   = fecha real de la gestión (del sheet; en app = creado_en)
  //   origen           = 'app' (registro por plataforma) | 'sheet' (importado del formulario)
  //   hash_row         = huella de la fila para no duplicar al re-sincronizar
  await pgPool.query(`ALTER TABLE gestion ADD COLUMN IF NOT EXISTS marca_temporal TIMESTAMP`);
  await pgPool.query(`ALTER TABLE gestion ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'app'`);
  await pgPool.query(`ALTER TABLE gestion ADD COLUMN IF NOT EXISTS hash_row TEXT`);
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_gestion_hash ON gestion (hash_row) WHERE hash_row IS NOT NULL`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS ix_gestion_marca ON gestion (marca_temporal)`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS ix_gestion_sede ON gestion (sede)`);
  // Índice por DÍA (marca_temporal::date) → el filtro por fecha de /gestion usa Index Scan
  // en vez de Seq Scan sobre las ~150k filas. (Ver GET /gestion.)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS ix_gestion_marca_dia ON gestion ((marca_temporal::date))`);
  gestionSchemaLista = true;
}

app.post('/gestion', async (req, res) => {
  if (!pgPool) {
    return res.status(500).json({ success: false, message: 'Base de datos no configurada (falta DATABASE_URL).' });
  }
  const b = req.body || {};
  const requeridos = ['dni_cliente', 'sede', 'asesor', 'tipo_gestion', 'resultado'];
  for (const campo of requeridos) {
    if (!b[campo] || b[campo].toString().trim() === '') {
      return res.status(400).json({ success: false, message: `Falta el campo obligatorio: ${campo}.` });
    }
  }

  const norm = (v) => (v === undefined || v === null || v === '' ? null : v);
  const valorVenta = (b.valor_venta === '' || b.valor_venta === undefined || b.valor_venta === null)
    ? null
    : Number(String(b.valor_venta).replace(/[^0-9.]/g, '')) || null;

  try {
    await ensureGestionSchema();
    const q = `INSERT INTO gestion
      (registrado_por, dni_cliente, sede, asesor, tipo_gestion, resultado,
       motivo_contacto, motivo_no_contacto, fecha_compromiso, valor_venta,
       producto_interes, detalle_contacto, celular_actualizado, marca_temporal)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, (now() AT TIME ZONE 'America/Lima')) RETURNING *`;
    const vals = [
      norm(b.registrado_por), b.dni_cliente, b.sede, b.asesor, b.tipo_gestion, b.resultado,
      norm(b.motivo_contacto), norm(b.motivo_no_contacto), norm(b.fecha_compromiso), valorVenta,
      norm(b.producto_interes), norm(b.detalle_contacto), norm(b.celular_actualizado),
    ];
    const { rows } = await pgPool.query(q, vals);
    res.json({ success: true, gestion: rows[0] });
  } catch (error) {
    console.error('❌ Error en POST /gestion:', error);
    res.status(500).json({ success: false, message: 'No se pudo guardar la gestión.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔄 MIGRACIÓN/SINCRONIZACIÓN de la gestión de SEDES (hoja "sedes" → tabla gestion)
//   • Ferreñafe registra por la plataforma (POST /gestion, origen 'app').
//   • Las demás sedes usan el formulario; el botón "Sincronizar" copia lo NUEVO del
//     sheet a la BD (ON CONFLICT hash → idempotente). Control Gestión Sede lee la BD.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const SHEETS_API_URL = (process.env.SHEETS_API_URL || 'https://api-leoncito.onrender.com').replace(/\/+$/, '');
const SEDES_ASESOR_COLS = ['MOTUPE', 'OLMOS', 'FERREÑAFE', 'JAYANCA', 'MOCHUMI', 'MORROPE', 'LAMBAYEQUE', 'OYOTUN', 'CAYALTI', 'CHONGOYAPE'];
const txt = (v) => (v === undefined || v === null ? '' : String(v).trim());

function parseMarcaSheet(raw) {
  const m = txt(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const dt = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
  return isNaN(dt) ? null : dt;
}
function parseFechaCompromiso(raw) {
  const v = txt(raw); if (!v) return null;
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function asesorDeFila(row, sede) {
  const col = `ASESOR DE VENTA ${txt(sede).toUpperCase()}`;
  if (txt(row[col])) return txt(row[col]);
  for (const c of SEDES_ASESOR_COLS) { const v = txt(row[`ASESOR DE VENTA ${c}`]); if (v) return v; }
  return '';
}
function mapGestionSedeSheet(row) {
  const sede = txt(row['TIENDA SEDE']);
  const asesor = asesorDeFila(row, sede);
  const dni = txt(row['DNI CLIENTE']);
  const resultado = txt(row['RESULTADO DE GESTION']);
  const celular = txt(row['N° CELULAR ACTUALIZADO']);
  const raw = txt(row['Marca temporal']);
  const valorNum = Number(txt(row['VALOR DE LA VENTA']).replace(/[^0-9.]/g, ''));
  return {
    marca_temporal: parseMarcaSheet(raw),
    dni_cliente: dni, sede, asesor,
    tipo_gestion: txt(row['TIPO DE GESTION']),
    resultado,
    motivo_contacto: txt(row['MOTIVOS "CONTACTO EN LA GESTION"']) || null,
    motivo_no_contacto: txt(row['MOTIVOS "NO CONTACTO EN LA GESTION"']) || null,
    fecha_compromiso: parseFechaCompromiso(row['FECHA DE COMPROMISO O VISITA']),
    valor_venta: valorNum || null,
    producto_interes: txt(row['PRODUCTO DE INTERES']) || null,
    detalle_contacto: txt(row['DETALLE(COMENTARIO) CONTACTO']) || null,
    celular_actualizado: celular || null,
    hash_row: crypto.createHash('sha1').update([raw, dni, asesor, resultado, celular].join('|')).digest('hex'),
  };
}

// POST /gestion/sync-sedes — copia del sheet "sedes" a la BD solo lo NUEVO (ON CONFLICT hash).
app.post('/gestion/sync-sedes', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionSchema();
    // Rango del sync:
    //  · Explícito (?desde=&hasta=) → ese periodo.
    //  · ?full=1 → toda la hoja (re-migración completa; lento, solo casos puntuales).
    //  · Por defecto (sin params) → "TODO LO NUEVO": desde la última fecha en BD MENOS
    //    7 días, hasta hoy. El buffer de 7 días es CLAVE: los formularios llegan tarde
    //    para días previos (p. ej. respuestas de ayer por la noche) y, si el MAX ya avanzó
    //    a hoy, esos registros quedaban colgados para siempre. Re-leer la última semana es
    //    barato e idempotente (INSERT ON CONFLICT hash DO NOTHING) y recaptura los rezagados.
    let desde = req.query.desde ? String(req.query.desde) : null;
    let hasta = req.query.hasta ? String(req.query.hasta) : null;
    if (!desde && !hasta && !req.query.full) {
      const { rows: r } = await pgPool.query(
        `SELECT to_char((MAX(COALESCE(marca_temporal, creado_en AT TIME ZONE 'America/Lima'))::date - INTERVAL '7 days'), 'YYYY-MM-DD') AS d,
                to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD') AS hoy FROM gestion`);
      if (r[0].d) { desde = r[0].d; hasta = r[0].hoy; }   // BD vacía → sin rango = hoja completa (1ª migración)
    }
    const qs = [];
    if (desde) qs.push(`desde=${encodeURIComponent(desde)}`);
    if (hasta) qs.push(`hasta=${encodeURIComponent(hasta)}`);
    const url = `${SHEETS_API_URL}/data/sedes${qs.length ? '?' + qs.join('&') : ''}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!resp.ok) throw new Error(`sheets-api /data/sedes -> ${resp.status}`);
    const data = await resp.json();
    const filas = (Array.isArray(data) ? data : [])
      .map(mapGestionSedeSheet)
      .filter(f => f.dni_cliente && f.sede && f.asesor && f.tipo_gestion && f.resultado);
    const COLS = ['marca_temporal', 'dni_cliente', 'sede', 'asesor', 'tipo_gestion', 'resultado',
      'motivo_contacto', 'motivo_no_contacto', 'fecha_compromiso', 'valor_venta', 'producto_interes',
      'detalle_contacto', 'celular_actualizado', 'hash_row', 'origen'];
    let insertados = 0;
    const client = await pgPool.connect();
    try {
      const CHUNK = 500;
      for (let i = 0; i < filas.length; i += CHUNK) {
        const chunk = filas.slice(i, i + CHUNK);
        const params = [];
        const tuples = chunk.map((f, idx) => {
          const base = idx * COLS.length;
          params.push(f.marca_temporal, f.dni_cliente, f.sede, f.asesor, f.tipo_gestion, f.resultado,
            f.motivo_contacto, f.motivo_no_contacto, f.fecha_compromiso, f.valor_venta, f.producto_interes,
            f.detalle_contacto, f.celular_actualizado, f.hash_row, 'sheet');
          return '(' + COLS.map((_, j) => `$${base + j + 1}`).join(',') + ')';
        });
        const r = await client.query(
          `INSERT INTO gestion (${COLS.join(',')}) VALUES ${tuples.join(',')}
           ON CONFLICT (hash_row) WHERE hash_row IS NOT NULL DO NOTHING`, params);
        insertados += r.rowCount;
      }
    } finally { client.release(); }
    res.json({ success: true, leidas: data.length, validas: filas.length, insertados, duplicados: filas.length - insertados, desde, hasta });
  } catch (e) {
    console.error('❌ POST /gestion/sync-sedes:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /gestion?desde=&hasta=&sede= — lista la gestión de sedes desde la BD (fuente única).
app.get('/gestion', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionSchema();
    res.set('Cache-Control', 'no-store');
    // Fecha efectiva = marca_temporal (hora local Lima). Todas las filas la tienen:
    // las del formulario traen la del sheet; las de plataforma se setean al insertar
    // (antes se hacía COALESCE con creado_en, pero esa expresión no era indexable → Seq
    // Scan). Ahora el filtro por `marca_temporal::date` usa el índice ix_gestion_marca_dia.
    const FECHA = `marca_temporal`;
    const cond = [], params = [];
    if (req.query.desde) { params.push(String(req.query.desde)); cond.push(`${FECHA}::date >= $${params.length}`); }
    if (req.query.hasta) { params.push(String(req.query.hasta)); cond.push(`${FECHA}::date <= $${params.length}`); }
    if (req.query.sede)  { params.push(`%${String(req.query.sede)}%`); cond.push(`sede ILIKE $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(
      `SELECT id, ${FECHA} AS fecha, to_char(${FECHA}, 'DD/MM/YYYY HH24:MI:SS') AS marca,
              dni_cliente, sede, asesor, tipo_gestion, resultado,
              motivo_contacto, motivo_no_contacto, fecha_compromiso, valor_venta, producto_interes,
              detalle_contacto, celular_actualizado, origen
       FROM gestion ${where} ORDER BY ${FECHA} DESC`, params);
    res.json(rows);
  } catch (e) { console.error('❌ GET /gestion:', e); res.status(500).json({ success: false, message: e.message }); }
});

// PUT /gestion/:id — edita una gestión (módulo Gestión Sede, como gestion-call/realzza).
app.put('/gestion/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionSchema();
    const b = req.body || {};
    const sets = [], vals = [];
    const editable = ['dni_cliente', 'sede', 'asesor', 'tipo_gestion', 'resultado', 'motivo_contacto',
      'motivo_no_contacto', 'producto_interes', 'detalle_contacto', 'celular_actualizado'];
    for (const c of editable) if (b[c] !== undefined) { vals.push(String(b[c] ?? '').trim() || null); sets.push(`${c} = $${vals.length}`); }
    if (b.fecha_compromiso !== undefined) { vals.push(b.fecha_compromiso || null); sets.push(`fecha_compromiso = $${vals.length}`); }
    if (b.valor_venta !== undefined) { const n = Number(String(b.valor_venta).replace(/[^0-9.]/g, '')); vals.push(n || null); sets.push(`valor_venta = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nada para actualizar.' });
    vals.push(parseInt(req.params.id, 10));
    const { rowCount } = await pgPool.query(`UPDATE gestion SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Gestión no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /gestion/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /gestion/:id — elimina una gestión de la BD (no solo visual).
app.delete('/gestion/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionSchema();
    const { rowCount } = await pgPool.query('DELETE FROM gestion WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Gestión no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /gestion/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// 📞 CALL SEDES / MARKET PLACE → tabla `gestion_call_sedes` (hoja "ferre")
//   Migración + sincronización (sheet→BD, hash dedupe) + registro por plataforma
//   (MARKET PLACE) + edición/eliminación. Mismo patrón que la gestión de sedes.
// ═════════════════════════════════════════════════════════════════════════════
const CCS_ASESOR_SEDES = ['FERREÑAFE', 'MOTUPE', 'CAYALTI', 'OYOTUN', 'CHONGOYAPE', 'LAMBAYEQUE'];
// [columna en BD, columna en el sheet]
const CCS_MAP = [
  ['sede', 'SEDE'], ['market_place', 'MARKET PLACE'], ['dni_cliente', 'DNI CLIENTE'],
  ['celular_gestionado', 'CELULAR GESTIONADO'], ['tipo_cliente', 'TIPO DE CLIENTE'],
  ['estado_gestion', 'ESTADO DE GESTIÓN'], ['medio_primer_contacto', 'MEDIO DE PRIMER CONTACTO'],
  ['resultado_gestion', 'RESULTADO DE GESTIÓN'], ['producto_interes', 'PRODUCTO INTERÉS'],
  ['motivo_interes', 'MOTIVO INTERÉS'], ['motivo_agendamiento', 'MOTIVO AGENDAMIENTO'],
  ['fecha_agendamiento', 'FECHA DE INTERÉS AGENDAMIENTO'], ['hora_agendamiento', 'HORA APROXIMADA INTERÉS AGENDAMIENTO'],
  ['comentario_agendamiento', 'COMENTARIO ADICIONAL AGENDAMIENTO'], ['fecha_derivacion', 'FECHA DE INTERÉS DERIVACIÓN'],
  ['hora_derivacion', 'HORA APROXIMADA INTERÉS DERIVACIÓN'], ['comentario_derivacion', 'COMENTARIO ADICIONAL DERIVACIÓN'],
  ['motivo_no_interes', 'MOTIVO NO INTERÉS'], ['comentario_no_interes', 'COMENTARIO ADICIONAL NO INTERES'],
  ['motivo_no_atendible', 'MOTIVO NO ATENDIBLE'], ['comentario_no_atendible', 'COMENTARIO ADICIONAL NO ATENDIBLE'],
  ['motivos_tercero', 'MOTIVOS TERCERO RELACIONADO'], ['fecha_rellamada', 'FECHA DE RE-LLAMADA'],
  ['hora_rellamada', 'HORA DE RELLAMADA'], ['numero_titular', 'NÚMERO TITULAR ACTUAL'],
  ['motivo_no_contacto', 'MOTIVO NO CONTACTO'], ['motivo_no_cierre', 'MOTIVO DE NO CIERRE'],
  ['comentario_venta_no_concretada', 'COMENTARIO VENTA NO CONCRETADA'], ['fecha_primer_contacto', 'FECHA PRIMER CONTACTO'],
];
let ccsSchemaLista = false;
async function ensureCallSedesSchema() {
  if (!pgPool || ccsSchemaLista) return;
  const cols = CCS_MAP.map(([c]) => `${c} TEXT`).join(',\n      ');
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS gestion_call_sedes (
      id             BIGSERIAL PRIMARY KEY,
      creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
      marca_temporal TIMESTAMP,
      registrado_por TEXT,
      asesor         TEXT,
      ${cols},
      origen         TEXT NOT NULL DEFAULT 'app',
      hash_row       TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ccs_hash ON gestion_call_sedes (hash_row) WHERE hash_row IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_ccs_marca ON gestion_call_sedes (marca_temporal);
    CREATE INDEX IF NOT EXISTS ix_ccs_marca_dia ON gestion_call_sedes ((marca_temporal::date));
    CREATE INDEX IF NOT EXISTS ix_ccs_sede  ON gestion_call_sedes (sede);
  `);
  ccsSchemaLista = true;
}
function asesorFerre(row, sede) {
  const col = `ASESOR ${txt(sede).toUpperCase()}`;
  if (txt(row[col])) return txt(row[col]);
  for (const s of CCS_ASESOR_SEDES) { const v = txt(row[`ASESOR ${s}`]); if (v) return v; }
  return '';
}
function mapCallSedeSheet(row) {
  // La sede puede venir en 'SEDE' o 'SEDE (1)'; si no, se deriva de la columna de asesor con valor.
  let sede = txt(row['SEDE']) || txt(row['SEDE (1)']);
  if (!sede) { for (const s of CCS_ASESOR_SEDES) { if (txt(row[`ASESOR ${s}`])) { sede = s; break; } } }
  const asesor = asesorFerre(row, sede);
  const raw = txt(row['Marca temporal']);
  const obj = { marca_temporal: parseMarcaSheet(raw), asesor };
  for (const [c, sh] of CCS_MAP) obj[c] = txt(row[sh]) || null;
  obj.sede = sede || null;   // sede resuelta (override del mapeo directo de 'SEDE')
  obj.hash_row = crypto.createHash('sha1')
    .update([raw, obj.dni_cliente || '', asesor, obj.estado_gestion || '', obj.celular_gestionado || ''].join('|')).digest('hex');
  return obj;
}
const CCS_INSERT_COLS = ['marca_temporal', 'asesor', ...CCS_MAP.map(([c]) => c), 'hash_row', 'origen'];

// POST /call-sedes/sync — copia del sheet "ferre" a la BD solo lo NUEVO (ON CONFLICT hash).
app.post('/call-sedes/sync', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCallSedesSchema();
    const resp = await fetch(`${SHEETS_API_URL}/data/ferre`, { signal: AbortSignal.timeout(120000) });
    if (!resp.ok) throw new Error(`sheets-api /data/ferre -> ${resp.status}`);
    const data = await resp.json();
    const filas = (Array.isArray(data) ? data : []).map(mapCallSedeSheet).filter(f => f.dni_cliente || f.asesor);
    let insertados = 0;
    const client = await pgPool.connect();
    try {
      // Solo AGREGA lo nuevo del formulario (dedupe por hash). NO borra nada: ni el
      // histórico del sheet ni lo registrado por plataforma (origen 'app').
      const CHUNK = 400;
      for (let i = 0; i < filas.length; i += CHUNK) {
        const chunk = filas.slice(i, i + CHUNK);
        const params = [];
        const tuples = chunk.map((f, idx) => {
          const base = idx * CCS_INSERT_COLS.length;
          CCS_INSERT_COLS.forEach(c => params.push(c === 'origen' ? 'sheet' : f[c]));
          return '(' + CCS_INSERT_COLS.map((_, j) => `$${base + j + 1}`).join(',') + ')';
        });
        const r = await client.query(
          `INSERT INTO gestion_call_sedes (${CCS_INSERT_COLS.join(',')}) VALUES ${tuples.join(',')}
           ON CONFLICT (hash_row) WHERE hash_row IS NOT NULL DO NOTHING`, params);
        insertados += r.rowCount;
      }
    } finally { client.release(); }
    res.json({ success: true, leidas: data.length, validas: filas.length, insertados, duplicados: filas.length - insertados });
  } catch (e) { console.error('❌ POST /call-sedes/sync:', e); res.status(500).json({ success: false, message: e.message }); }
});

// GET /call-sedes?desde=&hasta=&sede= — lista call-sedes desde la BD (fuente única).
app.get('/call-sedes', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCallSedesSchema();
    res.set('Cache-Control', 'no-store');
    // marca_temporal en todas las filas (sheet + app la setean al insertar) → filtro por
    // marca_temporal::date usa el índice ix_ccs_marca_dia (antes COALESCE = Seq Scan).
    const FECHA = `marca_temporal`;
    const cond = [], params = [];
    if (req.query.desde) { params.push(String(req.query.desde)); cond.push(`${FECHA}::date >= $${params.length}`); }
    if (req.query.hasta) { params.push(String(req.query.hasta)); cond.push(`${FECHA}::date <= $${params.length}`); }
    if (req.query.sede)   { params.push(`%${String(req.query.sede)}%`); cond.push(`sede ILIKE $${params.length}`); }
    if (req.query.asesor) { params.push(String(req.query.asesor).trim()); cond.push(`upper(trim(asesor)) = upper(trim($${params.length}))`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(
      `SELECT id, to_char(${FECHA}, 'DD/MM/YYYY HH24:MI:SS') AS marca, asesor,
              ${CCS_MAP.map(([c]) => c).join(', ')}, origen
       FROM gestion_call_sedes ${where} ORDER BY ${FECHA} DESC`, params);
    res.json(rows);
  } catch (e) { console.error('❌ GET /call-sedes:', e); res.status(500).json({ success: false, message: e.message }); }
});

// POST /call-sedes — registro MARKET PLACE desde la plataforma (origen 'app').
app.post('/call-sedes', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const b = req.body || {};
  if (!txt(b.asesor) || !txt(b.sede) || !txt(b.dni_cliente)) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (asesor, sede, dni_cliente).' });
  }
  try {
    await ensureCallSedesSchema();
    const cols = ['registrado_por', 'asesor'], vals = [txt(b.registrado_por) || null, txt(b.asesor)];
    for (const [c] of CCS_MAP) { cols.push(c); vals.push(b[c] !== undefined ? (txt(b[c]) || null) : null); }
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    // marca_temporal se setea al insertar (hora Lima) → sale por fecha e indexa igual que el sheet.
    const { rows } = await pgPool.query(
      `INSERT INTO gestion_call_sedes (${cols.join(',')}, marca_temporal) VALUES (${ph}, (now() AT TIME ZONE 'America/Lima')) RETURNING id`, vals);
    res.json({ success: true, id: rows[0].id });
  } catch (e) { console.error('❌ POST /call-sedes:', e); res.status(500).json({ success: false, message: e.message }); }
});

// PUT /call-sedes/:id — edita; DELETE /call-sedes/:id — elimina (gestion-call-sedes editable).
app.put('/call-sedes/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCallSedesSchema();
    const b = req.body || {};
    const sets = [], vals = [];
    for (const c of ['asesor', ...CCS_MAP.map(([x]) => x)]) if (b[c] !== undefined) { vals.push(txt(b[c]) || null); sets.push(`${c} = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nada para actualizar.' });
    vals.push(parseInt(req.params.id, 10));
    const { rowCount } = await pgPool.query(`UPDATE gestion_call_sedes SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Registro no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /call-sedes/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});
app.delete('/call-sedes/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCallSedesSchema();
    const { rowCount } = await pgPool.query('DELETE FROM gestion_call_sedes WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Registro no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /call-sedes/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🕵️ CONTROL SUPERVISOR → tabla `control_supervisor`
// ─────────────────────────────────────────────────────────────────────────────
const CS_COLS = [
  'marca_temporal', 'marca_temporal_raw', 'registrado_por', 'tipo_control', 'asesor', 'tipo_base',
  'dni_cliente', 'celular', 'estado_gestion', 'fecha_publicacion', 'estado_mp',
  'mp_subtipo', 'cliente', 'estado_lead', 'comentario', 'fotos',
];

let csSchemaLista = false;
async function ensureControlSupervisorSchema() {
  if (!pgPool || csSchemaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS control_supervisor (
      id                 BIGSERIAL PRIMARY KEY,
      marca_temporal     TIMESTAMP,
      marca_temporal_raw TEXT,
      registrado_por     TEXT,
      tipo_control       TEXT NOT NULL DEFAULT 'GESTION',
      asesor             TEXT,
      tipo_base          TEXT,
      dni_cliente        TEXT,
      celular            TEXT,
      estado_gestion     TEXT,
      fecha_publicacion  TEXT,
      estado_mp          TEXT,
      mp_subtipo         TEXT,
      cliente            TEXT,
      estado_lead        TEXT,
      comentario         TEXT,
      fotos              TEXT,
      creado_en          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE control_supervisor ADD COLUMN IF NOT EXISTS tipo_control      TEXT NOT NULL DEFAULT 'GESTION';
    ALTER TABLE control_supervisor ADD COLUMN IF NOT EXISTS fecha_publicacion TEXT;
    ALTER TABLE control_supervisor ADD COLUMN IF NOT EXISTS estado_mp         TEXT;
    ALTER TABLE control_supervisor ADD COLUMN IF NOT EXISTS mp_subtipo        TEXT;
    ALTER TABLE control_supervisor ADD COLUMN IF NOT EXISTS cliente           TEXT;
    ALTER TABLE control_supervisor ADD COLUMN IF NOT EXISTS estado_lead       TEXT;
    ALTER TABLE control_supervisor ADD COLUMN IF NOT EXISTS fotos             TEXT;
    CREATE INDEX IF NOT EXISTS ix_cs_marca  ON control_supervisor (marca_temporal);
    CREATE INDEX IF NOT EXISTS ix_cs_asesor ON control_supervisor (asesor);
    CREATE INDEX IF NOT EXISTS ix_cs_dni    ON control_supervisor (dni_cliente);
  `);
  csSchemaLista = true;
}

function csRowToJson(row) {
  return {
    id: row.id,
    marca_temporal: row.marca_temporal_raw || '',
    registrado_por: row.registrado_por || '',
    tipo_control: row.tipo_control || 'GESTION',
    asesor: row.asesor || '',
    tipo_base: row.tipo_base || '',
    dni_cliente: row.dni_cliente || '',
    celular: row.celular || '',
    estado_gestion: row.estado_gestion || '',
    fecha_publicacion: row.fecha_publicacion || '',
    estado_mp: row.estado_mp || '',
    mp_subtipo: row.mp_subtipo || '',
    cliente: row.cliente || '',
    estado_lead: row.estado_lead || '',
    comentario: row.comentario || '',
    fotos: parseFotos(row.fotos),
  };
}

// POST /control-supervisor — registra un control del supervisor (gestión o market place).
app.post('/control-supervisor', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const b = req.body || {};
  const tipo = (b.tipo_control || 'GESTION').toString().toUpperCase();
  if (tipo === 'MARKET_PLACE') {
    const sub = (b.mp_subtipo || 'MARKET PLACE').toString().toUpperCase();
    if (sub === 'KOMMO PLATAFORMA') {
      if (!b.asesor || !b.estado_lead) {
        return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (asesor, estado del lead).' });
      }
    } else if (!b.asesor || !b.estado_mp) {
      return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (asesor, estado de publicación).' });
    }
  } else if (!b.dni_cliente || !b.estado_gestion) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (dni, estado de gestión).' });
  }
  try {
    await ensureControlSupervisorSchema();
    const t = ahoraLima();
    const valorDe = {
      marca_temporal: t.ts, marca_temporal_raw: t.raw,
      registrado_por: b.registrado_por, tipo_control: tipo, asesor: b.asesor, tipo_base: b.tipo_base,
      dni_cliente: b.dni_cliente, celular: b.celular, estado_gestion: b.estado_gestion,
      fecha_publicacion: b.fecha_publicacion, estado_mp: b.estado_mp,
      mp_subtipo: b.mp_subtipo, cliente: b.cliente, estado_lead: b.estado_lead,
      comentario: b.comentario,
      fotos: null,   // se guardan después con su RUTA en Storage (necesitamos el id)
    };
    const params = CS_COLS.map(c => { const v = valorDe[c]; return v === undefined || v === '' ? null : v; });
    const ph = CS_COLS.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pgPool.query(
      `INSERT INTO control_supervisor (${CS_COLS.join(',')}) VALUES (${ph}) RETURNING id`, params);
    const id = rows[0].id;
    // Fotos → Supabase Storage (rutas). Sin Storage configurado, cae al base64 (fallback).
    if (Array.isArray(b.fotos) && b.fotos.length) {
      const paths = await subirFotos(b.fotos, id);
      await pgPool.query('UPDATE control_supervisor SET fotos = $2 WHERE id = $1', [id, JSON.stringify(paths)]);
    }
    res.json({ success: true, id, marca_temporal: valorDe.marca_temporal_raw });
  } catch (e) {
    console.error('❌ POST /control-supervisor:', e);
    res.status(500).json({ success: false, message: 'No se pudo guardar el control.' });
  }
});

// GET /control-supervisor?desde=&hasta= — controles del supervisor por rango de fechas.
app.get('/control-supervisor', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureControlSupervisorSchema();
    const cond = []; const params = [];
    if (req.query.desde) { params.push(`${req.query.desde} 00:00:00`); cond.push(`marca_temporal >= $${params.length}`); }
    if (req.query.hasta) { params.push(`${req.query.hasta} 23:59:59`); cond.push(`marca_temporal <= $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(
      `SELECT * FROM control_supervisor ${where} ORDER BY marca_temporal DESC NULLS LAST`, params);
    // Las fotos vienen como rutas del bucket → se firman (URL temporal) para el navegador.
    const out = await Promise.all(rows.map(async row => {
      const j = csRowToJson(row);
      if (j.fotos.length) j.fotos = await firmarFotos(j.fotos);
      return j;
    }));
    res.json(out);
  } catch (e) {
    console.error('❌ GET /control-supervisor:', e);
    res.status(500).json({ success: false, message: 'No se pudieron obtener los controles.' });
  }
});

// Mapa clave → columna BD (para editar; no toca marca_temporal/id).
const CS_SHEET_TO_COL = {
  registrado_por: 'registrado_por', tipo_control: 'tipo_control', asesor: 'asesor', tipo_base: 'tipo_base',
  dni_cliente: 'dni_cliente', celular: 'celular', estado_gestion: 'estado_gestion',
  fecha_publicacion: 'fecha_publicacion', estado_mp: 'estado_mp',
  mp_subtipo: 'mp_subtipo', cliente: 'cliente', estado_lead: 'estado_lead', comentario: 'comentario',
};

// PUT /control-supervisor/:id — edita un control.
app.put('/control-supervisor/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureControlSupervisorSchema();
    const { sets, params } = construirUpdate(req.body, CS_SHEET_TO_COL, CS_COLS);
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nada para actualizar.' });
    params.push(parseInt(req.params.id, 10));
    const { rowCount } = await pgPool.query(`UPDATE control_supervisor SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Control no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /control-supervisor/:id', e); res.status(500).json({ success: false, message: 'No se pudo actualizar.' }); }
});

// DELETE /control-supervisor/:id — elimina un control.
app.delete('/control-supervisor/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureControlSupervisorSchema();
    const { rowCount } = await pgPool.query('DELETE FROM control_supervisor WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Control no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /control-supervisor/:id', e); res.status(500).json({ success: false, message: 'No se pudo eliminar.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🧲 GESTIÓN KOMMO → tabla `gestion_kommo` (UNA sola tabla para Leoncito + Realzza)
// Reemplaza el Google Form KOMMO: el registro va directo a BD. `canal` distingue
// LEONCITO vs REALZZA; los campos comunes se unifican y cada canal tiene los suyos.
// GET soporta ?shape=sheet para devolver con los nombres de columna del sheet
// (DNI CLIENTE / DNI CLIENTE REALZZA, MARKET PLACE L/R, …) y no romper a los
// consumidores actuales (Maduración, Control Supervisor, Mi Panel) en la transición.
// ─────────────────────────────────────────────────────────────────────────────
const GK_COLS = [
  'marca_temporal', 'marca_temporal_raw', 'registrado_por', 'canal',
  'tienda', 'fecha_lead_asignado', 'nombre_cliente', 'asesor', 'sede',
  'dni_cliente', 'celular_gestionado', 'tipo_cliente', 'estado_gestion', 'resultado_gestion', 'market_place',
  // Leoncito
  'producto_interes', 'motivo_interes', 'motivo_agendamiento',
  'fecha_interes_agend', 'hora_interes_agend', 'comentario_agend',
  'fecha_interes_deriv', 'hora_interes_deriv', 'comentario_deriv',
  'motivo_no_interes', 'comentario_adicional', 'motivo_no_atendible', 'comentario_na', 'motivo_no_contacto',
  // Realzza
  'motivo_no_cierre', 'comentario_venta_no_concretada',
  // Origen del registro: 'sheet' (migrado del Google Form) | 'dashboard' (nuevo)
  'origen',
];
let gkSchemaLista = false;
async function ensureGestionKommoSchema() {
  if (!pgPool || gkSchemaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS gestion_kommo (
      id                 BIGSERIAL PRIMARY KEY,
      creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
      marca_temporal     TIMESTAMP,
      marca_temporal_raw TEXT,
      registrado_por     TEXT,
      canal              TEXT NOT NULL,
      tienda TEXT, fecha_lead_asignado TEXT, nombre_cliente TEXT, asesor TEXT, sede TEXT,
      dni_cliente TEXT, celular_gestionado TEXT, tipo_cliente TEXT, estado_gestion TEXT,
      resultado_gestion TEXT, market_place TEXT,
      producto_interes TEXT, motivo_interes TEXT, motivo_agendamiento TEXT,
      fecha_interes_agend TEXT, hora_interes_agend TEXT, comentario_agend TEXT,
      fecha_interes_deriv TEXT, hora_interes_deriv TEXT, comentario_deriv TEXT,
      motivo_no_interes TEXT, comentario_adicional TEXT, motivo_no_atendible TEXT,
      comentario_na TEXT, motivo_no_contacto TEXT,
      motivo_no_cierre TEXT, comentario_venta_no_concretada TEXT,
      origen TEXT NOT NULL DEFAULT 'dashboard'
    );
    ALTER TABLE gestion_kommo ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'dashboard';
    CREATE INDEX IF NOT EXISTS ix_gk_marca  ON gestion_kommo (marca_temporal);
    CREATE INDEX IF NOT EXISTS ix_gk_origen ON gestion_kommo (origen);
    CREATE INDEX IF NOT EXISTS ix_gk_canal  ON gestion_kommo (canal);
    CREATE INDEX IF NOT EXISTS ix_gk_dni    ON gestion_kommo (dni_cliente);
    CREATE INDEX IF NOT EXISTS ix_gk_asesor ON gestion_kommo (asesor);
  `);
  gkSchemaLista = true;
}

// Mapa clave → columna (para editar). Las claves = mismos nombres snake de GK_COLS.
const GK_SHEET_TO_COL = {};
GK_COLS.forEach(c => { GK_SHEET_TO_COL[c] = c; });

// Fila BD → shape del SHEET KOMMO (para compatibilidad con los consumidores actuales).
function gkRowToSheet(r) {
  const esR = (r.canal || '').toString().toUpperCase() === 'REALZZA';
  return {
    'Marca temporal': r.marca_temporal_raw || '',
    'TIENDA': r.tienda || '',
    'FECHA DE LEAD ASIGNADO': r.fecha_lead_asignado || '',
    'NOMBRE CLIENTE': r.nombre_cliente || '',
    'ASESOR CONTACT': esR ? '' : (r.asesor || ''),
    'SEDE': r.sede || '',
    'DNI CLIENTE': esR ? '' : (r.dni_cliente || ''),
    'CELULAR GESTIONADO': esR ? '' : (r.celular_gestionado || ''),
    'TIPO DE CLIENTE': r.tipo_cliente || '',
    'ESTADO DE GESTIÓN': esR ? '' : (r.estado_gestion || ''),
    'RESULTADO DE GESTIÓN': r.resultado_gestion || '',
    'PRODUCTO INTERÉS': r.producto_interes || '',
    'MOTIVO INTERÉS': r.motivo_interes || '',
    'MOTIVO AGENDAMIENTO': r.motivo_agendamiento || '',
    'FECHA DE INTERÉS AGENDAMIENTO': r.fecha_interes_agend || '',
    'HORA APROXIMADA INTERÉS AGENDAMIENTO': r.hora_interes_agend || '',
    'COMENTARIO ADICIONAL AGENDAMIENTO': r.comentario_agend || '',
    'FECHA DE INTERÉS DERIVACIÓN': r.fecha_interes_deriv || '',
    'HORA APROXIMADA INTERÉS DERIVACIÓN': r.hora_interes_deriv || '',
    'COMENTARIO ADICIONAL DERIVACIÓN': r.comentario_deriv || '',
    'MOTIVO NO INTERÉS': r.motivo_no_interes || '',
    'COMENTARIO ADICIONAL': r.comentario_adicional || '',
    'MOTIVO NO ATENDIBLE': r.motivo_no_atendible || '',
    'COMENTARIO ADICIONAL NA': r.comentario_na || '',
    'MOTIVO NO CONTACTO': r.motivo_no_contacto || '',
    'ASESOR REALZZA': esR ? (r.asesor || '') : '',
    'DNI CLIENTE REALZZA': esR ? (r.dni_cliente || '') : '',
    'CELULAR GESTIONADO REALZZA': esR ? (r.celular_gestionado || '') : '',
    'ESTADO DE GESTIÓN REALZZA': esR ? (r.estado_gestion || '') : '',
    'MARKET PLACE L': esR ? '' : (r.market_place || ''),
    'MARKET PLACE R': esR ? (r.market_place || '') : '',
    'MOTIVO DE NO CIERRE': r.motivo_no_cierre || '',
    'COMENTARIO VENTA NO CONCRETADA': r.comentario_venta_no_concretada || '',
    id: r.id,
  };
}

// POST /gestion-kommo — registra una gestión KOMMO (Leoncito o Realzza).
app.post('/gestion-kommo', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  const b = req.body || {};
  const canal = (b.canal || '').toString().toUpperCase();
  if (canal !== 'LEONCITO' && canal !== 'REALZZA') {
    return res.status(400).json({ success: false, message: 'canal debe ser LEONCITO o REALZZA.' });
  }
  if (!b.asesor || !b.dni_cliente || !b.estado_gestion) {
    return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (asesor, dni_cliente, estado_gestion).' });
  }
  try {
    await ensureGestionKommoSchema();
    const t = ahoraLima();
    const valorDe = { ...b, canal, origen: b.origen || 'dashboard', marca_temporal: t.ts, marca_temporal_raw: t.raw };
    const params = GK_COLS.map(c => { const v = valorDe[c]; return v === undefined || v === '' ? null : v; });
    const ph = GK_COLS.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pgPool.query(
      `INSERT INTO gestion_kommo (${GK_COLS.join(',')}) VALUES (${ph}) RETURNING id`, params);
    res.json({ success: true, id: rows[0].id, marca_temporal: t.raw });
  } catch (e) {
    console.error('❌ POST /gestion-kommo:', e);
    res.status(500).json({ success: false, message: 'No se pudo guardar la gestión KOMMO.' });
  }
});

// GET /gestion-kommo?canal=&desde=&hasta=&asesor=&shape=sheet
app.get('/gestion-kommo', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionKommoSchema();
    const cond = []; const params = [];
    if (req.query.canal)  { params.push(String(req.query.canal).toUpperCase()); cond.push(`UPPER(canal) = $${params.length}`); }
    if (req.query.desde)  { params.push(`${req.query.desde} 00:00:00`); cond.push(`marca_temporal >= $${params.length}`); }
    if (req.query.hasta)  { params.push(`${req.query.hasta} 23:59:59`); cond.push(`marca_temporal <= $${params.length}`); }
    if (req.query.asesor) { params.push(String(req.query.asesor).trim()); cond.push(`asesor ILIKE $${params.length}`); }
    // Filtro por FECHA DE LEAD ASIGNADO (texto d/m/aaaa) por mes+año — para Embudos.
    if (req.query.leadMes && req.query.leadAnio) {
      params.push(parseInt(req.query.leadMes, 10)); const pm = params.length;
      params.push(parseInt(req.query.leadAnio, 10)); const pa = params.length;
      cond.push(`(fecha_lead_asignado ~ '^\\d{1,2}/\\d{1,2}/\\d{4}' AND split_part(fecha_lead_asignado,'/',2)::int = $${pm} AND split_part(fecha_lead_asignado,'/',3)::int = $${pa})`);
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(
      `SELECT * FROM gestion_kommo ${where} ORDER BY marca_temporal DESC NULLS LAST`, params);
    const mapFn = req.query.shape === 'sheet'
      ? gkRowToSheet
      : (r) => ({ ...r, marca_temporal: r.marca_temporal_raw || '' });
    // Streaming por lotes: no materializa el array completo ni el string gigante
    // (evita OOM con miles de filas). compression() lo gzipa al vuelo.
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
  } catch (e) {
    console.error('❌ GET /gestion-kommo:', e);
    res.status(500).json({ success: false, message: 'No se pudieron obtener las gestiones KOMMO.' });
  }
});

// POST /gestion-kommo/lead-match — cruce por DNI en SQL para la Maduración de Leads.
// Body: { canal: 'LEONCITO'|'REALZZA', soloMP?: bool, dnis: [...] }.
// Devuelve { <dni>: ym } con ym = anio*12+(mes-1) de la FECHA DE LEAD ASIGNADO más
// ANTIGUA por DNI. Evita descargar todo el KOMMO al navegador (se agrega en la BD).
app.post('/gestion-kommo/lead-match', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionKommoSchema();
    const b = req.body || {};
    const canal = (b.canal || '').toString().toUpperCase();
    if (canal !== 'LEONCITO' && canal !== 'REALZZA') {
      return res.status(400).json({ success: false, message: 'canal debe ser LEONCITO o REALZZA.' });
    }
    const dnis = Array.isArray(b.dnis) ? [...new Set(b.dnis.map(d => String(d).replace(/\D/g, '')).filter(Boolean))] : [];
    if (!dnis.length) return res.json({});
    const cond = [`canal = $1`, `fecha_lead_asignado ~ '^\\d{1,2}/\\d{1,2}/\\d{4}'`];
    const params = [canal];
    if (b.soloMP) cond.push(`UPPER(TRIM(market_place)) IN ('SI','SÍ')`);
    params.push(dnis);
    const sql = `
      SELECT regexp_replace(dni_cliente, '\\D', '', 'g') AS dni,
             MIN(split_part(fecha_lead_asignado,'/',3)::int * 12 + (split_part(fecha_lead_asignado,'/',2)::int - 1)) AS ym
      FROM gestion_kommo
      WHERE ${cond.join(' AND ')}
        AND regexp_replace(dni_cliente, '\\D', '', 'g') = ANY($${params.length})
      GROUP BY 1`;
    const { rows } = await pgPool.query(sql, params);
    const out = {};
    for (const r of rows) out[r.dni] = r.ym;
    res.json(out);
  } catch (e) {
    console.error('❌ POST /gestion-kommo/lead-match:', e);
    res.status(500).json({ success: false, message: 'No se pudo cruzar los leads.' });
  }
});

// PUT /gestion-kommo/:id — edita una gestión.
app.put('/gestion-kommo/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionKommoSchema();
    const { sets, params } = construirUpdate(req.body, GK_SHEET_TO_COL, GK_COLS);
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nada para actualizar.' });
    params.push(parseInt(req.params.id, 10));
    const { rowCount } = await pgPool.query(`UPDATE gestion_kommo SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Gestión no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /gestion-kommo/:id', e); res.status(500).json({ success: false, message: 'No se pudo actualizar.' }); }
});

// DELETE /gestion-kommo/:id — elimina una gestión.
app.delete('/gestion-kommo/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureGestionKommoSchema();
    const { rowCount } = await pgPool.query('DELETE FROM gestion_kommo WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Gestión no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /gestion-kommo/:id', e); res.status(500).json({ success: false, message: 'No se pudo eliminar.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 💰 GESTIÓN DE COBRANZA — registro por plataforma (tabla gestion_cobranza)
let cobranzaLista = false;
async function ensureCobranza() {
  if (!pgPool || cobranzaLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS gestion_cobranza (
      id BIGSERIAL PRIMARY KEY,
      registrado_por  TEXT,
      dni_cliente     TEXT,
      nombre_cliente  TEXT,
      celular         TEXT,
      monto_adeudado  NUMERIC(14,2),
      estado_contacto TEXT,
      motivo_no_pago  TEXT,
      quien_respondio TEXT,
      comentario_tercero TEXT,
      resultado_gestion  TEXT,
      fecha_compromiso   TEXT,
      monto_pagar     NUMERIC(14,2),
      observaciones   TEXT,
      origen          TEXT NOT NULL DEFAULT 'app',
      creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_cobranza_dni  ON gestion_cobranza (dni_cliente);
    CREATE INDEX IF NOT EXISTS ix_cobranza_fecha ON gestion_cobranza (creado_en);`);
  cobranzaLista = true;
}

// POST /gestion-cobranza — registra una gestión de cobranza desde la plataforma.
app.post('/gestion-cobranza', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureCobranza();
    const b = req.body || {};
    const dni = String(b.dni_cliente || '').replace(/\D/g, '');
    if (!dni) return res.status(400).json({ success: false, message: 'Falta el DNI del cliente.' });
    if (!b.estado_contacto) return res.status(400).json({ success: false, message: 'Falta el estado de contacto.' });
    const num = v => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return isFinite(n) ? n : 0; };
    const txt = v => { const s = String(v ?? '').trim(); return s || null; };
    const { rows } = await pgPool.query(
      `INSERT INTO gestion_cobranza
         (registrado_por, dni_cliente, nombre_cliente, celular, monto_adeudado,
          estado_contacto, motivo_no_pago, quien_respondio, comentario_tercero,
          resultado_gestion, fecha_compromiso, monto_pagar, observaciones, origen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'app') RETURNING id`,
      [txt(b.registrado_por), dni, txt(b.nombre_cliente), txt(b.celular), num(b.monto_adeudado),
       txt(b.estado_contacto), txt(b.motivo_no_pago), txt(b.quien_respondio), txt(b.comentario_tercero),
       txt(b.resultado_gestion), txt(b.fecha_compromiso), num(b.monto_pagar), txt(b.observaciones)]);
    res.json({ success: true, id: rows[0].id });
  } catch (e) { console.error('❌ POST /gestion-cobranza:', e); res.status(500).json({ success: false, message: e.message }); }
});

// GET /gestion-cobranza?desde&hasta&dni — lista (para un futuro módulo de control).
app.get('/gestion-cobranza', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    res.set('Cache-Control', 'no-store');
    await ensureCobranza();
    const FECHA = `creado_en AT TIME ZONE 'America/Lima'`;
    const cond = [], params = [];
    if (req.query.desde) { params.push(String(req.query.desde)); cond.push(`${FECHA}::date >= $${params.length}`); }
    if (req.query.hasta) { params.push(String(req.query.hasta)); cond.push(`${FECHA}::date <= $${params.length}`); }
    if (req.query.dni)   { params.push(String(req.query.dni).replace(/\D/g, '')); cond.push(`dni_cliente = $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(
      `SELECT id, registrado_por, dni_cliente, nombre_cliente, celular, monto_adeudado,
              estado_contacto, motivo_no_pago, quien_respondio, comentario_tercero,
              resultado_gestion, fecha_compromiso, monto_pagar, observaciones,
              to_char(${FECHA}, 'DD/MM/YYYY HH24:MI:SS') AS marca
       FROM gestion_cobranza ${where} ORDER BY creado_en DESC`, params);
    res.json(rows);
  } catch (e) { console.error('❌ GET /gestion-cobranza:', e); res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// 📦 LOGÍSTICA — CONTROL DE ENTREGAS (tabla entregas)
//   Planificación de entregas (DNI + producto + fecha + sede) con estado
//   PENDIENTE→ENTREGADO. El nombre del cliente es OPCIONAL (las ventas no siempre
//   están facturadas); el cruce con ventas se hace luego por DNI si se requiere.
// ═════════════════════════════════════════════════════════════════════════════
let entregasLista = false;
async function ensureEntregas() {
  if (!pgPool || entregasLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS entregas (
      id BIGSERIAL PRIMARY KEY,
      dni_cliente     TEXT NOT NULL,
      cliente_nombre  TEXT,
      producto        TEXT NOT NULL,
      codigo_cv       TEXT,
      fecha_entrega   DATE NOT NULL,
      sede            TEXT,
      celular         TEXT,
      direccion       TEXT,
      coordenadas     TEXT,
      vehiculo        TEXT,
      observacion     TEXT,
      estado          TEXT NOT NULL DEFAULT 'PENDIENTE',
      motivo_anulacion TEXT,
      motivo_reprogramacion TEXT,
      veces_reprogramada INT NOT NULL DEFAULT 0,
      registrado_por  TEXT,
      entregado_por   TEXT,
      fecha_entregado TIMESTAMPTZ,
      creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE entregas ADD COLUMN IF NOT EXISTS motivo_anulacion TEXT;
    ALTER TABLE entregas ADD COLUMN IF NOT EXISTS coordenadas TEXT;
    ALTER TABLE entregas ADD COLUMN IF NOT EXISTS motivo_reprogramacion TEXT;
    ALTER TABLE entregas ADD COLUMN IF NOT EXISTS veces_reprogramada INT NOT NULL DEFAULT 0;
    ALTER TABLE entregas ADD COLUMN IF NOT EXISTS vehiculo TEXT;
    ALTER TABLE entregas ADD COLUMN IF NOT EXISTS almacenero TEXT;
    CREATE INDEX IF NOT EXISTS ix_entregas_vehiculo ON entregas (vehiculo);
    CREATE INDEX IF NOT EXISTS ix_entregas_fecha  ON entregas (fecha_entrega);
    CREATE INDEX IF NOT EXISTS ix_entregas_sede   ON entregas (sede);
    CREATE INDEX IF NOT EXISTS ix_entregas_estado ON entregas (estado);
    CREATE INDEX IF NOT EXISTS ix_entregas_dni    ON entregas (dni_cliente);`);
  entregasLista = true;
}
const nz = (v) => { const s = String(v ?? '').trim(); return s || null; };

// POST /entregas — planifica una entrega.
app.post('/entregas', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureEntregas();
    const b = req.body || {};
    const dni = String(b.dni_cliente || '').replace(/\D/g, '');
    if (!dni) return res.status(400).json({ success: false, message: 'Falta el DNI del cliente.' });
    if (!nz(b.producto))      return res.status(400).json({ success: false, message: 'Falta el producto.' });
    if (!nz(b.fecha_entrega)) return res.status(400).json({ success: false, message: 'Falta la fecha de entrega.' });
    const { rows } = await pgPool.query(
      `INSERT INTO entregas
         (dni_cliente, cliente_nombre, producto, codigo_cv, fecha_entrega, sede,
          celular, direccion, coordenadas, observacion, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [dni, nz(b.cliente_nombre), nz(b.producto), nz(b.codigo_cv), b.fecha_entrega, nz(b.sede),
       nz(b.celular), nz(b.direccion), nz(b.coordenadas), nz(b.observacion), nz(b.registrado_por)]);
    res.json({ success: true, id: rows[0].id });
  } catch (e) { console.error('❌ POST /entregas:', e); res.status(500).json({ success: false, message: e.message }); }
});

// GET /entregas?desde&hasta&sede&estado&dni — lista (calendario / pendientes / reporte).
app.get('/entregas', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    res.set('Cache-Control', 'no-store');
    await ensureEntregas();
    const cond = [], params = [];
    if (req.query.desde)  { params.push(String(req.query.desde)); cond.push(`fecha_entrega >= $${params.length}`); }
    if (req.query.hasta)  { params.push(String(req.query.hasta)); cond.push(`fecha_entrega <= $${params.length}`); }
    if (req.query.sede)   { params.push(`%${String(req.query.sede)}%`); cond.push(`sede ILIKE $${params.length}`); }
    if (req.query.estado) { params.push(String(req.query.estado).toUpperCase()); cond.push(`UPPER(estado) = $${params.length}`); }
    if (req.query.dni)    { params.push(String(req.query.dni).replace(/\D/g, '')); cond.push(`dni_cliente = $${params.length}`); }
    if (req.query.vehiculo) { params.push(String(req.query.vehiculo).toUpperCase()); cond.push(`UPPER(COALESCE(vehiculo,'')) = $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pgPool.query(
      `SELECT id, dni_cliente, cliente_nombre, producto, codigo_cv,
              to_char(fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega, sede, celular, direccion, coordenadas, vehiculo, almacenero,
              observacion, estado, motivo_anulacion, motivo_reprogramacion, veces_reprogramada, registrado_por, entregado_por,
              to_char(fecha_entregado AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI') AS fecha_entregado,
              (estado = 'PENDIENTE' AND fecha_entrega < (now() AT TIME ZONE 'America/Lima')::date) AS vencida
       FROM entregas ${where} ORDER BY fecha_entrega, id`, params);
    res.json(rows);
  } catch (e) { console.error('❌ GET /entregas:', e); res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /entregas/entregar — marca varias como ENTREGADO (flujo de checks + Guardar).
// body { ids:[...], entregado_por, entregado?:bool } (entregado:false = desmarcar).
app.patch('/entregas/entregar', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureEntregas();
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ success: false, message: 'No se indicaron entregas.' });
    const marcar = b.entregado !== false;
    const { rowCount } = await pgPool.query(
      marcar
        ? `UPDATE entregas SET estado='ENTREGADO', entregado_por=$2, fecha_entregado=now(), actualizado_en=now() WHERE id = ANY($1)`
        : `UPDATE entregas SET estado='PENDIENTE', entregado_por=NULL, fecha_entregado=NULL, actualizado_en=now() WHERE id = ANY($1)`,
      marcar ? [ids, nz(b.entregado_por)] : [ids]);
    res.json({ success: true, actualizados: rowCount });
  } catch (e) { console.error('❌ PATCH /entregas/entregar:', e); res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /entregas/reprogramar — nueva fecha + motivo para varias entregas (cliente no
// ubicado, solicitó otra fecha, etc.). Suma 1 a veces_reprogramada y vuelve a PENDIENTE.
app.patch('/entregas/reprogramar', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureEntregas();
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ success: false, message: 'No se indicaron entregas.' });
    if (!nz(b.fecha_entrega)) return res.status(400).json({ success: false, message: 'Falta la nueva fecha.' });
    if (!nz(b.motivo)) return res.status(400).json({ success: false, message: 'Falta el motivo.' });
    const { rowCount } = await pgPool.query(
      `UPDATE entregas SET fecha_entrega = $2, motivo_reprogramacion = $3,
              veces_reprogramada = veces_reprogramada + 1, estado = 'PENDIENTE',
              actualizado_en = now()
       WHERE id = ANY($1)`,
      [ids, b.fecha_entrega, nz(b.motivo)]);
    res.json({ success: true, actualizados: rowCount });
  } catch (e) { console.error('❌ PATCH /entregas/reprogramar:', e); res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /entregas/asignar-vehiculo — asigna (o quita) el carro de reparto a varias
// entregas. vehiculo ∈ {AZUL, VERDE, NARANJA} o vacío/null para desasignar.
app.patch('/entregas/asignar-vehiculo', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureEntregas();
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ success: false, message: 'No se indicaron entregas.' });
    const veh = nz(b.vehiculo) ? String(b.vehiculo).toUpperCase() : null;
    const { rowCount } = await pgPool.query(
      `UPDATE entregas SET vehiculo = $2, actualizado_en = now() WHERE id = ANY($1)`, [ids, veh]);
    res.json({ success: true, actualizados: rowCount });
  } catch (e) { console.error('❌ PATCH /entregas/asignar-vehiculo:', e); res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /entregas/asignar-almacenero — asigna (o quita) el almacenero a varias entregas
// (p. ej. todas las de un carro). almacenero = nombre del usuario o vacío/null para quitar.
app.patch('/entregas/asignar-almacenero', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureEntregas();
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ success: false, message: 'No se indicaron entregas.' });
    const { rowCount } = await pgPool.query(
      `UPDATE entregas SET almacenero = $2, actualizado_en = now() WHERE id = ANY($1)`, [ids, nz(b.almacenero)]);
    res.json({ success: true, actualizados: rowCount });
  } catch (e) { console.error('❌ PATCH /entregas/asignar-almacenero:', e); res.status(500).json({ success: false, message: e.message }); }
});

// PUT /entregas/:id — editar / reprogramar.
app.put('/entregas/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureEntregas();
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const campos = [], params = [];
    const set = (col, val) => { params.push(val); campos.push(`${col} = $${params.length}`); };
    if (b.cliente_nombre !== undefined) set('cliente_nombre', nz(b.cliente_nombre));
    if (b.producto !== undefined)       set('producto', nz(b.producto));
    if (b.fecha_entrega !== undefined)  set('fecha_entrega', b.fecha_entrega);
    if (b.sede !== undefined)           set('sede', nz(b.sede));
    if (b.celular !== undefined)        set('celular', nz(b.celular));
    if (b.direccion !== undefined)      set('direccion', nz(b.direccion));
    if (b.coordenadas !== undefined)    set('coordenadas', nz(b.coordenadas));
    if (b.vehiculo !== undefined)       set('vehiculo', nz(b.vehiculo));
    if (b.observacion !== undefined)    set('observacion', nz(b.observacion));
    if (b.estado !== undefined)         set('estado', String(b.estado).toUpperCase());
    if (b.motivo_anulacion !== undefined) set('motivo_anulacion', nz(b.motivo_anulacion));
    if (!campos.length) return res.status(400).json({ success: false, message: 'Nada que actualizar.' });
    params.push(id);
    const { rowCount } = await pgPool.query(
      `UPDATE entregas SET ${campos.join(', ')}, actualizado_en = now() WHERE id = $${params.length}`, params);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Entrega no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ PUT /entregas/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /entregas/:id
app.delete('/entregas/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureEntregas();
    const { rowCount } = await pgPool.query('DELETE FROM entregas WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Entrega no encontrada.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /entregas/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// 📦 INVENTARIO DE PRODUCTOS (lista importada de Excel) → alimenta el combo de
//    "Producto a entregar" en Registro de Entregas (búsqueda + multi-selección).
// ═════════════════════════════════════════════════════════════════════════════
let inventarioLista = false;
async function ensureInventario() {
  if (!pgPool || inventarioLista) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS productos_inventario (
      id BIGSERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_prodinv_nombre ON productos_inventario ((lower(trim(nombre))));`);
  inventarioLista = true;
}

// POST /productos-inventario/bulk { productos: [...], reemplazar?:bool } — inserta la lista
// del Excel (evita duplicados por nombre). Si reemplazar=true, borra todo antes.
app.post('/productos-inventario/bulk', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureInventario();
    const b = req.body || {};
    const nombres = [...new Set((Array.isArray(b.productos) ? b.productos : [])
      .map(x => String(x ?? '').trim()).filter(Boolean))];
    if (!nombres.length) return res.status(400).json({ success: false, message: 'No se recibieron productos.' });
    const client = await pgPool.connect();
    let insertados = 0;
    try {
      await client.query('BEGIN');
      if (b.reemplazar) await client.query('TRUNCATE productos_inventario RESTART IDENTITY');
      const CHUNK = 500;
      for (let i = 0; i < nombres.length; i += CHUNK) {
        const chunk = nombres.slice(i, i + CHUNK);
        const vals = chunk.map((_, j) => `($${j + 1})`).join(',');
        const r = await client.query(
          `INSERT INTO productos_inventario (nombre) VALUES ${vals}
           ON CONFLICT ((lower(trim(nombre)))) DO NOTHING`, chunk);
        insertados += r.rowCount;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const { rows: tot } = await pgPool.query('SELECT COUNT(*)::int n FROM productos_inventario');
    res.json({ success: true, recibidos: nombres.length, insertados, duplicados: nombres.length - insertados, total: tot[0].n });
  } catch (e) { console.error('❌ POST /productos-inventario/bulk:', e); res.status(500).json({ success: false, message: e.message }); }
});

// GET /productos-inventario?q=&limit= — lista/búsqueda de productos (nombres).
app.get('/productos-inventario', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureInventario();
    const cond = [], params = [];
    if (req.query.q) { params.push(`%${String(req.query.q).trim()}%`); cond.push(`nombre ILIKE $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const lim = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
    const { rows } = await pgPool.query(
      `SELECT id, nombre FROM productos_inventario ${where} ORDER BY nombre LIMIT ${lim}`, params);
    res.json(rows);
  } catch (e) { console.error('❌ GET /productos-inventario:', e); res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /productos-inventario/:id — elimina un producto del inventario.
app.delete('/productos-inventario/:id', async (req, res) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try {
    await ensureInventario();
    const { rowCount } = await pgPool.query('DELETE FROM productos_inventario WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Producto no encontrado.' });
    res.json({ success: true });
  } catch (e) { console.error('❌ DELETE /productos-inventario/:id:', e); res.status(500).json({ success: false, message: e.message }); }
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  ok: true, service: 'gestion-service', db: !!pgPool, ts: new Date().toISOString(),
}));

module.exports = app;   // (Unificado) sin listen: escucha el server.js unificado
