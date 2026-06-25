/* Servidor local del dashboard de Yeimy — con autenticación multi-usuario.
 *
 * Roles:
 *   - admin   → ve todo (Mis Ventas, KPIs, Asesores, Inventario, Registrar, Admin)
 *   - asesor  → ve solo Inventario + Registrar Venta + Mis Registros del mes
 *
 * Cada usuario se autentica con email + clave. Las claves se guardan hasheadas
 * con bcrypt en users.json. Las sesiones se manejan con express-session
 * (cookies firmadas con SESSION_SECRET).
 *
 * El servidor escucha en HOST:PORT — para acceso desde otros dispositivos
 * en la WiFi local, dejar HOST=0.0.0.0 en .env.
 */

const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const siigo = require("./siigo");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
// DATA_DIR: en Render se usa "/data" (disk persistente). Localmente queda __dirname.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Bootstrap: copia los archivos de datos del código al DATA_DIR la PRIMERA vez.
// Después, los cambios viven solo en DATA_DIR.
function bootstrapDataDir() {
  if (DATA_DIR === __dirname) return;
  const archivos = [
    "users.json", "comisiones-pagadas.json", "preasignaciones.json",
    "docs-ventas.json", "ventas-registradas.jsonl", "precios-historial.json",
  ];
  for (const f of archivos) {
    const src = path.join(__dirname, f);
    const dst = path.join(DATA_DIR, f);
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      try { fs.copyFileSync(src, dst); console.log("  Bootstrap: copied " + f + " → " + DATA_DIR); } catch {}
    }
  }
  // Carpetas de uploads
  for (const d of ["uploads", "uploads-precios"]) {
    const src = path.join(__dirname, d);
    const dst = path.join(DATA_DIR, d);
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    if (fs.existsSync(src) && fs.existsSync(dst)) {
      try {
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const srcEntry = path.join(src, entry.name);
          const dstEntry = path.join(dst, entry.name);
          if (!fs.existsSync(dstEntry)) {
            if (entry.isDirectory()) {
              fs.cpSync(srcEntry, dstEntry, { recursive: true });
            } else {
              fs.copyFileSync(srcEntry, dstEntry);
            }
          }
        }
      } catch {}
    }
  }
}
bootstrapDataDir();

// Sincroniza usuarios nuevos del repo a /data sin TOCAR los usuarios existentes.
// Esto permite agregar nuevos perfiles (como Esteban) editando users.json del
// repo y que aparezcan en producción al deploy, preservando los hashes de
// password actuales de los usuarios que ya cambiaron su clave.
function syncUsuariosNuevos() {
  if (DATA_DIR === __dirname) return;
  const srcPath = path.join(__dirname, "users.json");
  const dstPath = path.join(DATA_DIR, "users.json");
  if (!fs.existsSync(srcPath) || !fs.existsSync(dstPath)) return;
  try {
    const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));
    const dst = JSON.parse(fs.readFileSync(dstPath, "utf8"));
    const emailsExistentes = new Set((dst.usuarios || []).map(u => (u.email || "").toLowerCase()));
    const nuevos = (src.usuarios || []).filter(u => !emailsExistentes.has((u.email || "").toLowerCase()));
    if (nuevos.length === 0) return;
    dst.usuarios = [...(dst.usuarios || []), ...nuevos];
    fs.writeFileSync(dstPath, JSON.stringify(dst, null, 2), "utf8");
    console.log(`  Sync usuarios: agregados ${nuevos.length} nuevos → ${nuevos.map(u => u.email).join(", ")}`);
  } catch (e) {
    console.warn("  Sync usuarios falló:", e.message);
  }
}
syncUsuariosNuevos();

// --- Config Impulsa (igual que antes) ---
const IMPULSA_API_KEY = process.env.IMPULSA_API_KEY || "";
const IMPULSA_ENV = (process.env.IMPULSA_ENV || "test").toLowerCase();
const IMPULSA_BASE_URL = IMPULSA_ENV === "prod"
  ? "https://apiimpulsa.impulsacrm.com/api/v2"
  : "https://apiimpulsa.azurewebsites.net/api/v2";
const ESTABLECIMIENTO = process.env.IMPULSA_ESTABLECIMIENTO || "550026948";
const USUARIO_TRAZABILIDAD = process.env.IMPULSA_USUARIO || "yeimi";
const CODIGO_DANE = process.env.IMPULSA_CODIGO_DANE || "05001";
const ORIGEN_DEFAULT = process.env.IMPULSA_ORIGEN || "Venta directa";
const CAMPANNA_DEFAULT = process.env.IMPULSA_CAMPANNA || "Venta directa";
const SESSION_SECRET = process.env.SESSION_SECRET || "cambiar-este-secreto-en-produccion";

// --- Middleware base ---
app.use(express.json({ limit: "200kb" }));
app.use(cookieParser());
const IS_PROD = process.env.NODE_ENV === "production";
if (IS_PROD) app.set("trust proxy", 1);  // necesario detrás de Render/Cloudflare
// Carpeta para guardar sesiones en disco (sobrevive a deploys/reinicios)
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.use(session({
  name: "yc.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new FileStore({
    path: SESSIONS_DIR,
    ttl: 8 * 60 * 60,           // 8h en segundos
    reapInterval: 60 * 60,      // limpiar expiradas cada 1h
    retries: 1,
    logFn: () => {},            // silenciar logs de FileStore
  }),
  cookie: {
    httpOnly: true,
    secure: IS_PROD,         // HTTPS solo en producción
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8, // 8 horas
  },
}));

// --- Usuarios ---
const USERS_PATH = path.join(DATA_DIR, "users.json");
function leerUsuarios() {
  try {
    const raw = fs.readFileSync(USERS_PATH, "utf8");
    const data = JSON.parse(raw);
    return data.usuarios || [];
  } catch {
    return [];
  }
}
function guardarUsuarios(usuarios) {
  fs.writeFileSync(USERS_PATH, JSON.stringify({ usuarios }, null, 2), "utf8");
}
function buscarUsuario(email) {
  return leerUsuarios().find(u => u.email.toLowerCase() === String(email || "").toLowerCase().trim());
}

// --- Middlewares de autorización ---
function requireAuth(req, res, next) {
  if (req.session && req.session.userEmail) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "No autenticado" });
  }
  return res.redirect("/login.html");
}
function requireAdmin(req, res, next) {
  const u = req.session && req.session.userEmail ? buscarUsuario(req.session.userEmail) : null;
  if (u && u.rol === "admin") return next();
  return res.status(403).json({ ok: false, error: "Solo administrador" });
}

// --- Rate limit por IP en /api/login (anti-brute-force) ---
// Estructura: { ip: { intentosFallidos: N, primerIntento: ts, bloqueadoHasta: ts } }
const loginAttempts = new Map();
const MAX_INTENTOS = 5;          // intentos antes de bloquear
const VENTANA_MS = 15 * 60 * 1000;  // 15 min para acumular intentos
const BLOQUEO_MS = 15 * 60 * 1000;  // 15 min bloqueado

function ipDeRequest(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.connection?.remoteAddress
    || req.ip
    || "unknown";
}

function registrarIntentoFallido(ip) {
  const ahora = Date.now();
  const reg = loginAttempts.get(ip) || { intentosFallidos: 0, primerIntento: ahora, bloqueadoHasta: 0 };
  // Si pasó la ventana, resetear contador
  if (ahora - reg.primerIntento > VENTANA_MS) {
    reg.intentosFallidos = 0;
    reg.primerIntento = ahora;
  }
  reg.intentosFallidos++;
  if (reg.intentosFallidos >= MAX_INTENTOS) {
    reg.bloqueadoHasta = ahora + BLOQUEO_MS;
    console.warn(`[seguridad] IP ${ip} BLOQUEADA por ${BLOQUEO_MS/60000} min (${reg.intentosFallidos} intentos)`);
  }
  loginAttempts.set(ip, reg);
}

function limpiarIntentos(ip) {
  loginAttempts.delete(ip);
}

function checkBloqueo(ip) {
  const reg = loginAttempts.get(ip);
  if (!reg) return null;
  const ahora = Date.now();
  if (reg.bloqueadoHasta > ahora) {
    const minRestantes = Math.ceil((reg.bloqueadoHasta - ahora) / 60000);
    return { bloqueado: true, minutosRestantes: minRestantes, intentos: reg.intentosFallidos };
  }
  // Limpiar bloqueo expirado
  if (reg.bloqueadoHasta > 0 && reg.bloqueadoHasta <= ahora) {
    loginAttempts.delete(ip);
  }
  return null;
}

// Limpieza periódica del mapa (cada hora)
setInterval(() => {
  const ahora = Date.now();
  for (const [ip, reg] of loginAttempts.entries()) {
    if (reg.bloqueadoHasta <= ahora && (ahora - reg.primerIntento) > VENTANA_MS) {
      loginAttempts.delete(ip);
    }
  }
}, 60 * 60 * 1000);

