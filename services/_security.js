// ─────────────────────────────────────────────────────────────────────────────
// Middlewares de seguridad comunes a los 4 sub-servicios (sheets/ventas/gestion/aula).
// Cada services/*.js es su propia app de Express (montada por prefijo en server.js),
// así que cada una necesita aplicar esto por separado — los settings de Express
// (como trust proxy) NO se heredan entre una app padre y una app montada.
// ─────────────────────────────────────────────────────────────────────────────
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ALLOWED_ORIGINS en el .env: lista separada por comas, sin espacios, p.ej.
//   ALLOWED_ORIGINS=https://dashboard-leoncito.onrender.com
// Si NO está configurada, se permite cualquier origen (comportamiento de antes) —
// nunca el default "más seguro" a costa de bloquear al propio frontend en
// producción. En cuanto se setee ALLOWED_ORIGINS, ahí sí se restringe a esa lista.
const origenesPermitidos = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origenesPermitidos.length) return cb(null, true);   // sin configurar → abierto
    // Sin origin = llamada no-browser (curl, health-check del hosting, servidor a
    // servidor) — se deja pasar. CORS es una política que solo aplica DENTRO del
    // navegador; no es un control de acceso real (eso lo hace la autenticación).
    if (!origin || origenesPermitidos.includes(origin)) return cb(null, true);
    cb(null, false);   // origen no permitido → sin cabecera CORS (el navegador bloquea la lectura)
  },
};

/** Límite general por IP: 600 peticiones / 15 min (dashboard con varias pantallas
 *  consultando seguido — generoso a propósito para no afectar el uso normal). */
const limiteGeneral = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' },
});

/** Límite estricto para el login: frena fuerza bruta de contraseñas (15 intentos
 *  cada 15 min por IP). Se aplica SOLO a /auth/login, no a todo el servicio. */
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos de inicio de sesión. Espera unos minutos.' },
});

/** Aplica trust proxy + helmet + CORS + límite general. Llamar justo después de
 *  crear la app, ANTES de express.json() y de las rutas. */
function aplicarSeguridad(app) {
  // Render (y la mayoría de hostings) ponen la app detrás de un proxy — sin esto,
  // req.ip siempre da la IP del proxy, no la del cliente real, y el rate limit por
  // IP terminaría limitando (o no limitando) a todo el mundo junto.
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: false,   // API JSON pura, sin CSP (eso lo maneja el front)
    // El front vive en OTRO origen (Render del backend ≠ Render del front) — el
    // default 'same-origin' de Helmet bloquearía la lectura cross-origin en el
    // navegador aunque CORS la permita (son mecanismos distintos). 'cross-origin'
    // deja que CORS sea quien decida.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors(corsOptions));
  app.use(limiteGeneral);
}

module.exports = { aplicarSeguridad, limiteLogin };
