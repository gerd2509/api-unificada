// ─────────────────────────────────────────────────────────────────────────────
// GET /health/deep — salud "por dentro" de api-unificada para el Monitor PWA.
// Reporta memoria del proceso (vs. límite del heap y del contenedor), uptime
// (detecta reinicios), lag del event loop y un SELECT 1 a la base de datos.
//
// Protegido con el header  x-monitor-token: <MONITOR_TOKEN>  (variable de entorno
// en Render). Sin MONITOR_TOKEN configurado responde 404 (queda desactivado).
//
// Instalación (ver README del monitor):
//   1. Copia este archivo a api-unificada/health-deep.js
//   2. En server.js, ANTES de los app.use('/sheets'…):
//        app.use('/health', require('./health-deep'));
//   3. En Render → api-unificada → Environment: MONITOR_TOKEN = <valor aleatorio>
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const v8 = require('v8');
const { monitorEventLoopDelay } = require('perf_hooks');
const { Client } = require('pg');

const router = express.Router();
const MB = 1024 * 1024;

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

function tokenOk(given) {
  const expected = process.env.MONITOR_TOKEN;
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Límite de memoria del contenedor (cgroup v2 / v1), si se puede leer. */
function containerLimitBytes() {
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      const n = Number(v);
      if (v !== 'max' && Number.isFinite(n) && n > 0 && n < 1e15) return n;
    } catch { /* no disponible */ }
  }
  return null;
}

async function dbPing() {
  if (!process.env.DATABASE_URL) return { ok: false, error: 'Sin DATABASE_URL' };
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  const t0 = Date.now();
  try {
    await client.connect();
    await client.query('select 1');
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  } finally {
    client.end().catch(() => {});
  }
}

router.get('/deep', async (req, res) => {
  if (!process.env.MONITOR_TOKEN) return res.status(404).end();
  if (!tokenOk(req.get('x-monitor-token'))) return res.status(401).json({ ok: false });

  const mu = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const cLimit = containerLimitBytes();
  const db = await dbPing();

  res.set('cache-control', 'no-store').json({
    ok: db.ok,
    service: 'api-unificada',
    ts: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    memory: {
      rssMB: Math.round(mu.rss / MB),
      heapUsedMB: Math.round(mu.heapUsed / MB),
      heapLimitMB: Math.round(heapLimit / MB),
      externalMB: Math.round(mu.external / MB),
      pctOfHeapLimit: Math.round((mu.heapUsed / heapLimit) * 1000) / 10,
      containerLimitMB: cLimit ? Math.round(cLimit / MB) : null,
      pctOfContainer: cLimit ? Math.round((mu.rss / cLimit) * 1000) / 10 : null,
    },
    eventLoop: {
      p99Ms: Math.round(loopDelay.percentile(99) / 1e6),
      maxMs: Math.round(loopDelay.max / 1e6),
    },
    db,
  });
  loopDelay.reset();
});

module.exports = router;