// --- Tracking de sesiones activas (para panel admin) ---
// Mapa: { email: { ip, ipPrev, lastSeen, userAgent, loginAt } }
const sesionesActivas = new Map();
const IP_CACHE_PATH = path.join(DATA_DIR, "ip-cache.json");
function leerIpCache() {
  try { if (fs.existsSync(IP_CACHE_PATH)) return JSON.parse(fs.readFileSync(IP_CACHE_PATH, "utf8")); }
  catch {}
  return {};
}
function guardarIpCache(c) {
  try { fs.writeFileSync(IP_CACHE_PATH, JSON.stringify(c, null, 2), "utf8"); } catch {}
}
async function ubicacionDeIP(ip) {
  if (!ip || ip === "unknown" || ip.startsWith("192.168.") || ip.startsWith("10.") || ip === "127.0.0.1" || ip === "::1") {
    return { ciudad: "Red local", region: "", pais: "", isp: "" };
  }
  const cache = leerIpCache();
  // Cache válido 30 días
  const treintaDiasMs = 30 * 24 * 60 * 60 * 1000;
  if (cache[ip] && (Date.now() - (cache[ip].ts || 0)) < treintaDiasMs) {
    return cache[ip];
  }
  try {
    // ip-api.com es gratuito sin api key (45 req/min)
    const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country,isp,query`);
    const data = await resp.json();
    if (data.status === "success") {
      const ubi = {
        ciudad: data.city || "",
        region: data.regionName || "",
        pais: data.country || "",
        isp: data.isp || "",
        ts: Date.now(),
      };
      cache[ip] = ubi;
      guardarIpCache(cache);
      return ubi;
    }
  } catch (e) {
    console.warn("[ip-api]", e.message);
  }
  return null;
}

// Middleware que actualiza última actividad de cada usuario logueado
app.use((req, res, next) => {
  if (req.session?.userEmail) {
    const ip = ipDeRequest(req);
    const ahora = Date.now();
    const previa = sesionesActivas.get(req.session.userEmail);
    sesionesActivas.set(req.session.userEmail, {
      email: req.session.userEmail,
      ip,
      ipPrev: previa?.ip && previa.ip !== ip ? previa.ip : (previa?.ipPrev || null),
      lastSeen: ahora,
      userAgent: req.headers["user-agent"] || "",
      loginAt: previa?.loginAt || ahora,
    });
  }
  next();
});

// Limpiar sesiones inactivas cada hora (más de 8h sin actividad)
setInterval(() => {
  const ahora = Date.now();
  const limite = 8 * 60 * 60 * 1000;
  for (const [email, info] of sesionesActivas.entries()) {
    if (ahora - info.lastSeen > limite) sesionesActivas.delete(email);
  }
}, 60 * 60 * 1000);

// --- Endpoints de auth ---
app.post("/api/login", async (req, res) => {
  const ip = ipDeRequest(req);
  // Verificar si la IP está bloqueada
  const bloqueo = checkBloqueo(ip);
  if (bloqueo) {
    return res.status(429).json({
      ok: false,
      error: `Demasiados intentos fallidos. Bloqueado por ${bloqueo.minutosRestantes} minutos. Si crees que es un error, habla con tu administrador.`,
    });
  }

  const { email, password } = req.body || {};
  const usuario = buscarUsuario(email);
  if (!usuario) {
    registrarIntentoFallido(ip);
    return res.status(401).json({ ok: false, error: "Email o clave incorrectos" });
  }
  const ok = await bcrypt.compare(String(password || ""), usuario.passwordHash);
  if (!ok) {
    registrarIntentoFallido(ip);
    const reg = loginAttempts.get(ip);
    const intentosRestantes = Math.max(0, MAX_INTENTOS - (reg?.intentosFallidos || 0));
    const aviso = intentosRestantes > 0 && intentosRestantes <= 2
      ? ` (te quedan ${intentosRestantes} intento${intentosRestantes === 1 ? "" : "s"} antes del bloqueo)`
      : "";
    return res.status(401).json({ ok: false, error: "Email o clave incorrectos" + aviso });
  }
  // Login exitoso: limpiar intentos de esa IP
  limpiarIntentos(ip);
  req.session.userEmail = usuario.email;
  return res.json({
    ok: true,
    usuario: {
      email: usuario.email,
      nombre: usuario.nombre,
      apellido: usuario.apellido,
      rol: usuario.rol,
      debeChangePass: !!usuario.debeChangePass,
    },
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ ok: false, error: "No autenticado" });
  }
  const u = buscarUsuario(req.session.userEmail);
  if (!u) return res.status(401).json({ ok: false, error: "Sesión inválida" });
  res.json({
    ok: true,
    usuario: {
      email: u.email,
      nombre: u.nombre,
      apellido: u.apellido,
      rol: u.rol,
      debeChangePass: !!u.debeChangePass,
    },
    ambiente: IMPULSA_ENV,
  });
});

app.post("/api/change-password", requireAuth, async (req, res) => {
  const { passwordActual, passwordNueva } = req.body || {};
  if (!passwordNueva || passwordNueva.length < 6) {
    return res.status(400).json({ ok: false, error: "La nueva clave debe tener al menos 6 caracteres" });
  }
  const usuarios = leerUsuarios();
  const idx = usuarios.findIndex(u => u.email.toLowerCase() === req.session.userEmail.toLowerCase());
  if (idx < 0) return res.status(401).json({ ok: false, error: "Sesión inválida" });
  const ok = await bcrypt.compare(String(passwordActual || ""), usuarios[idx].passwordHash);
  if (!ok) return res.status(401).json({ ok: false, error: "La clave actual no coincide" });
  usuarios[idx].passwordHash = await bcrypt.hash(String(passwordNueva), 10);
  usuarios[idx].debeChangePass = false;
  usuarios[idx].passwordCambiadaEn = new Date().toISOString();
  guardarUsuarios(usuarios);
  return res.json({ ok: true });
});

// ============================================================
//      DOCUMENTOS DE VENTA (Orden Facturación)
// ============================================================
// Cada venta puede tener 4 documentos: orden de facturación, preaprobado,
// cédula y comprobante de pago. Se almacenan en /uploads/<idVenta>/
// y el índice queda en docs-ventas.json.
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DOCS_INDEX = path.join(DATA_DIR, "docs-ventas.json");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Documentos por venta. Los primeros 6 los sube el ASESOR, los últimos 3 los sube CONTABILIDAD.
const TIPOS_DOC = [
  "ordenFac", "preaprobado", "cedulaFrente", "cedulaReverso", "comprobante", "empadronamiento",
  "facturaVenta", "facturaGps", "soat",
];
const TIPOS_DOC_NOMBRE = {
  ordenFac: "Orden de facturación",
  preaprobado: "Preaprobado del crédito",
  cedulaFrente: "Cédula (frente)",
  cedulaReverso: "Cédula (reverso)",
  comprobante: "Comprobante de pago",
  empadronamiento: "Empadronamiento",
  facturaVenta: "Factura de venta",
  facturaGps: "Factura GPS",
  soat: "SOAT",
};
// Para saber a qué grupo pertenece cada tipo (sólo presentación)
const TIPOS_DOC_GRUPO = {
  ordenFac: "asesor", preaprobado: "asesor", cedulaFrente: "asesor",
  cedulaReverso: "asesor", comprobante: "asesor", empadronamiento: "asesor",
  facturaVenta: "contable", facturaGps: "contable", soat: "contable",
};

// Migración automática: cédula antigua (un solo archivo) → cédulaFrente
function migrarCedula() {
  try {
    const docs = leerDocsVentas();
    let cambios = 0;
    for (const id of Object.keys(docs)) {
      const a = docs[id].archivos;
      if (a && a.cedula && !a.cedulaFrente) {
        a.cedulaFrente = a.cedula;
        delete a.cedula;
        cambios++;
      }
    }
    if (cambios > 0) {
      guardarDocsVentas(docs);
      console.log(`  Migración: ${cambios} cédulas reasignadas a cedulaFrente`);
    }
  } catch {}
}
migrarCedula();

function leerDocsVentas() {
  try { return JSON.parse(fs.readFileSync(DOCS_INDEX, "utf8")); } catch { return {}; }
}
function guardarDocsVentas(data) {
  fs.writeFileSync(DOCS_INDEX, JSON.stringify(data, null, 2), "utf8");
}
function idVentaSafe(s) {
  // Sanitiza para usar como nombre de carpeta
  return String(s || "").replace(/[^a-zA-Z0-9_\-.]/g, "_").slice(0, 64);
}

// Multer: guarda en uploads/{idVenta}/{tipo}-{timestamp}.{ext}
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const idVenta = idVentaSafe(req.body.idVenta || req.params.idVenta);
    if (!idVenta) return cb(new Error("idVenta requerido"));
    const dir = path.join(UPLOADS_DIR, idVenta);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const tipo = (req.body.tipo || "doc").replace(/[^a-zA-Z0-9]/g, "");
    const ext = path.extname(file.originalname).toLowerCase() || ".bin";
    cb(null, `${tipo}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpe?g|png|webp|heic)|application\/pdf)$/.test(file.mimetype);
    cb(ok ? null : new Error("Solo se aceptan imágenes (JPG, PNG, WebP) o PDF"), ok);
  },
});

// Subir 1 documento de una venta
app.post("/api/docs/upload", requireAuth, upload.single("archivo"), (req, res) => {
  try {
    const { idVenta: rawId, tipo, cliente, modelo } = req.body;
    const idVenta = idVentaSafe(rawId);
    if (!idVenta) return res.status(400).json({ ok: false, error: "Falta idVenta" });
    if (!TIPOS_DOC.includes(tipo)) return res.status(400).json({ ok: false, error: "Tipo de doc inválido" });
    if (!req.file) return res.status(400).json({ ok: false, error: "No se recibió archivo" });

    const docs = leerDocsVentas();
    if (!docs[idVenta]) docs[idVenta] = { cliente: cliente || "", modelo: modelo || "", archivos: {} };
    // Si ya había uno del mismo tipo, lo borramos del disco antes de reemplazar
    const previo = docs[idVenta].archivos[tipo];
    if (previo?.path) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, idVenta, previo.path)); } catch {}
    }
    docs[idVenta].archivos[tipo] = {
      path: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      subidoPor: req.session.userEmail,
      subidoEn: new Date().toISOString(),
    };
    if (cliente && !docs[idVenta].cliente) docs[idVenta].cliente = cliente;
    if (modelo && !docs[idVenta].modelo) docs[idVenta].modelo = modelo;
    guardarDocsVentas(docs);

    res.json({
      ok: true,
      idVenta,
      tipo,
      url: `/uploads/${idVenta}/${req.file.filename}`,
      completo: TIPOS_DOC.every(t => docs[idVenta].archivos[t]),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Listar documentos: si query.todos=1 (solo admin) trae todos; sino, solo del usuario logueado
app.get("/api/docs/lista", requireAuth, (req, res) => {
  const docs = leerDocsVentas();
  const usuario = buscarUsuario(req.session.userEmail);
  // El rol "contable" SIEMPRE ve todos los docs (no es opcional para ellos)
  // contable y dueno SIEMPRE ven todos (solo lectura para dueno)
  const verTodos = (req.query.todos === "1" && usuario?.rol === "admin")
    || usuario?.rol === "contable" || usuario?.rol === "dueno";
  const out = {};
  for (const [id, info] of Object.entries(docs)) {
    if (!verTodos) {
      // Filtrar: el usuario logueado debe haber subido algún archivo
      const fueElUsuario = Object.values(info.archivos || {}).some(a => a.subidoPor === usuario.email);
      if (!fueElUsuario) continue;
    }
    out[id] = info;
  }
  res.json({ ok: true, docs: out, tipos: TIPOS_DOC, tiposNombre: TIPOS_DOC_NOMBRE, tiposGrupo: TIPOS_DOC_GRUPO });
});

// Marcar un documento como "No aplica" (ej: Factura GPS para motos sin GPS)
app.post("/api/docs/no-aplica/:idVenta/:tipo", requireAuth, (req, res) => {
  const idVenta = idVentaSafe(req.params.idVenta);
  const { tipo } = req.params;
  if (!TIPOS_DOC.includes(tipo)) return res.status(400).json({ ok: false, error: "Tipo inválido" });
  const docs = leerDocsVentas();
  const usuario = buscarUsuario(req.session.userEmail);
  if (!docs[idVenta]) {
    docs[idVenta] = { archivos: {}, cliente: "", modelo: "", creadoEn: new Date().toISOString() };
  }
  // Si había archivo subido, borrarlo del disco
  const existente = docs[idVenta].archivos[tipo];
  if (existente?.path) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, idVenta, existente.path)); } catch {}
  }
  docs[idVenta].archivos[tipo] = {
    noAplica: true,
    marcadoPor: usuario.email,
    marcadoEn: new Date().toISOString(),
  };
  guardarDocsVentas(docs);
  res.json({ ok: true });
});

