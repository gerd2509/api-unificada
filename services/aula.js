// ─────────────────────────────────────────────────────────────────────────────
// aula.js — Aula Virtual (capacitación de vendedores)
// Cursos → Lecciones (PDF) → Preguntas (generadas por IA, revisadas por el admin
// antes de publicarse) → Progreso/Examen por vendedor → Gamificación (XP, nivel,
// racha, insignias, ranking). Misma BD (DATABASE_URL) que el resto de api-unificada.
// PDFs en Supabase Storage (bucket privado "aula-virtual"), igual patrón que las
// fotos del supervisor en gestion.js.
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4005;

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ── Supabase Storage (PDFs del aula, bucket privado) — mismo patrón que gestion.js ──
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = 'aula-virtual';
const storageOn = () => !!(SB_URL && SB_KEY);
const sbHeaders = (extra = {}) => ({ Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY, ...extra });

let bucketListo = false;
async function asegurarBucket() {
  if (!storageOn() || bucketListo) return;
  try {
    await fetch(`${SB_URL}/storage/v1/bucket`, {
      method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 41943040 }),
    });
  } catch { /* ya existe o no se pudo — se reintenta en la próxima subida */ }
  bucketListo = true;
}

async function subirArchivo(buffer, mime, path) {
  if (!storageOn()) throw new Error('Storage no configurado (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  await asegurarBucket();
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST', headers: sbHeaders({ 'Content-Type': mime, 'x-upsert': 'true' }), body: buffer,
  });
  if (!r.ok) throw new Error('Storage upload ' + r.status + ' ' + (await r.text().catch(() => '')));
  return path;
}
async function urlFirmada(path, seg = 7200) {
  if (!path || !storageOn()) return null;
  try {
    const r = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: seg }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.signedURL ? `${SB_URL}/storage/v1${j.signedURL}` : null;
  } catch { return null; }
}
async function descargarArchivo(path) {
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error('No se pudo leer el archivo del curso.');
  return Buffer.from(await r.arrayBuffer());
}

