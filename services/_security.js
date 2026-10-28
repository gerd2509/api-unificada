// ─────────────────────────────────────────────────────────────────────────────
// Middlewares de seguridad comunes a los 4 sub-servicios (sheets/ventas/gestion/aula).
// Cada services/*.js es su propia app de Express (montada por prefijo en server.js),
// así que cada una necesita aplicar esto por separado — los settings de Express
// (como trust proxy) NO se heredan entre una app padre y una app montada.
// ─────────────────────────────────────────────────────────────────────────────
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

// Firma los tokens de sesión (JWT) y los de servicio (llamadas internas entre
// microservicios). OBLIGATORIO en producción — sin esto el servidor no arranca,
// a propósito: mejor que falle al desplegar a que corra "autenticando" con un
// secreto vacío/adivinable.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('Falta JWT_SECRET en las variables de entorno — es obligatorio para firmar/validar sesiones.');
}

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

/** Límite para el login: frena fuerza bruta de contraseñas sin bloquear el uso
 *  real. OJO: muchas personas de la MISMA tienda/oficina comparten una sola IP
 *  pública (NAT) — con 15/15min, dos o tres personas probando usuario/clave en
 *  la misma ventana (o alguien reintentando) ya tumbaba el login para TODOS los
 *  que están detrás de esa IP. 60 sigue siendo demasiado bajo para que un
 *  ataque de fuerza bruta real llegue a algo contra bcrypt, pero no golpea el
 *  uso normal de varias personas a la vez. Se aplica SOLO a /auth/login y
 *  /auth/cambiar-password, no a todo el servicio. */
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos de inicio de sesión. Espera unos minutos.' },
});

/** Aplica trust proxy + helmet + CORS + límite general. Llamar justo después de
 *  crear la app, ANTES de express.json() y de las rutas. */
function aplicarSeguridad(app) {
  // Render sirve *.onrender.com detrás de Cloudflare — la cadena real es
  // cliente → Cloudflare → proxy de Render → esta app, 2 saltos antes de
  // llegar acá. Con trust proxy=1 (un solo salto) el req.ip resuelto era el
  // del proxy interno de Render, NO el del cliente — y como ese proxy es el
  // MISMO para toda la app, todo el tráfico terminaba compartiendo un único
  // cupo de rate limit (el incidente real: alguien probando varias cuentas
  // agotó el límite de login para cualquiera que entrara después). Con 2 se
  // resuelve la IP real del cliente, uno por persona.
  app.set('trust proxy', 2);
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

// ─────────────────────────────────────────────────────────────────────────────
// Autenticación (JWT): el login firma un token con la identidad del usuario;
// cada ruta (salvo las explícitamente públicas) lo exige en el header
// `Authorization: Bearer <token>` y lo deja en `req.usuario`.
// ─────────────────────────────────────────────────────────────────────────────

/** Firma el token de sesión de un usuario logueado. 12h = una jornada; después
 *  tiene que volver a loguearse (igual que el cierre por inactividad del front,
 *  pero validado del lado del servidor, no solo de palabra). */
function firmarToken(usuario) {
  const payload = {
    usuario: usuario.usuario, nombre: usuario.nombre, rol: usuario.rol,
    sede: usuario.sede, sedes: usuario.sedes, vendedor: usuario.vendedor,
    canal: usuario.canal, modulos: usuario.modulos,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

/** Token de SERVICIO (no de un usuario) para las llamadas internas entre
 *  microservicios (p.ej. gestion.js → GET /sheets/data/sedes). Larga duración:
 *  es interno, no lo ve ningún navegador, y rotarlo requiere redeploy de ambos
 *  lados a la vez. */
function firmarTokenServicio() {
  return jwt.sign({ servicio: true }, JWT_SECRET, { expiresIn: '3650d' });
}

/** Crea el middleware que exige el token en cada request, salvo las rutas
 *  públicas que se le pasen (método + path EXACTOS, relativos al mount point:
 *  dentro de sheets.js un POST a /sheets/auth/login llega como '/auth/login'). */
function crearRequireAuth(rutasPublicas = []) {
  return function requireAuth(req, res, next) {
    const esPublica = rutasPublicas.some(r => r.metodo === req.method && r.ruta === req.path);
    if (esPublica) return next();

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ success: false, message: 'No autenticado.' });

    try {
      req.usuario = jwt.verify(token, JWT_SECRET);
      next();
    } catch (e) {
      res.status(401).json({ success: false, message: 'Sesión inválida o expirada. Vuelve a iniciar sesión.' });
    }
  };
}

module.exports = { aplicarSeguridad, limiteLogin, firmarToken, firmarTokenServicio, crearRequireAuth };