// Quitar la marca de "No aplica" (volver a estado vacío)
app.delete("/api/docs/no-aplica/:idVenta/:tipo", requireAuth, (req, res) => {
  const idVenta = idVentaSafe(req.params.idVenta);
  const { tipo } = req.params;
  const docs = leerDocsVentas();
  if (!docs[idVenta]?.archivos[tipo]?.noAplica) {
    return res.status(404).json({ ok: false, error: "No estaba marcado como no aplica" });
  }
  delete docs[idVenta].archivos[tipo];
  if (Object.keys(docs[idVenta].archivos).length === 0) delete docs[idVenta];
  guardarDocsVentas(docs);
  res.json({ ok: true });
});

// Borrar un documento específico
app.delete("/api/docs/:idVenta/:tipo", requireAuth, (req, res) => {
  const idVenta = idVentaSafe(req.params.idVenta);
  const { tipo } = req.params;
  if (!TIPOS_DOC.includes(tipo)) return res.status(400).json({ ok: false, error: "Tipo inválido" });
  const docs = leerDocsVentas();
  const info = docs[idVenta];
  if (!info?.archivos[tipo]) return res.status(404).json({ ok: false, error: "No existe" });

  // Cualquier usuario autenticado puede borrar (modo pruebas)
  // Si tiene archivo físico, borrarlo (los "no aplica" no tienen path)
  if (info.archivos[tipo].path) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, idVenta, info.archivos[tipo].path)); } catch {}
  }
  delete info.archivos[tipo];
  if (Object.keys(info.archivos).length === 0) delete docs[idVenta];
  guardarDocsVentas(docs);
  res.json({ ok: true });
});

// Servir archivos subidos (requiere auth)
app.get("/uploads/:idVenta/:archivo", requireAuth, (req, res) => {
  const file = path.join(UPLOADS_DIR, idVentaSafe(req.params.idVenta), req.params.archivo);
  if (!fs.existsSync(file)) return res.status(404).send("No encontrado");
  res.sendFile(file);
});

// ============================================================
//      PREASIGNACIONES (chasis específico → cliente + crédito)
// ============================================================
const PREASIG_PATH = path.join(DATA_DIR, "preasignaciones.json");

function leerPreasig() {
  try { return JSON.parse(fs.readFileSync(PREASIG_PATH, "utf8")); } catch { return {}; }
}
function guardarPreasig(data) {
  fs.writeFileSync(PREASIG_PATH, JSON.stringify(data, null, 2), "utf8");
}

app.get("/api/preasignaciones/lista", requireAuth, (req, res) => {
  const usuario = buscarUsuario(req.session.userEmail);
  // Contable, dueno, taller, gps_instalar, gps_activar y admin ven todas; asesor solo lo suyo
  const verTodos = ["contable", "dueno", "taller", "gps_instalar", "gps_activar"].includes(usuario?.rol)
    || (req.query.todos === "1" && usuario?.rol === "admin");
  const todas = leerPreasig();
  const out = {};
  for (const [id, p] of Object.entries(todas)) {
    if (verTodos || p.asesorEmail === usuario.email) out[id] = p;
  }
  res.json({ ok: true, preasignaciones: out });
});

app.post("/api/preasignaciones/crear", requireAuth, (req, res) => {
  const usuario = buscarUsuario(req.session.userEmail);
  const b = req.body || {};
  if (!b.chasis) return res.status(400).json({ ok: false, error: "Chasis es obligatorio" });
  if (!b.nombreCliente) return res.status(400).json({ ok: false, error: "Nombre del cliente es obligatorio" });

  const todas = leerPreasig();
  const id = String(b.chasis).trim().toUpperCase();
  todas[id] = {
    chasis: id,
    motor: String(b.motor || "").trim(),
    marca: String(b.marca || "").trim().toUpperCase(),
    modelo: String(b.modelo || "").trim().toUpperCase(),
    color: String(b.color || "").trim(),
    nombreCliente: String(b.nombreCliente || "").trim().toUpperCase(),
    cedulaCliente: String(b.cedulaCliente || "").trim(),
    fechaNacimiento: String(b.fechaNacimiento || "").trim(),
    celular: String(b.celular || "").trim(),
    numCredito: String(b.numCredito || "").trim(),
    financiera: String(b.financiera || "").trim().toUpperCase(),
    gps: String(b.gps || "sin").trim(),  // "instalar" | "activar" | "sin"
    placa: String(b.placa || "").trim().toUpperCase(),
    estado: "preasignada",  // preasignada | en_taller | entregada
    asesorEmail: usuario.email,
    asesorNombre: usuario.nombre,
    creadoEn: todas[id]?.creadoEn || new Date().toISOString(),
    actualizadoEn: new Date().toISOString(),
  };
  guardarPreasig(todas);
  res.json({ ok: true, preasignacion: todas[id] });
});

// --- Subir foto del acta de entrega firmada ---
const ACTAS_DIR = path.join(DATA_DIR, "actas-entrega");
if (!fs.existsSync(ACTAS_DIR)) fs.mkdirSync(ACTAS_DIR, { recursive: true });
const uploadActa = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(ACTAS_DIR, idVentaSafe(req.params.chasis));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.post("/api/preasignaciones/:chasis/acta-foto", requireAuth, uploadActa.single("archivo"), (req, res) => {
  const chasis = idVentaSafe(req.params.chasis);
  if (!req.file) return res.status(400).json({ ok: false, error: "Falta archivo de acta" });
  const todas = leerPreasig();
  if (!todas[chasis]) return res.status(404).json({ ok: false, error: "Preasignación no existe" });
  const usuario = buscarUsuario(req.session.userEmail);

  todas[chasis].actaEntrega = "lista"; // si suben foto, marcar automáticamente como lista
  todas[chasis].actaEntregaEn = new Date().toISOString();
  todas[chasis].actaEntregaPor = usuario.email;
  todas[chasis].actaEntregaArchivo = req.file.filename;
  guardarPreasig(todas);
  res.json({ ok: true, archivo: req.file.filename });
});

// Servir las fotos del acta (requiere auth)
app.get("/actas-entrega/:chasis/:archivo", requireAuth, (req, res) => {
  const file = path.join(ACTAS_DIR, idVentaSafe(req.params.chasis), req.params.archivo);
  if (!fs.existsSync(file)) return res.status(404).send("No encontrado");
  res.sendFile(file);
});

app.patch("/api/preasignaciones/:chasis", requireAuth, (req, res) => {
  const chasis = String(req.params.chasis).toUpperCase();
  const todas = leerPreasig();
  if (!todas[chasis]) return res.status(404).json({ ok: false, error: "No existe" });
  const usuario = buscarUsuario(req.session.userEmail);
  // Roles especiales (taller, gps_instalar, gps_activar) tienen permisos limitados
  const esTaller = usuario.rol === "taller";
  const esGpsInstalar = usuario.rol === "gps_instalar";
  const esGpsActivar = usuario.rol === "gps_activar";
  const esRolEspecial = esTaller || esGpsInstalar || esGpsActivar;
  const esDueno = todas[chasis].asesorEmail === usuario.email;
  if (!esDueno && usuario.rol !== "admin" && !esRolEspecial) {
    return res.status(403).json({ ok: false, error: "Sin permiso" });
  }
  // Taller puede: cambiar estado a lista_para_entregar, marcar acta de entrega, subir foto del acta
  if (esTaller && !esDueno && usuario.rol !== "admin") {
    const camposTaller = ["estado", "actaEntrega", "actaEntregaArchivo"];
    let cambioAlgo = false;
    for (const c of camposTaller) {
      if (req.body[c] !== undefined) {
        // Validación específica: taller puede marcar lista_para_entregar (alistamiento finalizado)
        // o devolver a en_taller (corrección por error al marcar lista por equivocación).
        if (c === "estado" && !["lista_para_entregar", "en_taller"].includes(req.body.estado)) {
          return res.status(403).json({ ok: false, error: "Taller solo puede marcar el estado como 'lista_para_entregar' o devolverla a 'en_taller'" });
        }
        todas[chasis][c] = String(req.body[c]).trim();
        cambioAlgo = true;
      }
    }
    if (!cambioAlgo) {
      return res.status(403).json({ ok: false, error: "Taller solo puede modificar: estado, acta de entrega" });
    }
    // Registrar timestamps si aplica
    if (req.body.estado === "lista_para_entregar") {
      todas[chasis].listaEn = new Date().toISOString();
      todas[chasis].listaPor = usuario.email;
    }
    if (req.body.actaEntrega) {
      todas[chasis].actaEntregaEn = new Date().toISOString();
      todas[chasis].actaEntregaPor = usuario.email;
    }
  } else if (esGpsInstalar && !esDueno && usuario.rol !== "admin") {
    // GPS instalador solo puede marcar gpsInstaladoEn o gpsInstalarEvidenciaPath
    const camposPermitidosGps = ["gpsInstaladoEn", "gpsInstalarEvidenciaPath"];
    let cambioAlgo = false;
    for (const c of camposPermitidosGps) {
      if (req.body[c] !== undefined) {
        todas[chasis][c] = req.body[c];
        cambioAlgo = true;
      }
    }
    if (!cambioAlgo) return res.status(403).json({ ok: false, error: "GPS Instalar: solo puede marcar instalado o subir evidencia" });
    if (req.body.gpsInstaladoEn) todas[chasis].gpsInstaladoPor = usuario.email;
  } else if (esGpsActivar && !esDueno && usuario.rol !== "admin") {
    const camposPermitidosGps = ["gpsActivadoEn", "gpsActivarEvidenciaPath"];
    let cambioAlgo = false;
    for (const c of camposPermitidosGps) {
      if (req.body[c] !== undefined) {
        todas[chasis][c] = req.body[c];
        cambioAlgo = true;
      }
    }
    if (!cambioAlgo) return res.status(403).json({ ok: false, error: "GPS Activar: solo puede marcar activado o subir evidencia" });
    if (req.body.gpsActivadoEn) todas[chasis].gpsActivadoPor = usuario.email;
  } else {
    // Solo permite actualizar ciertos campos
    const camposPermitidos = ["estado", "gps", "placa", "numCredito", "financiera", "celular", "fechaNacimiento", "imeiGps", "iccidGps", "gpsInstalarEvidenciaPath", "gpsActivarEvidenciaPath", "actaEntrega", "actaEntregaArchivo", "marca", "modelo", "motor", "color", "anio"];
    for (const c of camposPermitidos) {
      if (req.body[c] !== undefined) todas[chasis][c] = String(req.body[c]).trim();
    }
    // Si se cambia el acta, registrar timestamp
    if (req.body.actaEntrega) {
      todas[chasis].actaEntregaEn = new Date().toISOString();
      todas[chasis].actaEntregaPor = usuario.email;
    }
    // Si pasa a en_taller, registrar timestamp de entrada
    if (req.body.estado === "en_taller" && !todas[chasis].entradaTaller) {
      todas[chasis].entradaTaller = new Date().toISOString();
    }
    // Si pasa a lista_para_entregar, registrar timestamp
    if (req.body.estado === "lista_para_entregar") {
      todas[chasis].listaEn = new Date().toISOString();
      todas[chasis].listaPor = usuario.email;
    }
  }
  todas[chasis].actualizadoEn = new Date().toISOString();
  guardarPreasig(todas);
  res.json({ ok: true, preasignacion: todas[chasis] });
});