// ── Esquema ───────────────────────────────────────────────────────────────────
let schemaListo = false;
async function ensureSchema() {
  if (!pgPool || schemaListo) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS aula_cursos (
      id            BIGSERIAL PRIMARY KEY,
      titulo        TEXT NOT NULL,
      descripcion   TEXT,
      canal         TEXT NOT NULL DEFAULT 'todos',
      icono         TEXT DEFAULT 'school',
      color         TEXT DEFAULT '#1A5FAD',
      orden         INT DEFAULT 0,
      activo        BOOLEAN NOT NULL DEFAULT true,
      creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS aula_lecciones (
      id             BIGSERIAL PRIMARY KEY,
      curso_id       BIGINT NOT NULL REFERENCES aula_cursos(id) ON DELETE CASCADE,
      titulo         TEXT NOT NULL,
      tipo           TEXT NOT NULL DEFAULT 'pdf',
      archivo_path   TEXT,
      archivo_nombre TEXT,
      orden          INT DEFAULT 0,
      xp             INT NOT NULL DEFAULT 100,
      activo         BOOLEAN NOT NULL DEFAULT true,
      creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS aula_preguntas (
      id                  BIGSERIAL PRIMARY KEY,
      leccion_id          BIGINT NOT NULL REFERENCES aula_lecciones(id) ON DELETE CASCADE,
      pregunta            TEXT NOT NULL,
      opciones            JSONB NOT NULL,
      respuesta_correcta  INT NOT NULL,
      explicacion         TEXT,
      aprobada            BOOLEAN NOT NULL DEFAULT false,
      origen              TEXT NOT NULL DEFAULT 'ia',
      orden               INT DEFAULT 0,
      creado_en           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS aula_progreso (
      id              BIGSERIAL PRIMARY KEY,
      vendedor        TEXT NOT NULL,
      leccion_id      BIGINT NOT NULL REFERENCES aula_lecciones(id) ON DELETE CASCADE,
      visto           BOOLEAN NOT NULL DEFAULT false,
      fecha_visto     TIMESTAMPTZ,
      intentos        INT NOT NULL DEFAULT 0,
      mejor_puntaje   NUMERIC NOT NULL DEFAULT 0,
      aprobado        BOOLEAN NOT NULL DEFAULT false,
      fecha_aprobado  TIMESTAMPTZ,
      UNIQUE(vendedor, leccion_id)
    );
    CREATE TABLE IF NOT EXISTS aula_actividad (
      vendedor TEXT NOT NULL,
      fecha    DATE NOT NULL,
      PRIMARY KEY (vendedor, fecha)
    );
    CREATE TABLE IF NOT EXISTS aula_insignias_vendedor (
      id        BIGSERIAL PRIMARY KEY,
      vendedor  TEXT NOT NULL,
      codigo    TEXT NOT NULL,
      fecha     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(vendedor, codigo)
    );
    CREATE INDEX IF NOT EXISTS ix_al_curso   ON aula_lecciones (curso_id);
    CREATE INDEX IF NOT EXISTS ix_ap_leccion ON aula_preguntas (leccion_id);
    CREATE INDEX IF NOT EXISTS ix_apr_vend   ON aula_progreso (vendedor);
    CREATE INDEX IF NOT EXISTS ix_aa_vend    ON aula_actividad (vendedor);
  `);
  schemaListo = true;
}
app.use(async (_req, res, next) => {
  if (!pgPool) return res.status(500).json({ success: false, message: 'Base de datos no configurada.' });
  try { await ensureSchema(); next(); } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Catálogo de insignias (fijo en código; se evalúan y se guardan cuando se ganan) ──
const INSIGNIAS = [
  { codigo: 'primer_paso',    nombre: 'Primer Paso',   descripcion: 'Completaste tu primera lección',      icono: '🎯' },
  { codigo: 'perfeccionista', nombre: 'Perfeccionista', descripcion: 'Sacaste 100% en un examen',           icono: '💯' },
  { codigo: 'racha_3',        nombre: 'Constante',      descripcion: '3 días seguidos aprendiendo',         icono: '🔥' },
  { codigo: 'racha_7',        nombre: 'Imparable',      descripcion: '7 días seguidos aprendiendo',         icono: '⚡' },
  { codigo: 'graduado',       nombre: 'Graduado',       descripcion: 'Completaste un curso entero',         icono: '🎓' },
  { codigo: 'maratonista',    nombre: 'Maratonista',    descripcion: 'Aprobaste 5 lecciones',                icono: '🏅' },
];
const NOTA_APROBATORIA = 70;
const XP_POR_NIVEL = 500;

function nivelDe(xp) { return 1 + Math.floor(xp / XP_POR_NIVEL); }

// Registra actividad de hoy (para la racha) — idempotente.
async function registrarActividad(vendedor) {
  await pgPool.query(
    `INSERT INTO aula_actividad (vendedor, fecha) VALUES ($1, CURRENT_DATE) ON CONFLICT DO NOTHING`, [vendedor]);
}
// Racha = días consecutivos (incluye hoy o ayer) con actividad.
async function calcularRacha(vendedor) {
  const { rows } = await pgPool.query(
    `SELECT fecha FROM aula_actividad WHERE vendedor = $1 ORDER BY fecha DESC LIMIT 60`, [vendedor]);
  if (!rows.length) return 0;
  let racha = 0;
  let cursor = new Date(); cursor.setHours(0, 0, 0, 0);
  const fechas = new Set(rows.map(r => new Date(r.fecha).toISOString().slice(0, 10)));
  // Si no hay actividad hoy, la racha puede seguir contando desde ayer (no se rompe hasta medianoche+1 sin actividad).
  if (!fechas.has(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1);
  while (fechas.has(cursor.toISOString().slice(0, 10))) { racha++; cursor.setDate(cursor.getDate() - 1); }
  return racha;
}
// Evalúa y otorga (idempotente) las insignias ganadas; devuelve las NUEVAS de esta pasada.
async function evaluarInsignias(vendedor) {
  const [{ rows: r1 }, { rows: r2 }, { rows: r3 }] = await Promise.all([
    pgPool.query(`SELECT COUNT(*) FILTER (WHERE visto) AS vistas, COUNT(*) FILTER (WHERE aprobado) AS aprobadas,
                    COUNT(*) FILTER (WHERE mejor_puntaje >= 100) AS perfectas
                  FROM aula_progreso WHERE vendedor = $1`, [vendedor]),
    pgPool.query(`
      SELECT c.id FROM aula_cursos c
      WHERE c.activo AND EXISTS (SELECT 1 FROM aula_lecciones l WHERE l.curso_id = c.id AND l.activo)
        AND NOT EXISTS (
          SELECT 1 FROM aula_lecciones l WHERE l.curso_id = c.id AND l.activo
            AND NOT EXISTS (SELECT 1 FROM aula_progreso p WHERE p.leccion_id = l.id AND p.vendedor = $1 AND p.aprobado)
        )`, [vendedor]),
    Promise.resolve({ rows: [] }),
  ]);
  const racha = await calcularRacha(vendedor);
  const stats = r1[0] || {};
  const candidatos = [];
  if (Number(stats.vistas) >= 1) candidatos.push('primer_paso');
  if (Number(stats.perfectas) >= 1) candidatos.push('perfeccionista');
  if (Number(stats.aprobadas) >= 5) candidatos.push('maratonista');
  if (racha >= 3) candidatos.push('racha_3');
  if (racha >= 7) candidatos.push('racha_7');
  if (r2.length >= 1) candidatos.push('graduado');
  if (!candidatos.length) return [];
  const { rows: nuevas } = await pgPool.query(
    `INSERT INTO aula_insignias_vendedor (vendedor, codigo)
     SELECT $1, x FROM unnest($2::text[]) AS x
     ON CONFLICT (vendedor, codigo) DO NOTHING RETURNING codigo`, [vendedor, candidatos]);
  return nuevas.map(r => INSIGNIAS.find(i => i.codigo === r.codigo)).filter(Boolean);
}

const norm = s => (s ?? '').toString().trim();

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN — Cursos
// ═════════════════════════════════════════════════════════════════════════════
app.get('/admin/cursos', async (_req, res) => {
  try {
    const { rows } = await pgPool.query(`
      SELECT c.*, COUNT(l.id)::int AS lecciones
      FROM aula_cursos c LEFT JOIN aula_lecciones l ON l.curso_id = c.id AND l.activo
      GROUP BY c.id ORDER BY c.orden, c.id`);
    res.json(rows);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/admin/cursos', async (req, res) => {
  try {
    const { titulo, descripcion, canal, icono, color, orden } = req.body || {};
    if (!norm(titulo)) return res.status(400).json({ success: false, message: 'El título es obligatorio.' });
    const { rows } = await pgPool.query(
      `INSERT INTO aula_cursos (titulo, descripcion, canal, icono, color, orden) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [titulo, descripcion || '', canal || 'todos', icono || 'school', color || '#1A5FAD', orden || 0]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.put('/admin/cursos/:id', async (req, res) => {
  try {
    const { titulo, descripcion, canal, icono, color, orden, activo } = req.body || {};
    const { rows } = await pgPool.query(
      `UPDATE aula_cursos SET titulo=COALESCE($2,titulo), descripcion=COALESCE($3,descripcion),
        canal=COALESCE($4,canal), icono=COALESCE($5,icono), color=COALESCE($6,color),
        orden=COALESCE($7,orden), activo=COALESCE($8,activo) WHERE id=$1 RETURNING *`,
      [req.params.id, titulo, descripcion, canal, icono, color, orden, activo]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Curso no encontrado.' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.delete('/admin/cursos/:id', async (req, res) => {
  try { await pgPool.query('DELETE FROM aula_cursos WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── ADMIN — Lecciones ──────────────────────────────────────────────────────────
app.get('/admin/cursos/:id/lecciones', async (req, res) => {
  try {
    const { rows } = await pgPool.query(`
      SELECT l.*, COUNT(p.id)::int AS preguntas, COUNT(p.id) FILTER (WHERE p.aprobada)::int AS preguntas_aprobadas
      FROM aula_lecciones l LEFT JOIN aula_preguntas p ON p.leccion_id = l.id
      WHERE l.curso_id = $1 GROUP BY l.id ORDER BY l.orden, l.id`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/admin/lecciones', upload.single('archivo'), async (req, res) => {
  try {
    const { curso_id, titulo, orden, xp } = req.body || {};
    if (!norm(curso_id) || !norm(titulo)) return res.status(400).json({ success: false, message: 'curso_id y título son obligatorios.' });
    let archivo_path = null, archivo_nombre = null;
    if (req.file) {
      const ext = (req.file.originalname.split('.').pop() || 'pdf').toLowerCase();
      archivo_path = `${curso_id}/${Date.now()}.${ext}`;
      archivo_nombre = req.file.originalname;
      await subirArchivo(req.file.buffer, req.file.mimetype || 'application/pdf', archivo_path);
    }
    const { rows } = await pgPool.query(
      `INSERT INTO aula_lecciones (curso_id, titulo, archivo_path, archivo_nombre, orden, xp)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [curso_id, titulo, archivo_path, archivo_nombre, orden || 0, xp || 100]);
    res.json(rows[0]);
  } catch (e) { console.error('❌ POST /aula/admin/lecciones', e); res.status(500).json({ success: false, message: e.message }); }
});
app.put('/admin/lecciones/:id', upload.single('archivo'), async (req, res) => {
  try {
    const { titulo, orden, xp, activo, curso_id } = req.body || {};
    let archivoSet = '', params = [req.params.id, titulo, orden, xp, activo, curso_id];
    if (req.file) {
      const cid = curso_id || (await pgPool.query('SELECT curso_id FROM aula_lecciones WHERE id=$1', [req.params.id])).rows[0]?.curso_id;
      const ext = (req.file.originalname.split('.').pop() || 'pdf').toLowerCase();
      const path = `${cid}/${Date.now()}.${ext}`;
      await subirArchivo(req.file.buffer, req.file.mimetype || 'application/pdf', path);
      archivoSet = ', archivo_path = $7, archivo_nombre = $8';
      params.push(path, req.file.originalname);
    }
    const { rows } = await pgPool.query(
      `UPDATE aula_lecciones SET titulo=COALESCE($2,titulo), orden=COALESCE($3,orden), xp=COALESCE($4,xp),
        activo=COALESCE($5,activo), curso_id=COALESCE($6,curso_id) ${archivoSet} WHERE id=$1 RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Lección no encontrada.' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.delete('/admin/lecciones/:id', async (req, res) => {
  try { await pgPool.query('DELETE FROM aula_lecciones WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── ADMIN — Preguntas (generación por IA + edición/aprobación) ────────────────
app.get('/admin/lecciones/:id/preguntas', async (req, res) => {
  try {
    const { rows } = await pgPool.query('SELECT * FROM aula_preguntas WHERE leccion_id=$1 ORDER BY orden, id', [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post('/admin/preguntas', async (req, res) => {
  try {
    const { leccion_id, pregunta, opciones, respuesta_correcta, explicacion } = req.body || {};
    if (!norm(leccion_id) || !norm(pregunta) || !Array.isArray(opciones) || opciones.length < 2)
      return res.status(400).json({ success: false, message: 'Faltan datos de la pregunta.' });
    const { rows } = await pgPool.query(
      `INSERT INTO aula_preguntas (leccion_id, pregunta, opciones, respuesta_correcta, explicacion, aprobada, origen)
       VALUES ($1,$2,$3,$4,$5,true,'manual') RETURNING *`,
      [leccion_id, pregunta, JSON.stringify(opciones), respuesta_correcta || 0, explicacion || '']);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.put('/admin/preguntas/:id', async (req, res) => {
  try {
    const { pregunta, opciones, respuesta_correcta, explicacion, aprobada } = req.body || {};
    const { rows } = await pgPool.query(
      `UPDATE aula_preguntas SET pregunta=COALESCE($2,pregunta), opciones=COALESCE($3,opciones),
        respuesta_correcta=COALESCE($4,respuesta_correcta), explicacion=COALESCE($5,explicacion),
        aprobada=COALESCE($6,aprobada) WHERE id=$1 RETURNING *`,
      [req.params.id, pregunta, opciones ? JSON.stringify(opciones) : null, respuesta_correcta, explicacion, aprobada]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Pregunta no encontrada.' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.delete('/admin/preguntas/:id', async (req, res) => {
  try { await pgPool.query('DELETE FROM aula_preguntas WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Extrae texto de un PDF (buffer) — pdf-parse es puro JS, sin dependencias nativas.
async function extraerTextoPdf(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return (data.text || '').trim();
}

// Genera preguntas BORRADOR con IA a partir del contenido de la lección (PDF).
// Quedan con aprobada=false: el admin las revisa/edita/aprueba antes de publicarlas.
app.post('/admin/lecciones/:id/generar-preguntas', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ success: false, message: 'Falta configurar ANTHROPIC_API_KEY en el servidor. Mientras tanto puedes crear las preguntas manualmente.' });
  try {
    const { rows } = await pgPool.query('SELECT * FROM aula_lecciones WHERE id=$1', [req.params.id]);
    const leccion = rows[0];
    if (!leccion) return res.status(404).json({ success: false, message: 'Lección no encontrada.' });
    if (!leccion.archivo_path) return res.status(400).json({ success: false, message: 'La lección no tiene un archivo PDF cargado.' });

    const buffer = await descargarArchivo(leccion.archivo_path);
    const texto = (await extraerTextoPdf(buffer)).slice(0, 14000);
    if (!texto || texto.length < 40)
      return res.status(400).json({ success: false, message: 'No se pudo extraer texto legible del PDF (¿son solo imágenes?). Crea las preguntas manualmente.' });

    const cantidad = Math.min(8, Math.max(3, parseInt(req.body?.cantidad, 10) || 5));
    const prompt = `Eres un experto en capacitación de equipos de ventas. A partir del siguiente contenido de una `
      + `diapositiva/material de entrenamiento, genera ${cantidad} preguntas de opción múltiple (4 alternativas cada `
      + `una, solo UNA correcta) para evaluar la comprensión de un vendedor. Las preguntas deben ser claras, en `
      + `español, y basarse ÚNICAMENTE en el contenido dado (no inventes datos que no estén ahí).\n\n`
      + `Responde ÚNICAMENTE con un JSON array (sin texto adicional, sin markdown) con este formato exacto:\n`
      + `[{"pregunta":"...","opciones":["...","...","...","..."],"respuesta_correcta":0,"explicacion":"..."}]\n\n`
      + `"respuesta_correcta" es el índice (0-3) de la opción correcta dentro de "opciones".\n\n`
      + `--- CONTENIDO ---\n${texto}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) throw new Error('IA respondió ' + resp.status + ': ' + (await resp.text().catch(() => '')));
    const data = await resp.json();
    let texto2 = (data.content || []).map(c => c.text || '').join('').trim();
    texto2 = texto2.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    let preguntas;
    try { preguntas = JSON.parse(texto2); } catch { throw new Error('La IA no devolvió un JSON válido.'); }
    if (!Array.isArray(preguntas) || !preguntas.length) throw new Error('La IA no generó preguntas.');

    const creadas = [];
    for (const [i, p] of preguntas.entries()) {
      if (!p || !p.pregunta || !Array.isArray(p.opciones) || p.opciones.length < 2) continue;
      const { rows: ins } = await pgPool.query(
        `INSERT INTO aula_preguntas (leccion_id, pregunta, opciones, respuesta_correcta, explicacion, aprobada, origen, orden)
         VALUES ($1,$2,$3,$4,$5,false,'ia',$6) RETURNING *`,
        [leccion.id, p.pregunta, JSON.stringify(p.opciones), Number(p.respuesta_correcta) || 0, p.explicacion || '', i]);
      creadas.push(ins[0]);
    }
    if (!creadas.length) return res.status(400).json({ success: false, message: 'La IA no generó preguntas utilizables.' });
    res.json({ success: true, preguntas: creadas });
  } catch (e) {
    console.error('❌ POST /aula/admin/.../generar-preguntas', e);
    res.status(500).json({ success: false, message: e.message || 'No se pudieron generar las preguntas.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// VENDEDOR — Cursos, lecciones, examen, progreso, ranking
// ═════════════════════════════════════════════════════════════════════════════

// Cursos activos para el canal del vendedor + su progreso resumido.
app.get('/cursos', async (req, res) => {
  try {
    const canal = norm(req.query.canal).toLowerCase() || 'todos';
    const vendedor = norm(req.query.vendedor);
    const { rows: cursos } = await pgPool.query(
      `SELECT * FROM aula_cursos WHERE activo AND (canal = 'todos' OR canal = $1) ORDER BY orden, id`, [canal]);
    if (!cursos.length) return res.json([]);
    const ids = cursos.map(c => c.id);
    const { rows: prog } = await pgPool.query(`
      SELECT l.curso_id, COUNT(l.id)::int AS total,
             COUNT(p.id) FILTER (WHERE p.aprobado)::int AS completadas
      FROM aula_lecciones l
      LEFT JOIN aula_progreso p ON p.leccion_id = l.id AND p.vendedor = $2
      WHERE l.curso_id = ANY($1) AND l.activo
      GROUP BY l.curso_id`, [ids, vendedor]);
    const byId = new Map(prog.map(p => [p.curso_id, p]));
    res.json(cursos.map(c => {
      const p = byId.get(c.id) || { total: 0, completadas: 0 };
      return { ...c, total_lecciones: p.total, lecciones_completadas: p.completadas,
        pct: p.total > 0 ? Math.round((p.completadas / p.total) * 100) : 0 };
    }));
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/cursos/:id/lecciones', async (req, res) => {
  try {
    const vendedor = norm(req.query.vendedor);
    const { rows } = await pgPool.query(`
      SELECT l.id, l.titulo, l.tipo, l.orden, l.xp,
             COALESCE(p.visto, false) AS visto, COALESCE(p.aprobado, false) AS aprobado,
             COALESCE(p.mejor_puntaje, 0) AS mejor_puntaje, COALESCE(p.intentos, 0) AS intentos,
             (SELECT COUNT(*) FROM aula_preguntas q WHERE q.leccion_id = l.id AND q.aprobada) > 0 AS tiene_examen
      FROM aula_lecciones l
      LEFT JOIN aula_progreso p ON p.leccion_id = l.id AND p.vendedor = $2
      WHERE l.curso_id = $1 AND l.activo ORDER BY l.orden, l.id`, [req.params.id, vendedor]);
    res.json(rows);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/lecciones/:id', async (req, res) => {
  try {
    const { rows } = await pgPool.query('SELECT * FROM aula_lecciones WHERE id=$1', [req.params.id]);
    const l = rows[0];
    if (!l) return res.status(404).json({ success: false, message: 'Lección no encontrada.' });
    // 6h de validez: tiempo suficiente para que el visor (PDF nativo u Office Online para
    // PPT/Word/Excel) termine de cargar sin que la URL firmada expire a medio visionado.
    const url = l.archivo_path ? await urlFirmada(l.archivo_path, 21600) : null;
    res.json({ ...l, url });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Marca la lección como vista (al terminar de revisar el PDF).
app.post('/lecciones/:id/visto', async (req, res) => {
  try {
    const vendedor = norm(req.body?.vendedor);
    if (!vendedor) return res.status(400).json({ success: false, message: 'Falta el vendedor.' });
    await pgPool.query(`
      INSERT INTO aula_progreso (vendedor, leccion_id, visto, fecha_visto)
      VALUES ($1,$2,true,now())
      ON CONFLICT (vendedor, leccion_id) DO UPDATE SET visto = true, fecha_visto = COALESCE(aula_progreso.fecha_visto, now())
    `, [vendedor, req.params.id]);
    await registrarActividad(vendedor);
    const nuevas = await evaluarInsignias(vendedor);
    res.json({ success: true, nuevasInsignias: nuevas });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Preguntas del examen (SIN la respuesta correcta ni la explicación).
app.get('/lecciones/:id/examen', async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT id, pregunta, opciones FROM aula_preguntas WHERE leccion_id=$1 AND aprobada ORDER BY orden, id`,
      [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Envía respuestas → califica, guarda progreso/XP, evalúa insignias.
app.post('/lecciones/:id/examen', async (req, res) => {
  try {
    const vendedor = norm(req.body?.vendedor);
    const respuestas = Array.isArray(req.body?.respuestas) ? req.body.respuestas : [];
    if (!vendedor) return res.status(400).json({ success: false, message: 'Falta el vendedor.' });
    const { rows: preguntas } = await pgPool.query(
      'SELECT id, respuesta_correcta, explicacion, opciones FROM aula_preguntas WHERE leccion_id=$1 AND aprobada', [req.params.id]);
    if (!preguntas.length) return res.status(400).json({ success: false, message: 'Esta lección aún no tiene examen publicado.' });

    const porId = new Map(respuestas.map(r => [Number(r.pregunta_id), Number(r.opcion)]));
    let correctas = 0;
    const detalle = preguntas.map(p => {
      const marcada = porId.has(p.id) ? porId.get(p.id) : -1;
      const ok = marcada === p.respuesta_correcta;
      if (ok) correctas++;
      return { pregunta_id: p.id, marcada, correcta: p.respuesta_correcta, explicacion: p.explicacion, acerto: ok };
    });
    const puntaje = Math.round((correctas / preguntas.length) * 100);
    const aprobadoAhora = puntaje >= NOTA_APROBATORIA;

    const { rows: leccionRows } = await pgPool.query('SELECT xp FROM aula_lecciones WHERE id=$1', [req.params.id]);
    const xpLeccion = leccionRows[0]?.xp || 100;

    const { rows: prevRows } = await pgPool.query(
      'SELECT aprobado FROM aula_progreso WHERE vendedor=$1 AND leccion_id=$2', [vendedor, req.params.id]);
    const yaAprobada = prevRows[0]?.aprobado || false;

    await pgPool.query(`
      INSERT INTO aula_progreso (vendedor, leccion_id, visto, fecha_visto, intentos, mejor_puntaje, aprobado, fecha_aprobado)
      VALUES ($1,$2,true,now(),1,$3,$4, CASE WHEN $4 THEN now() ELSE NULL END)
      ON CONFLICT (vendedor, leccion_id) DO UPDATE SET
        intentos = aula_progreso.intentos + 1,
        mejor_puntaje = GREATEST(aula_progreso.mejor_puntaje, $3),
        aprobado = aula_progreso.aprobado OR $4,
        fecha_aprobado = COALESCE(aula_progreso.fecha_aprobado, CASE WHEN $4 THEN now() ELSE NULL END)
    `, [vendedor, req.params.id, puntaje, aprobadoAhora]);

    await registrarActividad(vendedor);
    const nuevas = await evaluarInsignias(vendedor);
    res.json({
      puntaje, correctas, total: preguntas.length, aprobado: aprobadoAhora, detalle,
      xpGanado: (!yaAprobada && aprobadoAhora) ? xpLeccion : 0, nuevasInsignias: nuevas,
    });
  } catch (e) { console.error('❌ POST /aula/lecciones/:id/examen', e); res.status(500).json({ success: false, message: e.message }); }
});

// Mi progreso: XP total, nivel, racha, insignias.
app.get('/mi-progreso', async (req, res) => {
  try {
    const vendedor = norm(req.query.vendedor);
    if (!vendedor) return res.status(400).json({ success: false, message: 'Falta el vendedor.' });
    const { rows: xpRows } = await pgPool.query(`
      SELECT COALESCE(SUM(l.xp),0)::int AS xp, COUNT(*) FILTER (WHERE p.aprobado)::int AS lecciones_aprobadas
      FROM aula_progreso p JOIN aula_lecciones l ON l.id = p.leccion_id
      WHERE p.vendedor = $1 AND p.aprobado`, [vendedor]);
    const xp = xpRows[0]?.xp || 0;
    const racha = await calcularRacha(vendedor);
    const { rows: insigniasVend } = await pgPool.query(
      'SELECT codigo, fecha FROM aula_insignias_vendedor WHERE vendedor=$1 ORDER BY fecha DESC', [vendedor]);
    const insignias = insigniasVend.map(iv => ({ ...INSIGNIAS.find(i => i.codigo === iv.codigo), fecha: iv.fecha })).filter(i => i.codigo);
    res.json({
      xp, nivel: nivelDe(xp), xpParaSiguienteNivel: XP_POR_NIVEL - (xp % XP_POR_NIVEL),
      racha, leccionesAprobadas: xpRows[0]?.lecciones_aprobadas || 0,
      insignias, insigniasTodas: INSIGNIAS,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Ranking global por XP (top 20).
app.get('/ranking', async (_req, res) => {
  try {
    const { rows } = await pgPool.query(`
      SELECT p.vendedor, COALESCE(SUM(l.xp),0)::int AS xp, COUNT(*) FILTER (WHERE p.aprobado)::int AS lecciones
      FROM aula_progreso p JOIN aula_lecciones l ON l.id = p.leccion_id
      WHERE p.aprobado GROUP BY p.vendedor ORDER BY xp DESC LIMIT 20`);
    res.json(rows.map((r, i) => ({ ...r, puesto: i + 1, nivel: nivelDe(r.xp) })));
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'aula-virtual', ts: new Date().toISOString() }));

module.exports = app;