app.delete("/api/preasignaciones/:chasis", requireAuth, (req, res) => {
  const chasis = String(req.params.chasis).toUpperCase();
  const todas = leerPreasig();
  if (!todas[chasis]) return res.status(404).json({ ok: false, error: "No existe" });
  // Cualquier usuario autenticado puede borrar (modo pruebas)
  delete todas[chasis];
  guardarPreasig(todas);
  res.json({ ok: true });
});

// ============================================================
//      PRECIOS — actualización via PDF (solo admin)
// ============================================================
const PDFS_PRECIOS_DIR = path.join(DATA_DIR, "uploads-precios");
if (!fs.existsSync(PDFS_PRECIOS_DIR)) fs.mkdirSync(PDFS_PRECIOS_DIR, { recursive: true });

const uploadPrecios = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, PDFS_PRECIOS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".pdf";
      cb(null, `precios-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },  // 20 MB
  fileFilter: (_req, file, cb) => cb(file.mimetype === "application/pdf" ? null : new Error("Solo PDF"), file.mimetype === "application/pdf"),
});

app.post("/api/precios/upload", requireAuth, requireAdmin, uploadPrecios.single("archivo"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "Falta archivo PDF" });
  const meta = {
    archivo: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    subidoPor: req.session.userEmail,
    subidoEn: new Date().toISOString(),
    notas: String(req.body.notas || "").trim(),
  };
  // Guardar en historial
  const histPath = path.join(DATA_DIR, "precios-historial.json");
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(histPath, "utf8")); } catch {}
  hist.unshift(meta);  // más reciente primero
  fs.writeFileSync(histPath, JSON.stringify(hist, null, 2), "utf8");
  res.json({ ok: true, ...meta, url: `/precios/${req.file.filename}` });
});

app.get("/api/precios/historial", requireAuth, (req, res) => {
  const histPath = path.join(DATA_DIR, "precios-historial.json");
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(histPath, "utf8")); } catch {}
  res.json({ ok: true, historial: hist });
});

app.get("/precios/:archivo", requireAuth, (req, res) => {
  const file = path.join(PDFS_PRECIOS_DIR, req.params.archivo);
  if (!fs.existsSync(file)) return res.status(404).send("No encontrado");
  res.sendFile(file);
});

// ============================================================
//      FACTURA AUTECO — OCR con Claude Vision
// ============================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const FACTURAS_DIR = path.join(DATA_DIR, "facturas-auteco");
if (!fs.existsSync(FACTURAS_DIR)) fs.mkdirSync(FACTURAS_DIR, { recursive: true });

const uploadFactura = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, FACTURAS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
      cb(null, `factura-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },  // 15 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpe?g|png|webp|heic)|application\/pdf)$/.test(file.mimetype);
    cb(ok ? null : new Error("Solo imágenes (JPG/PNG/WebP/HEIC) o PDF"), ok);
  },
});

// POST /api/factura/procesar — recibe imagen, llama a Claude Vision
app.post("/api/factura/procesar", requireAuth, uploadFactura.single("archivo"), async (req, res) => {
  if (!anthropic) return res.status(500).json({ ok: false, error: "ANTHROPIC_API_KEY no configurada en el servidor. Pídele al admin que la añada en Render → Environment." });
  if (!req.file) return res.status(400).json({ ok: false, error: "Falta archivo de factura" });

  const filepath = path.join(FACTURAS_DIR, req.file.filename);
  try {
    const buf = fs.readFileSync(filepath);
    const base64 = buf.toString("base64");
    const mediaType = req.file.mimetype === "application/pdf" ? "application/pdf" : req.file.mimetype;

    // Si es PDF, Claude Vision necesita "type: document"; si es imagen, "type: image"
    const contentItem = mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

    const prompt = `Esta es una factura electrónica de venta de AUTOTECNICA COLOMBIANA S.A.S. (Auteco — importador de motocicletas en Colombia: TVS, Victory, Kymco, Benelli, Kawasaki, Ceronte).

Extrae dos bloques: (A) datos generales de la factura, y (B) cada moto que aparece.

================================================================
(A) DATOS GENERALES DE LA FACTURA
================================================================
- numeroFactura: el número de factura electrónica (suele aparecer como "FACTURA ELECTRONICA DE VENTA No. F660XXXXXX")
- fechaFactura: formato YYYY-MM-DD (ej: "2026-06-03"). La factura la trae como "FECHA DOCUMENTO" en formato DD.MM.YYYY HH:MM:SS — convierte a ISO.
- proveedorNit: el NIT del proveedor (Auteco). En esta factura aparece como "NIT 890.900.317-0" arriba a la derecha. Devuelve solo dígitos sin puntos ni guion: "890900317"
- proveedorNombre: razón social del proveedor: "AUTOTECNICA COLOMBIANA S.A.S."
- subtotal: el SUBTOTAL en COP (número, sin signos $ ni comas)
- iva: el IVA 19% en COP (número)
- total: el TOTAL en COP (número)
- condicionPago: texto corto, ej "Crédito 30 días"

================================================================
(B) MOTOS (cada fila de la tabla de productos)
================================================================
Por cada moto extrae:
- referencia (el código numérico de la columna "Referencia / Reference", ej: "60006597")
- chasis (VIN, 17 caracteres)
- motor (número del motor, alfanumérico)
- marca: INFIERE según el modelo (la factura NO dice la marca explícita, debes deducirla):
    * AGILITY, NEW AGILITY, X-TOWN, PEOPLE → KYMCO
    * MRX, MRX150, MRX ARIZONA, MX FACTORY → VICTORY
    * APACHE, RAIDER, NTORQ, RTR, RADEON, JUPITER, STAR → TVS
    * TNT, IMPERIALE, LEONCINO, TRK, 502, 752 → BENELLI
    * NINJA, Z400, Z650, VERSYS, KLR → KAWASAKI
    * CERONTE → CERONTE
    * Si no sabes con certeza, usa el primer nombre del modelo en mayúsculas
- modelo (todo el nombre después de "MOTOCICLETA", ej: "AGILITY FUSION TK", "MRX ARIZONA ABS GP TK", "MRX150 TK")
- color (extrae el color principal: "NEGRO", "ROJO", "AZUL", "GRIS", "BLANCO". Si dice "NEGRO NEBULOSA" → "NEGRO". Si dice "GRIS GRAFITO NEGRO NEBULOSA" → "GRIS")
- anio (año modelo, ej: 2027)
- cilindraje (texto que aparece entre paréntesis después del modelo, ej "124,6CC", "199.5CC", "149,2CC")
- precio (Precio unitario en COP, número sin signos)

================================================================
REGLAS CRÍTICAS PARA chasis y motor — LEE CON MUCHO CUIDADO
================================================================
La columna se llama "Chasis / Motor (Chassis / Engine)". Cada celda contiene DOS valores separados por "/":
  Formato: CHASIS/MOTOR
  Ejemplo real de esta factura fila 1: "9FLKNGNE0VHE10752/KN25S2104666"
    → chasis = "9FLKNGNE0VHE10752"
    → motor = "KN25S2104666"

Pistas FUERTES para validar tu lectura:
1. En facturas de AUTOTECNICA / Auteco, el chasis SIEMPRE empieza con "9FL". Si lees algo distinto (MFL, OFL, 9EL, etc.) probablemente confundiste un carácter — re-mira con cuidado.
2. El chasis es VIN estándar de exactamente 17 caracteres alfanuméricos.
3. El motor viene DESPUÉS de la "/" y suele empezar con letras tipo "KN", "ZS", "TS".
4. NO contiene espacios.

⚠️ CHASIS Y MOTOR — equilibrio entre leer e inventar:
La columna chasis/motor tiene letra pequeña. Hazlo así:
1. Lee la celda con MUCHO cuidado, carácter por carácter. Acércate visualmente.
2. Si el chasis empieza con "9FL" (correcto para Auteco) → confías y lo extraes completo.
3. Si lees algo distinto a "9FL" al inicio (ej "MFL", "OFL", "BFL") → vuelve a mirar, casi seguro estás confundiendo un carácter. Corrige a "9FL" si las demás letras coinciden.
4. SOLO si la celda está físicamente borrosa, tapada o ilegible → devuelve chasis="" y motor="".
5. NO devuelvas vacío por exceso de prudencia: si puedes leer el texto y aplicar las pistas, extráelo.
Inventar un chasis (devolver letras que no están) crea productos basura en Siigo. Pero devolver vacío cuando SÍ se puede leer hace que la humana lo escriba a mano. Busca el punto medio: lee con cuidado, valida con las pistas, extrae lo legible.

================================================================
FORMATO DE RESPUESTA (JSON exacto, SIN texto extra)
================================================================
{
  "factura": {
    "numeroFactura": "...",
    "fechaFactura": "YYYY-MM-DD",
    "proveedorNit": "...",
    "proveedorNombre": "...",
    "subtotal": 0,
    "iva": 0,
    "total": 0,
    "condicionPago": "..."
  },
  "motos": [
    { "referencia": "...", "chasis": "...", "motor": "...", "marca": "...", "modelo": "...", "color": "...", "anio": "...", "cilindraje": "...", "precio": 0 }
  ]
}

Si no puedes leer algún campo, usa "" o 0. Si la imagen no es una factura legible, devuelve {"factura":{}, "motos": []}.`;

    const result = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [contentItem, { type: "text", text: prompt }],
      }],
    });

    // Extraer JSON de la respuesta
    let texto = result.content[0]?.text || "";
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Claude no devolvió JSON válido. Respuesta: " + texto.slice(0, 200));
    const data = JSON.parse(jsonMatch[0]);

    res.json({
      ok: true,
      factura: data.factura || {},
      motos: data.motos || [],
      archivo: req.file.filename,
      usoTokens: { input: result.usage?.input_tokens, output: result.usage?.output_tokens },
    });
  } catch (e) {
    console.error("Error factura:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//      CIRCULAR DE PRECIOS — extraer precios desde PDF (Claude Vision)
// ============================================================
const CIRCULARES_DIR = path.join(DATA_DIR, "circulares-precios");
if (!fs.existsSync(CIRCULARES_DIR)) fs.mkdirSync(CIRCULARES_DIR, { recursive: true });
const uploadCircular = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, CIRCULARES_DIR),
    filename: (_req, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.post("/api/circular-precios/procesar", requireAuth, requireAdmin, uploadCircular.single("archivo"), async (req, res) => {
  if (!anthropic) return res.status(500).json({ ok: false, error: "ANTHROPIC_API_KEY no configurada" });
  if (!req.file) return res.status(400).json({ ok: false, error: "Falta archivo PDF de circular" });

  const filepath = path.join(CIRCULARES_DIR, req.file.filename);
  try {
    const buf = fs.readFileSync(filepath);
    const base64 = buf.toString("base64");
    const mediaType = req.file.mimetype === "application/pdf" ? "application/pdf" : req.file.mimetype;
    const contentItem = mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

    const prompt = `Esta es una circular de precios de Auteco (importador de motocicletas en Colombia: marcas TVS, Victory, Kymco, Benelli, Kawasaki, Ceronte).

Extrae TODOS los modelos con sus precios sugeridos de venta al público. Cada moto puede tener precio en uno o varios años modelo (2025, 2026, 2027).

Devuelve SOLO un JSON válido con este formato exacto, sin texto extra:

{
  "marca": "TVS" o "VICTORY" o "KYMCO" o "BENELLI" o "CERONTE" (la que corresponda a la circular),
  "fecha": "Junio 2026" (mes y año de la circular si aparece),
  "modelos": [
    {
      "modelo": "APACHE 160 CARB ABS",
      "precio_2025": 0,
      "precio_2026": 9499999,
      "precio_2027": 9649999,
      "iva": 19,
      "impuesto_consumo": 0
    },
    ...
  ]
}

Reglas:
- Precios SIN comas ni puntos: 9499999, no "$9.499.999"
- Si una celda está vacía o tiene guión, usa 0
- Si la circular tiene varias marcas, devuelve todas en "modelos" — la "marca" del nivel raíz indica la principal
- iva es 19 o 5 o 0 (según la circular)
- impuesto_consumo es 0 u 8 (si aparece)
- modelo en MAYÚSCULAS exactamente como aparece

Si el PDF no es una circular de precios, devuelve {"modelos": []}.`;

    const result = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: [contentItem, { type: "text", text: prompt }],
      }],
    });

    let texto = result.content[0]?.text || "";
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Claude no devolvió JSON válido: " + texto.slice(0, 200));
    const data = JSON.parse(jsonMatch[0]);

    res.json({
      ok: true,
      marca: data.marca || "",
      fecha: data.fecha || "",
      modelos: data.modelos || [],
      archivo: req.file.filename,
      usoTokens: { input: result.usage?.input_tokens, output: result.usage?.output_tokens },
    });
  } catch (e) {
    console.error("Error circular precios:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//      GPS — leer IMEI desde foto del sticker (Claude Vision)
// ============================================================
const GPS_DIR = path.join(DATA_DIR, "gps-imei");
if (!fs.existsSync(GPS_DIR)) fs.mkdirSync(GPS_DIR, { recursive: true });
const uploadGps = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, GPS_DIR),
    filename: (_req, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.post("/api/gps/leer-imei", requireAuth, uploadGps.single("archivo"), async (req, res) => {
  if (!anthropic) return res.status(500).json({ ok: false, error: "ANTHROPIC_API_KEY no configurada" });
  if (!req.file) return res.status(400).json({ ok: false, error: "Falta foto del sticker" });

  const filepath = path.join(GPS_DIR, req.file.filename);
  try {
    const buf = fs.readFileSync(filepath);
    const base64 = buf.toString("base64");
    const mediaType = req.file.mimetype === "application/pdf" ? "application/pdf" : req.file.mimetype;

    const contentItem = mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

    const prompt = `Esta es una foto de un sticker pegado a un dispositivo GPS (rastreador vehicular).
Suele tener códigos de barras y los siguientes números:
- IMEI: 15 dígitos que identifican el dispositivo (empieza con 86 o 35)
- ICCID: 19 o 20 dígitos que identifican la SIM (empieza con 89)
- Serial: número de serie del dispositivo (alfanumérico)

Extrae TODOS los números que aparezcan:
- imei: el número IMEI (15 dígitos)
- iccid: el número ICCID de la SIM (19-20 dígitos, empieza con 89)
- serial: número de serie si aparece (alfanumérico)
- modelo: marca/modelo del GPS si aparece (ej: TS101, GT06, Trakku, etc.)

Devuelve SOLO un JSON válido con este formato exacto, sin texto extra:
{
  "imei": "...",
  "iccid": "...",
  "serial": "...",
  "modelo": "..."
}

Si no puedes leer algún campo, usa "". Si la imagen no es un sticker de GPS, devuelve {"imei":"","iccid":"","serial":"","modelo":""}.`;

    const result = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: [contentItem, { type: "text", text: prompt }],
      }],
    });

    let texto = result.content[0]?.text || "";
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Claude no devolvió JSON válido: " + texto.slice(0, 200));
    const data = JSON.parse(jsonMatch[0]);

    res.json({
      ok: true,
      imei: data.imei || "",
      iccid: data.iccid || "",
      serial: data.serial || "",
      modelo: data.modelo || "",
      archivo: req.file.filename,
    });
  } catch (e) {
    console.error("Error GPS IMEI:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//      LEADS REGISTRADOS (lista de los clientes ingresados)
// ============================================================
app.get("/api/leads/lista", requireAuth, (req, res) => {
  const usuario = buscarUsuario(req.session.userEmail);
  if (!fs.existsSync(LOG_PATH)) return res.json({ ok: true, leads: [] });

  // Pre-cargar preasignaciones para cruzar por documento del cliente
  const preasigs = leerPreasig();
  const indiceXDoc = {};
  const indiceXNombre = {};
  for (const p of Object.values(preasigs)) {
    if (p.cedulaCliente) {
      const k = String(p.cedulaCliente).replace(/[^0-9]/g, "");
      if (k) indiceXDoc[k] = p;
    }
    if (p.nombreCliente) {
      const k = p.nombreCliente.toUpperCase().trim();
      if (k && !indiceXNombre[k]) indiceXNombre[k] = p;
    }
  }

  const lineas = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
  const leads = [];
  for (const linea of lineas) {
    try {
      const r = JSON.parse(linea);
      if (usuario.rol !== "admin" && usuario.rol !== "contable" && usuario.rol !== "dueno") {
        if (r.usuario !== usuario.email) continue;
      }
      const p = r.payload || {};
      // Cruzar con preasignación: primero por documento, fallback por nombre
      const docKey = String(p.Documento || "").replace(/[^0-9]/g, "");
      const nomKey = (p.NombreContacto || "").toUpperCase().trim();
      const pre = (docKey && indiceXDoc[docKey]) || (nomKey && indiceXNombre[nomKey]) || null;

      leads.push({
        ts: r.ts,
        enviadoAImpulsa: !!r.enviadoAImpulsa,
        statusImpulsa: r.status || null,
        idImpulsa: r.respuesta?.idRegistro || null,
        ambiente: r.ambiente || null,
        usuario: r.usuario || "",
        usuarioNombre: r.usuario ? buscarUsuario(r.usuario)?.nombre || r.usuario.split("@")[0] : "",
        // Datos del lead
        cliente: p.NombreContacto || "",
        documento: p.Documento || "",
        tipoDocumento: p.TipoDocumento || "",
        celular: p.Telefono2 || "",
        email: p.Email || "",
        direccion: p.Direccion || "",
        codigoDANE: p.CodigoDANE || "",
        marca: p.Productos?.[0]?.Marca || "",
        modelo: p.Productos?.[0]?.Producto || "",
        observaciones: p.Observaciones || "",
        origen: p.Origen || "",
        campanna: p.Campanna || "",
        idOportunidadAuteco: p.IDOportunidadAuteco || "",
        // Datos enriquecidos desde Preasignación (si existe)
        chasis: pre?.chasis || "",
        motor: pre?.motor || "",
        color: pre?.color || pre?.colorMoto || "",
        placa: pre?.placa || "",
        numCredito: pre?.numCredito || "",
        financiera: pre?.financiera || "",
        fechaNacimiento: pre?.fechaNacimiento || "",
        gps: pre?.gps || "",
        estadoPreasignacion: pre?.estado || "",
        tienePreasignacion: !!pre,
      });
    } catch {}
  }
  leads.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  res.json({ ok: true, leads });
});

// Borrar un lead del log (por timestamp ISO). Admin borra cualquiera; asesor solo los suyos.
app.delete("/api/leads/:ts", requireAuth, (req, res) => {
  const usuario = buscarUsuario(req.session.userEmail);
  const ts = String(req.params.ts);
  if (!fs.existsSync(LOG_PATH)) return res.json({ ok: true, borrados: 0 });

  const lineas = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
  const nuevas = [];
  let borrados = 0;
  for (const linea of lineas) {
    try {
      const r = JSON.parse(linea);
      if (r.ts === ts) {
        // Cualquier usuario autenticado puede borrar (modo pruebas)
        borrados++;
        continue;  // Saltar = borrar
      }
      nuevas.push(linea);
    } catch {
      nuevas.push(linea);
    }
  }
  fs.writeFileSync(LOG_PATH, nuevas.length ? nuevas.join("\n") + "\n" : "", "utf8");
  res.json({ ok: true, borrados });
});

// Borrar TODA la venta (con todos sus documentos). Admin o quien subió original.
app.delete("/api/docs/:idVenta", requireAuth, (req, res) => {
  const idVenta = idVentaSafe(req.params.idVenta);
  const docs = leerDocsVentas();
  const info = docs[idVenta];
  if (!info) return res.status(404).json({ ok: false, error: "No existe" });

  // Cualquier usuario autenticado puede borrar (modo pruebas)
  // Borrar archivos físicos
  for (const tipo of Object.keys(info.archivos || {})) {
    const archivo = info.archivos[tipo];
    try { fs.unlinkSync(path.join(UPLOADS_DIR, idVenta, archivo.path)); } catch {}
  }
  // Intentar borrar la carpeta de la venta
  try { fs.rmdirSync(path.join(UPLOADS_DIR, idVenta)); } catch {}

  delete docs[idVenta];
  guardarDocsVentas(docs);
  res.json({ ok: true });
});

// --- Comisiones pagadas (solo admin) ---
const COMISIONES_PATH = path.join(DATA_DIR, "comisiones-pagadas.json");
function leerComisionesPagadas() {
  try {
    const raw = fs.readFileSync(COMISIONES_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {}; // { "<chasis_o_id>": { pagada: true, fechaPago: "ISO", marcadoPor: "email" } }
  }
}
function guardarComisionesPagadas(data) {
  fs.writeFileSync(COMISIONES_PATH, JSON.stringify(data, null, 2), "utf8");
}

app.get("/api/comisiones/pagadas", requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true, comisiones: leerComisionesPagadas() });
});

app.post("/api/comisiones/marcar", requireAuth, requireAdmin, (req, res) => {
  const { id, pagada } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "Falta id de la venta" });
  const data = leerComisionesPagadas();
  if (pagada) {
    data[String(id)] = {
      pagada: true,
      fechaPago: new Date().toISOString(),
      marcadoPor: req.session.userEmail,
    };
  } else {
    delete data[String(id)];
  }
  guardarComisionesPagadas(data);
  res.json({ ok: true, id, pagada: !!pagada });
});

// --- Origen de la venta: "personal" (5%) vs "concesionario" (2%) ---
// Solo se guardan las "personal" — todas las demás se asumen concesionario por default.
const ORIGEN_VENTAS_PATH = path.join(DATA_DIR, "origen-ventas.json");
function leerOrigenVentas() {
  try { if (fs.existsSync(ORIGEN_VENTAS_PATH)) return JSON.parse(fs.readFileSync(ORIGEN_VENTAS_PATH, "utf8")); }
  catch (e) { console.warn("[origen-ventas]", e.message); }
  return {};
}
function guardarOrigenVentas(data) {
  fs.writeFileSync(ORIGEN_VENTAS_PATH, JSON.stringify(data, null, 2), "utf8");
}

app.get("/api/origen-ventas", requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true, origen: leerOrigenVentas() });
});

app.post("/api/origen-ventas/marcar", requireAuth, requireAdmin, (req, res) => {
  const { id, origen } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "Falta id de la venta" });
  if (origen && !["personal", "concesionario"].includes(origen)) {
    return res.status(400).json({ ok: false, error: "Origen inválido" });
  }
  const data = leerOrigenVentas();
  // Default es "personal" (5%) → solo se guardan las marcadas como "concesionario" (excepciones)
  if (origen === "concesionario") {
    data[String(id)] = {
      origen: "concesionario",
      marcadoEn: new Date().toISOString(),
      marcadoPor: req.session.userEmail,
    };
  } else {
    delete data[String(id)]; // personal es el default, no se guarda
  }
  guardarOrigenVentas(data);
  res.json({ ok: true, id, origen: origen || "personal" });
});

// --- Panel admin: sesiones activas ---
function parsearUserAgent(ua) {
  if (!ua) return { dispositivo: "—", navegador: "—", esMobile: false };
  const esMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  let so = "Desconocido";
  if (/Windows NT 10/.test(ua)) so = "Windows 10/11";
  else if (/Windows NT/.test(ua)) so = "Windows";
  else if (/iPhone|iPad/i.test(ua)) so = "iOS";
  else if (/Android/i.test(ua)) so = "Android";
  else if (/Mac OS X/.test(ua)) so = "macOS";
  else if (/Linux/.test(ua)) so = "Linux";
  let nav = "Otro";
  if (/Edg\//.test(ua)) nav = "Edge";
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) nav = "Opera";
  else if (/Firefox/.test(ua)) nav = "Firefox";
  else if (/Chrome/.test(ua)) nav = "Chrome";
  else if (/Safari/.test(ua)) nav = "Safari";
  return { dispositivo: so + (esMobile ? " (móvil)" : ""), navegador: nav, esMobile };
}

app.get("/api/admin/sesiones-activas", requireAuth, requireAdmin, async (req, res) => {
  const ahora = Date.now();
  const ventana = 15 * 60 * 1000; // últimos 15 min cuentan como "en línea"
  const sesiones = [];
  for (const [email, info] of sesionesActivas.entries()) {
    const minSinAct = (ahora - info.lastSeen) / 60000;
    if (minSinAct > 60) continue; // ocultar después de 1h sin actividad
    const u = buscarUsuario(email);
    sesiones.push({
      email,
      nombre: u?.nombre || email.split("@")[0].toUpperCase(),
      apellido: u?.apellido || "",
      rol: u?.rol || "?",
      ip: info.ip,
      ipPrev: info.ipPrev,
      minSinActividad: Math.floor(minSinAct),
      enLinea: (ahora - info.lastSeen) < ventana,
      lastSeen: info.lastSeen,
      loginAt: info.loginAt,
      sesionDuracionMin: Math.floor((ahora - info.loginAt) / 60000),
      ...parsearUserAgent(info.userAgent),
      userAgentRaw: info.userAgent,
    });
  }

  // Resolver ubicación de cada IP única (en paralelo)
  const ipsUnicas = [...new Set(sesiones.map(s => s.ip).filter(Boolean))];
  const ubicaciones = {};
  await Promise.all(ipsUnicas.map(async ip => {
    ubicaciones[ip] = await ubicacionDeIP(ip);
  }));
  for (const s of sesiones) {
    s.ubicacion = ubicaciones[s.ip] || null;
  }

  // Ordenar: en línea primero, después por última actividad
  sesiones.sort((a, b) => {
    if (a.enLinea !== b.enLinea) return b.enLinea - a.enLinea;
    return b.lastSeen - a.lastSeen;
  });

  res.json({ ok: true, sesiones, totalEnLinea: sesiones.filter(s => s.enLinea).length });
});

// --- Endpoints de gestión de usuarios (solo admin) ---
app.get("/api/usuarios", requireAuth, requireAdmin, (req, res) => {
  const usuarios = leerUsuarios().map(u => ({
    email: u.email,
    nombre: u.nombre,
    apellido: u.apellido,
    rol: u.rol,
    telefono: u.telefono || "",
    debeChangePass: !!u.debeChangePass,
    creadoEn: u.creadoEn,
    passwordCambiadaEn: u.passwordCambiadaEn || null,
  }));
  res.json({ ok: true, usuarios });
});

// Endpoint público (cualquier user autenticado) que devuelve directorio
// reducido — solo nombre, email, rol, teléfono — para mostrar contactos en Taller, etc.
app.get("/api/usuarios/directorio", requireAuth, (req, res) => {
  const usuarios = leerUsuarios().map(u => ({
    email: u.email,
    nombre: u.nombre,
    apellido: u.apellido,
    rol: u.rol,
    telefono: u.telefono || "",
  }));
  res.json({ ok: true, usuarios });
});

// Actualizar teléfono u otros datos editables de un usuario (solo admin)
app.patch("/api/usuarios/:email", requireAuth, requireAdmin, (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const usuarios = leerUsuarios();
  const idx = usuarios.findIndex(u => u.email.toLowerCase() === email);
  if (idx < 0) return res.status(404).json({ ok: false, error: "Usuario no existe" });
  const camposPermitidos = ["telefono", "nombre", "apellido"];
  for (const c of camposPermitidos) {
    if (req.body[c] !== undefined) usuarios[idx][c] = String(req.body[c]).trim();
  }
  guardarUsuarios(usuarios);
  res.json({ ok: true, usuario: { ...usuarios[idx], passwordHash: undefined } });
});

// Generar clave temporal aleatoria (palabra + 3 dígitos + signo)
function generarClaveTemp() {
  const palabras = ["Apache", "Raider", "Bomber", "Ntorq", "Sport", "Hunter", "Switch", "Bet", "Mrx", "Nitro"];
  const signos = ["!", "@", "#", "*"];
  const palabra = palabras[Math.floor(Math.random() * palabras.length)];
  const num = String(Math.floor(Math.random() * 900) + 100);
  const signo = signos[Math.floor(Math.random() * signos.length)];
  return palabra + num + signo;
}

// Resetear clave de un usuario (solo admin). Devuelve clave temporal en TEXTO PLANO
// para que admin la pase al usuario por canal seguro.
app.post("/api/usuarios/resetear-clave", requireAuth, requireAdmin, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: "Falta email del usuario" });
  const usuarios = leerUsuarios();
  const idx = usuarios.findIndex(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (idx < 0) return res.status(404).json({ ok: false, error: "Usuario no existe" });
  const claveTemp = generarClaveTemp();
  usuarios[idx].passwordHash = await bcrypt.hash(claveTemp, 10);
  usuarios[idx].debeChangePass = true;
  usuarios[idx].reseteadoEn = new Date().toISOString();
  usuarios[idx].reseteadoPor = req.session.userEmail;
  guardarUsuarios(usuarios);
  res.json({ ok: true, email, claveTemp });
});

// Crear usuario nuevo (solo admin)
app.post("/api/usuarios/crear", requireAuth, requireAdmin, async (req, res) => {
  const { email, nombre, apellido, rol } = req.body || {};
  if (!email || !nombre || !rol) {
    return res.status(400).json({ ok: false, error: "Faltan campos: email, nombre, rol" });
  }
  const rolesValidos = ["admin", "asesor", "contable", "dueno", "taller", "gps_instalar", "gps_activar"];
  if (!rolesValidos.includes(rol)) {
    return res.status(400).json({ ok: false, error: "Rol inválido. Usar: " + rolesValidos.join(", ") });
  }
  const usuarios = leerUsuarios();
  if (usuarios.some(u => u.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ ok: false, error: "Ya existe usuario con ese email" });
  }
  const claveTemp = generarClaveTemp();
  usuarios.push({
    email: String(email).toLowerCase().trim(),
    nombre: String(nombre).toUpperCase().trim(),
    apellido: String(apellido || "").trim(),
    rol,
    passwordHash: await bcrypt.hash(claveTemp, 10),
    debeChangePass: true,
    creadoEn: new Date().toISOString(),
    creadoPor: req.session.userEmail,
  });
  guardarUsuarios(usuarios);
  res.json({ ok: true, email, claveTemp });
});

// Borrar usuario (solo admin, no puede borrarse a sí mismo)
app.delete("/api/usuarios/:email", requireAuth, requireAdmin, (req, res) => {
  const email = String(req.params.email).toLowerCase();
  if (email === req.session.userEmail.toLowerCase()) {
    return res.status(400).json({ ok: false, error: "No puedes borrar tu propio usuario" });
  }
  const usuarios = leerUsuarios();
  const idx = usuarios.findIndex(u => u.email.toLowerCase() === email);
  if (idx < 0) return res.status(404).json({ ok: false, error: "Usuario no existe" });
  usuarios.splice(idx, 1);
  guardarUsuarios(usuarios);
  res.json({ ok: true });
});

// --- Log de ventas registradas ---
const LOG_PATH = path.join(DATA_DIR, "ventas-registradas.jsonl");
function append(record) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    console.error("No se pudo escribir log:", e.message);
  }
}

// --- Construcción de payload Impulsa ---
function parseMonto(s) {
  // Quita puntos/comas/$ y todo lo que no sea dígito antes de parsear
  if (s === null || s === undefined || s === "") return 0;
  const cleaned = String(s).replace(/[^0-9]/g, "");
  return cleaned ? parseInt(cleaned, 10) : 0;
}
function fmtCOP(n) {
  const v = parseMonto(n);
  if (!v) return null;
  return "$" + v.toLocaleString("es-CO");
}

function construirObservaciones(form, usuario) {
  const partes = [];
  const formaPago = String(form.FormaPago || "").trim();
  const financiera = String(form.Financiera || "").trim();
  const precioMoto = fmtCOP(form.PrecioMoto);
  const valorPapeles = fmtCOP(form.ValorPapeles);
  const total = parseMonto(form.PrecioMoto) + parseMonto(form.ValorPapeles);
  const totalFmt = fmtCOP(total);
  const libres = String(form.Observaciones || "").trim();

  if (formaPago) {
    partes.push(financiera
      ? `Pago: ${formaPago.toUpperCase()} (${financiera.toUpperCase()})`
      : `Pago: ${formaPago.toUpperCase()}`);
  }
  if (precioMoto) partes.push(`Precio moto: ${precioMoto}`);
  if (valorPapeles) partes.push(`Papeles: ${valorPapeles}`);
  if (totalFmt && total > 0) partes.push(`Total: ${totalFmt}`);
  if (usuario) partes.push(`Registró: ${usuario.nombre}`);

  let resumen = partes.join(" | ");
  if (libres) resumen += (resumen ? "\n" : "") + libres;
  return resumen;
}

function construirPayload(form, usuario) {
  const habeas = form.HabeasData === true || form.HabeasData === "on" || form.HabeasData === "true";
  // Defaults por usuario: si no manda Origen/Campanna explícitos, usar nombre del logueado
  const origen = (form.Origen || `Venta ${usuario.nombre}`).slice(0, 50);
  const campanna = (form.Campanna || `Venta ${usuario.nombre}`).slice(0, 50);
  // IDOportunidadAuteco: Impulsa exige STRING que contenga solo DÍGITOS y sea > 0.
  // Si el asesor escribió uno (ej. del sistema Auteco), lo limpiamos a dígitos.
  // Si no, usamos un timestamp único como ID interno (siempre > 0).
  const idAutecoRaw = String(form.IDOportunidadAuteco || "").replace(/[^0-9]/g, "");
  const idAuteco = idAutecoRaw && Number(idAutecoRaw) > 0 ? idAutecoRaw : String(Date.now());
  return {
    ID: 0,
    IDOportunidadAuteco: idAuteco,
    Origen: origen,
    Campanna: campanna,
    Establecimiento: String(ESTABLECIMIENTO),
    TipoDocumento: form.TipoDocumento || "CC",
    Documento: String(form.Documento || "").trim(),
    NombreContacto: String(form.NombreContacto || "").trim().toUpperCase(),
    Email: String(form.Email || "").trim(),
    Telefono2: String(form.Telefono2 || "").trim(),
    CodigoDANE: form.CodigoDANE || CODIGO_DANE,
    Direccion: String(form.Direccion || "").trim().toUpperCase(),
    Productos: [
      { Producto: String(form.Producto || "").trim(), Marca: String(form.Marca || "").trim() },
    ],
    Observaciones: construirObservaciones(form, usuario),
    HabeasData: !!habeas,
    Sistema: "",
    NivelInteres: form.NivelInteres || "AA",
    // Login en Impulsa: si users.json define usuarioImpulsa, lo usamos; sino, parte antes del @
    Usuario: usuario.usuarioImpulsa || usuario.email.split("@")[0],
  };
}

function validar(payload) {
  const faltan = [];
  if (!payload.NombreContacto) faltan.push("Nombre");
  if (!payload.Documento) faltan.push("Documento");
  if (!payload.Email) faltan.push("Correo");
  if (!payload.Productos[0].Producto) faltan.push("Modelo de moto");
  if (!payload.HabeasData) faltan.push("Autorización habeas data");
  return faltan;
}

app.post("/api/registrar-venta", requireAuth, async (req, res) => {
  const usuarioLogueado = buscarUsuario(req.session.userEmail);
  if (!usuarioLogueado) return res.status(401).json({ ok: false, error: "Sesión inválida" });

  const payload = construirPayload(req.body || {}, usuarioLogueado);
  const faltan = validar(payload);
  if (faltan.length) {
    return res.status(400).json({
      ok: false,
      error: `Faltan campos obligatorios: ${faltan.join(", ")}`,
      payload,
    });
  }
  if (!IMPULSA_API_KEY) {
    append({ ts: new Date().toISOString(), enviadoAImpulsa: false, motivo: "API_KEY ausente", usuario: usuarioLogueado.email, payload });
    return res.status(500).json({
      ok: false,
      error: "IMPULSA_API_KEY no configurada en .env",
      payload,
    });
  }
  try {
    const r = await fetch(`${IMPULSA_BASE_URL}/oportunidades/Crear`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${IMPULSA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await r.json(); } catch { data = { Exitoso: r.ok }; }
    append({
      ts: new Date().toISOString(),
      enviadoAImpulsa: r.ok,
      status: r.status,
      ambiente: IMPULSA_ENV,
      usuario: usuarioLogueado.email,
      payload,
      respuesta: data,
    });
    return res.status(r.ok ? 200 : r.status).json({
      ok: r.ok,
      status: r.status,
      ambiente: IMPULSA_ENV,
      impulsa: data,
      payload,
    });
  } catch (e) {
    append({ ts: new Date().toISOString(), enviadoAImpulsa: false, motivo: e.message, usuario: usuarioLogueado.email, payload });
    return res.status(500).json({
      ok: false,
      error: `Error de red: ${e.message}`,
      payload,
    });
  }
});

// --- Siigo: leer inventario de productos ---
// Cualquier usuario autenticado puede consultar el inventario combinado.
let siigoCache = { data: null, fetchedAt: 0 };
const SIIGO_CACHE_MS = 5 * 60 * 1000; // 5 min — evita martillar la API

app.get("/api/siigo/productos", requireAuth, async (req, res) => {
  if (!siigo.siigoConfigurado()) {
    return res.status(503).json({
      ok: false,
      error: "Siigo no configurado (faltan SIIGO_USERNAME / SIIGO_ACCESS_KEY)",
    });
  }
  try {
    const force = req.query.refresh === "1";
    const now = Date.now();
    if (!force && siigoCache.data && (now - siigoCache.fetchedAt) < SIIGO_CACHE_MS) {
      return res.json({ ok: true, fuente: "cache", productos: siigoCache.data });
    }
    const crudos = await siigo.obtenerProductos();
    const productos = crudos.map(siigo.normalizarProducto);
    siigoCache = { data: productos, fetchedAt: now };
    res.json({ ok: true, fuente: "siigo", total: productos.length, productos });
  } catch (e) {
    console.error("[siigo] error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Códigos Impulsa: catálogo manual que crece con cada venta ---
// Mapa: { "MODELO|COLOR|ANIO": "Código Impulsa" }
const CODIGOS_IMPULSA_PATH = path.join(DATA_DIR, "codigos-impulsa.json");
function leerCodigosImpulsa() {
  try {
    if (!fs.existsSync(CODIGOS_IMPULSA_PATH)) return {};
    return JSON.parse(fs.readFileSync(CODIGOS_IMPULSA_PATH, "utf8"));
  } catch { return {}; }
}
function guardarCodigosImpulsa(data) {
  try { fs.writeFileSync(CODIGOS_IMPULSA_PATH, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error("[codigos-impulsa] error guardando:", e.message); }
}
function clavesCodigo(modelo, color, anio) {
  const m = String(modelo || "").toUpperCase().trim();
  const c = String(color || "").toUpperCase().trim();
  const a = String(anio || "").trim();
  return `${m}|${c}|${a}`;
}

app.get("/api/codigos-impulsa", requireAuth, (req, res) => {
  res.json({ ok: true, codigos: leerCodigosImpulsa() });
});

app.post("/api/codigos-impulsa", requireAuth, (req, res) => {
  const { modelo, color, anio, codigo } = req.body || {};
  if (!modelo || !codigo) {
    return res.status(400).json({ ok: false, error: "Se requiere modelo y codigo" });
  }
  const codigos = leerCodigosImpulsa();
  const key = clavesCodigo(modelo, color, anio);
  codigos[key] = String(codigo).trim();
  guardarCodigosImpulsa(codigos);
  res.json({ ok: true, key, codigo: codigos[key] });
});

app.delete("/api/codigos-impulsa", requireAuth, (req, res) => {
  const { modelo, color, anio } = req.body || {};
  if (!modelo) return res.status(400).json({ ok: false, error: "Se requiere modelo" });
  const codigos = leerCodigosImpulsa();
  const key = clavesCodigo(modelo, color, anio);
  delete codigos[key];
  guardarCodigosImpulsa(codigos);
  res.json({ ok: true });
});

// --- Siigo: buscar un chasis específico para autocompletar formularios ---
app.get("/api/siigo/buscar/:chasis", requireAuth, async (req, res) => {
  if (!siigo.siigoConfigurado()) {
    return res.status(503).json({ ok: false, error: "Siigo no configurado" });
  }
  const query = String(req.params.chasis || "").trim().toUpperCase();
  if (query.length < 3) {
    return res.status(400).json({ ok: false, error: "Búsqueda muy corta (mínimo 3 caracteres)" });
  }
  try {
    // Usa el cache si está fresco (no hace falta refrescar para cada búsqueda)
    let productos = siigoCache.data;
    const now = Date.now();
    if (!productos || (now - siigoCache.fetchedAt) > SIIGO_CACHE_MS) {
      const crudos = await siigo.obtenerProductos();
      productos = crudos.map(siigo.normalizarProducto);
      siigoCache = { data: productos, fetchedAt: now };
    }

    // Helper para inferir marca — heurística por modelo conocido
    function inferirMarca(nombre) {
      const n = (nombre || "").toUpperCase();
      if (/RAIDER|APACHE|NTORQ|SPORT|STAR|HLX|RTX|RTR\b/.test(n)) return "TVS";
      if (/KING|VICTORY|NITRO|MOTO\s*CARRO|MRX|XKM|MOBILITY/.test(n)) return "MOBILITY";
      if (/\bAKT\b|EVO\s|DYNAMIC|FLEX/.test(n)) return "AKT";
      if (/\bBET\b|AGILITY|FUSION|NEO|VITALITY|JOCKEY|FLY|SUPER\s*8|KYMCO/.test(n)) return "KYMCO";
      if (/\bBOXER\b|PULSAR|DOMINAR|DISCOVER|AVENGER|BAJAJ/.test(n)) return "BAJAJ";
      if (/\bAUTECO\b|VICTORY/.test(n)) return "AUTECO";
      return "OTRO";
    }

    // Búsqueda parcial: el query puede ser parte del chasis o motor
    const matches = productos.filter(p =>
      (p.chasis || "").toUpperCase().includes(query) ||
      (p.motor || "").toUpperCase().includes(query) ||
      (p.codigo || "").toUpperCase().includes(query)
    );

    if (matches.length === 0) {
      return res.json({ ok: false, encontrado: false, mensaje: "Chasis no está en Siigo" });
    }

    // Mapear a formato estándar (hasta 20 resultados)
    // Prioriza modeloParsed (extraído de description, más confiable) sobre p.nombre
    // (el name puede estar mal escrito en Siigo — ej: name="BET TK" pero description="APACHE RTR 200")
    const lista = matches.slice(0, 20).map(p => {
      const modeloLimpio = p.modeloParsed || (p.nombre || "").replace(/^MOTOCICLET[A]?\s+/i, "").trim();
      return {
        chasis: p.chasis,
        motor: p.motor,
        modelo: modeloLimpio,
        marca: inferirMarca(modeloLimpio || p.nombre),
        color: p.color,
        anio: p.anio,
        cilindraje: p.cilindraje,
        stock: p.stock,
        codigo: p.codigo,
      };
    });

    // Si solo hay 1 resultado: devolver como única encontrada
    if (lista.length === 1) {
      return res.json({ ok: true, encontrado: true, moto: lista[0], total: 1 });
    }

    // Múltiples coincidencias: devolver lista
    res.json({ ok: true, encontrado: true, total: matches.length, opciones: lista, multiple: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Siigo: crear productos (motos) + Factura de Compra desde factura Auteco ---
// Solo admin. Body esperado:
//   { motos: [{referencia, modelo, marca, color, anio, chasis, motor, precio, cilindraje}, ...],
//     factura: {numeroFactura, fechaFactura, proveedorNit, proveedorNombre, subtotal, iva, total, condicionPago} }
app.post("/api/siigo/crear-productos", requireAuth, requireAdmin, async (req, res) => {
  if (!siigo.siigoConfigurado()) {
    return res.status(503).json({ ok: false, error: "Siigo no configurado" });
  }
  const motos = Array.isArray(req.body?.motos) ? req.body.motos : [];
  const factura = req.body?.factura && typeof req.body.factura === "object" ? req.body.factura : null;
  if (motos.length === 0) {
    return res.status(400).json({ ok: false, error: "Sin motos para crear" });
  }

  // Paso 1: crear cada moto como Producto en Siigo
  const creados = [];
  const errores = [];
  for (const m of motos) {
    try {
      const resultado = await siigo.crearProducto(m);
      creados.push({
        chasis: m.chasis,
        modelo: m.modelo,
        referencia: m.referencia,
        id: resultado.id || null,
        code: resultado.code || (m.motor || m.chasis),
      });
    } catch (e) {
      // "already_exists" no es error real: el producto ya estaba creado
      const yaExiste = /already_exists|already exists/i.test(e.message);
      if (yaExiste) {
        creados.push({
          chasis: m.chasis,
          modelo: m.modelo,
          referencia: m.referencia,
          id: null,
          code: m.motor || m.chasis,
          yaExistia: true,
        });
      } else {
        errores.push({
          chasis: m.chasis,
          modelo: m.modelo,
          error: e.message,
        });
      }
    }
  }
  // Invalidar cache de productos para que la próxima lectura traiga los nuevos
  siigoCache = { data: null, fetchedAt: 0 };

  // Paso 2: crear Factura de Compra si llegaron datos de cabecera
  let facturaCompra = null;
  let facturaCompraError = null;
  let facturaCompraDiag = null; // datos de diagnostico para mostrar al admin si falla
  if (factura && factura.numeroFactura && factura.fechaFactura && factura.proveedorNit) {
    if (creados.length === 0) {
      facturaCompraError = "No se creo Factura de Compra porque ningun producto se creo exitosamente";
    } else {
      try {
        // Items para la factura: solo los que se crearon (no los errores)
        const itemsFactura = creados.map(c => {
          const moto = motos.find(m => m.chasis === c.chasis) || {};
          return {
            code: c.code,
            description: `MOTOCICLETA ${moto.modelo || ""} ${moto.color || ""} ${moto.anio || ""}`.trim(),
            price: Number(moto.precio) || 0,
          };
        });
        const resultado = await siigo.crearFacturaCompra({
          fecha: factura.fechaFactura,
          numero: factura.numeroFactura,
          nitProveedor: factura.proveedorNit,
          items: itemsFactura,
          total: Number(factura.total) || itemsFactura.reduce((s, i) => s + i.price * 1.19, 0),
          observaciones: `${factura.numeroFactura} - ${factura.proveedorNombre || "AUTOTECNICA"} - ${factura.condicionPago || ""}`.trim(),
        });
        facturaCompra = {
          id: resultado.id || null,
          name: resultado.name || null,
          numero: resultado.number || factura.numeroFactura,
        };
      } catch (e) {
        facturaCompraError = e.message;

        // Si fallo por falta de payment_type, agregar diagnostico con lo que Siigo
        // tiene disponible. Asi el admin ve la lista directo en el dashboard.
        if (/payment_type|medio de pago|SIIGO_FC_PAYMENT_TYPE_ID/i.test(e.message)) {
          facturaCompraDiag = { paymentTypes: [], errores: {} };
          try {
            const lista = await siigo.listarTiposDocumento("FC");
            const tipos = Array.isArray(lista) ? lista : (lista.results || []);
            for (const doc of tipos) {
              const pts = Array.isArray(doc.payment_types) ? doc.payment_types : [];
              for (const pt of pts) {
                facturaCompraDiag.paymentTypes.push({
                  id: pt.id, name: pt.name || "", code: pt.code || "", fuente: `doc ${doc.code || doc.name}`,
                });
              }
            }
          } catch (e2) {
            facturaCompraDiag.errores.documentTypes = e2.message;
          }
          try {
            const lista = await siigo.listarPaymentTypes("FC");
            const pts = Array.isArray(lista) ? lista : (lista.results || []);
            for (const pt of pts) {
              facturaCompraDiag.paymentTypes.push({
                id: pt.id, name: pt.name || "", code: pt.code || "", fuente: "/v1/payment-types",
              });
            }
          } catch (e2) {
            facturaCompraDiag.errores.paymentTypes = e2.message;
          }
        }
      }
    }
  } else if (factura) {
    facturaCompraError = "Datos incompletos en factura (falta numero, fecha o NIT proveedor)";
  }

  res.json({
    ok: true,
    total: motos.length,
    creados,
    errores,
    facturaCompra,
    facturaCompraError,
    facturaCompraDiag,
  });
});

// --- Siigo: listar tipos de Factura de Compra disponibles (ayuda para configurar IDs) ---
// Solo admin. GET /api/siigo/tipos-compra
app.get("/api/siigo/tipos-compra", requireAuth, requireAdmin, async (req, res) => {
  if (!siigo.siigoConfigurado()) {
    return res.status(503).json({ ok: false, error: "Siigo no configurado" });
  }
  try {
    const lista = await siigo.listarTiposDocumento("FC");
    res.json({ ok: true, tipos: lista });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Siigo: extraer payment_types disponibles para Factura de Compra ---
// Solo admin. GET /api/siigo/payment-types-fc
// Combina dos fuentes:
//   (1) payment_types embebidos en /v1/document-types?type=FC
//   (2) lista completa de /v1/payment-types?document_type=FC
// Devuelve lista plana de {id, name, code, fuente} para que admin pueda copiar ID.
app.get("/api/siigo/payment-types-fc", requireAuth, requireAdmin, async (req, res) => {
  if (!siigo.siigoConfigurado()) {
    return res.status(503).json({ ok: false, error: "Siigo no configurado" });
  }
  const paymentTypes = [];
  const vistos = new Set();
  const errores = {};

  // Fuente 1: embebidos en document-types
  try {
    const lista = await siigo.listarTiposDocumento("FC");
    const tipos = Array.isArray(lista) ? lista : (lista.results || []);
    for (const doc of tipos) {
      const pts = Array.isArray(doc.payment_types) ? doc.payment_types : [];
      for (const pt of pts) {
        const key = `${pt.id}`;
        if (vistos.has(key)) continue;
        vistos.add(key);
        paymentTypes.push({
          id: pt.id,
          name: pt.name || "",
          code: pt.code || "",
          fuente: "document-types",
          docTypeName: doc.name || doc.code || "FC",
        });
      }
    }
  } catch (e) {
    errores.documentTypes = e.message;
  }

  // Fuente 2: endpoint dedicado /v1/payment-types
  try {
    const lista = await siigo.listarPaymentTypes("FC");
    const pts = Array.isArray(lista) ? lista : (lista.results || []);
    for (const pt of pts) {
      const key = `${pt.id}`;
      if (vistos.has(key)) continue;
      vistos.add(key);
      paymentTypes.push({
        id: pt.id,
        name: pt.name || "",
        code: pt.code || "",
        fuente: "payment-types",
      });
    }
  } catch (e) {
    errores.paymentTypes = e.message;
  }

  const actualEnv = process.env.SIIGO_FC_PAYMENT_TYPE_ID
    ? parseInt(process.env.SIIGO_FC_PAYMENT_TYPE_ID, 10)
    : null;

  res.json({
    ok: true,
    paymentTypes,
    totalEncontrados: paymentTypes.length,
    configActual: {
      SIIGO_FC_DOC_TYPE_ID: process.env.SIIGO_FC_DOC_TYPE_ID || "(no configurado, se autodetecta)",
      SIIGO_FC_PAYMENT_TYPE_ID: actualEnv || "(no configurado, se autodetecta)",
    },
    erroresConsulta: Object.keys(errores).length ? errores : undefined,
    instrucciones: "Copia el ID del medio de pago tipo 'Credito' o 'CXP Proveedores' y configuralo en Render como SIIGO_FC_PAYMENT_TYPE_ID. Si la lista esta vacia, en Siigo hay que crear primero un medio de pago para Factura de Compra.",
  });
});

// --- Health (público, útil para diagnóstico) ---
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ambiente: IMPULSA_ENV,
    baseUrl: IMPULSA_BASE_URL,
    establecimiento: ESTABLECIMIENTO,
    usuarioImpulsa: USUARIO_TRAZABILIDAD,
    apiKeyConfigurada: !!IMPULSA_API_KEY,
    apiKeyLongitud: IMPULSA_API_KEY.length,
    totalUsuarios: leerUsuarios().length,
    sesionActiva: !!(req.session && req.session.userEmail),
    siigoConfigurado: siigo.siigoConfigurado(),
  });
});

// --- Static files con control de auth ---
// El login es público. Todo lo demás requiere sesión.
app.get("/login.html", (req, res, next) => {
  if (req.session && req.session.userEmail) return res.redirect("/");
  next();
});

// Servir archivos públicos sin restricción (login, manifest PWA, íconos, service worker)
const PUBLIC_FILES = [
  "/login.html", "/logo.png", "/styles.css",
  "/manifest.webmanifest", "/service-worker.js",
  "/icon-192.png", "/icon-512.png", "/icon-512-maskable.png",
];
app.get(PUBLIC_FILES, (req, res) => {
  const file = req.path.replace(/^\//, "");
  res.sendFile(path.join(__dirname, file));
});

// Todo lo demás (incluyendo /) requiere sesión
app.use(requireAuth);
app.use(express.static(__dirname));

// --- Arranque ---
app.listen(PORT, HOST, () => {
  const usuarios = leerUsuarios();
  console.log("");
  console.log("==================================================================");
  console.log("  Yeimy Comercial — servidor multi-usuario iniciado");
  console.log("==================================================================");
  console.log(`  Acceso local:        http://localhost:${PORT}`);
  if (HOST === "0.0.0.0") {
    // Mostrar IPs locales para acceso desde otros dispositivos
    const nets = require("os").networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === "IPv4" && !net.internal) ips.push(net.address);
      }
    }
    if (ips.length) {
      console.log("  Acceso por WiFi:");
      ips.forEach(ip => console.log(`     http://${ip}:${PORT}`));
      console.log("     (los asesores entran a una de estas URLs desde sus dispositivos)");
    }
  }
  console.log(`  Ambiente Impulsa:    ${IMPULSA_ENV.toUpperCase()}`);
  console.log(`  Establecimiento:     ${ESTABLECIMIENTO}`);
  console.log(`  Usuarios cargados:   ${usuarios.length}`);
  usuarios.forEach(u => console.log(`     - ${u.email.padEnd(40)} [${u.rol}]`));
  if (!IMPULSA_API_KEY) {
    console.log("");
    console.log("  ATENCION: IMPULSA_API_KEY no está configurada en .env");
  } else {
    console.log(`  API Key Impulsa:     configurada (${IMPULSA_API_KEY.length} caracteres)`);
  }
  console.log("");
  console.log("  Para detener: presiona Ctrl+C");
  console.log("==================================================================");
  console.log("");
});
