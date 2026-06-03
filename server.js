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

// --- Endpoints de auth ---
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  const usuario = buscarUsuario(email);
  if (!usuario) {
    return res.status(401).json({ ok: false, error: "Email o clave incorrectos" });
  }
  const ok = await bcrypt.compare(String(password || ""), usuario.passwordHash);
  if (!ok) {
    return res.status(401).json({ ok: false, error: "Email o clave incorrectos" });
  }
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

// Borrar un documento específico
app.delete("/api/docs/:idVenta/:tipo", requireAuth, (req, res) => {
  const idVenta = idVentaSafe(req.params.idVenta);
  const { tipo } = req.params;
  if (!TIPOS_DOC.includes(tipo)) return res.status(400).json({ ok: false, error: "Tipo inválido" });
  const docs = leerDocsVentas();
  const info = docs[idVenta];
  if (!info?.archivos[tipo]) return res.status(404).json({ ok: false, error: "No existe" });

  // Solo el que subió el doc o un admin puede borrarlo
  const usuario = buscarUsuario(req.session.userEmail);
  if (info.archivos[tipo].subidoPor !== usuario.email && usuario.rol !== "admin") {
    return res.status(403).json({ ok: false, error: "Sin permiso" });
  }
  try { fs.unlinkSync(path.join(UPLOADS_DIR, idVenta, info.archivos[tipo].path)); } catch {}
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
  // Taller solo puede cambiar estado a lista_para_entregar (no otros campos)
  if (esTaller && !esDueno && usuario.rol !== "admin") {
    if (req.body.estado !== "lista_para_entregar") {
      return res.status(403).json({ ok: false, error: "Taller solo puede marcar 'lista_para_entregar'" });
    }
    todas[chasis].estado = "lista_para_entregar";
    todas[chasis].listaEn = new Date().toISOString();
    todas[chasis].listaPor = usuario.email;
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
    const camposPermitidos = ["estado", "gps", "placa", "numCredito", "financiera", "celular", "fechaNacimiento", "imeiGps", "gpsInstalarEvidenciaPath", "gpsActivarEvidenciaPath"];
    for (const c of camposPermitidos) {
      if (req.body[c] !== undefined) todas[chasis][c] = String(req.body[c]).trim();
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
  const usuario = buscarUsuario(req.session.userEmail);
  if (todas[chasis].asesorEmail !== usuario.email && usuario.rol !== "admin") {
    return res.status(403).json({ ok: false, error: "Sin permiso" });
  }
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

    const prompt = `Esta es una factura de Auteco (importador de motocicletas en Colombia: TVS, Victory, Kymco, Benelli, Kawasaki, Ceronte).

Por cada moto en la factura, extrae estos datos exactos:
- chasis (VIN, número de chasis, suele ser alfanumérico de 17 caracteres)
- motor (número del motor)
- marca (TVS, VICTORY, KYMCO, BENELLI, KAWASAKI, CERONTE, etc.)
- modelo (ej: APACHE RTR 160, RAIDER 125, NTORQ 125)
- color (NEGRO, ROJO, AZUL, GRIS, etc.)
- año (modelo o cilindraje si aparece, ej: 2026)
- precio (valor unitario o total por moto, en COP)

Devuelve SOLO un JSON válido con este formato exacto, sin texto extra ni explicación:

{
  "motos": [
    { "chasis": "...", "motor": "...", "marca": "...", "modelo": "...", "color": "...", "anio": "...", "precio": 0 },
    ...
  ]
}

Si no puedes leer algún campo, usa "" o 0. Si la imagen no es una factura legible, devuelve {"motos": []}.`;

    const result = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
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
Suele tener un código de barras y un IMEI (número de 15 dígitos que identifica el dispositivo).

Extrae:
- imei: el número IMEI (15 dígitos numéricos, generalmente empieza con 86 o 35)
- serial: número de serie si aparece (puede ser alfanumérico)
- modelo: marca/modelo del GPS si aparece (ej: TS101, GT06, etc.)

Devuelve SOLO un JSON válido con este formato exacto, sin texto extra:
{
  "imei": "...",
  "serial": "...",
  "modelo": "..."
}

Si no puedes leer algún campo, usa "". Si la imagen no es un sticker de GPS, devuelve {"imei":"","serial":"","modelo":""}.`;

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
        if (usuario.rol !== "admin" && r.usuario !== usuario.email) {
          nuevas.push(linea);  // Sin permiso → no se borra
          continue;
        }
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

  const usuario = buscarUsuario(req.session.userEmail);
  const subidor = Object.values(info.archivos || {})[0]?.subidoPor;
  if (usuario.rol !== "admin" && subidor && subidor !== usuario.email) {
    return res.status(403).json({ ok: false, error: "Sin permiso" });
  }

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

// --- Endpoints de gestión de usuarios (solo admin) ---
app.get("/api/usuarios", requireAuth, requireAdmin, (req, res) => {
  const usuarios = leerUsuarios().map(u => ({
    email: u.email,
    nombre: u.nombre,
    apellido: u.apellido,
    rol: u.rol,
    debeChangePass: !!u.debeChangePass,
    creadoEn: u.creadoEn,
  }));
  res.json({ ok: true, usuarios });
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
  const ts = Date.now();
  const habeas = form.HabeasData === true || form.HabeasData === "on" || form.HabeasData === "true";
  // Defaults por usuario: si no manda Origen/Campanna explícitos, usar nombre del logueado
  const origen = (form.Origen || `Venta ${usuario.nombre}`).slice(0, 50);
  const campanna = (form.Campanna || `Venta ${usuario.nombre}`).slice(0, 50);
  return {
    ID: 0,
    IDOportunidadAuteco: `${usuario.nombre.replace(/\s+/g, "")}-${ts}`,
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

    // Helper para inferir marca
    function inferirMarca(nombre) {
      const n = (nombre || "").toUpperCase();
      if (/RAIDER|APACHE|NTORQ|SPORT|STAR|HLX|RTX/.test(n)) return "TVS";
      if (/KING|VICTORY|NITRO|MOTO\s*CARRO|MRX|XKM|MOBILITY/.test(n)) return "MOBILITY";
      if (/AKT/.test(n)) return "AKT";
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
    const lista = matches.slice(0, 20).map(p => ({
      chasis: p.chasis,
      motor: p.motor,
      modelo: (p.nombre || "").replace(/^MOTOCICLET[A]?\s+/i, "").trim(),
      marca: inferirMarca(p.nombre),
      color: p.color,
      anio: p.anio,
      cilindraje: p.cilindraje,
      stock: p.stock,
      codigo: p.codigo,
    }));

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

// --- Siigo: crear productos (motos) en lote desde factura Auteco ---
// Solo admin. Body esperado: { motos: [{modelo, marca, color, anio, chasis, motor, precio, cilindraje}, ...] }
app.post("/api/siigo/crear-productos", requireAuth, requireAdmin, async (req, res) => {
  if (!siigo.siigoConfigurado()) {
    return res.status(503).json({ ok: false, error: "Siigo no configurado" });
  }
  const motos = Array.isArray(req.body?.motos) ? req.body.motos : [];
  if (motos.length === 0) {
    return res.status(400).json({ ok: false, error: "Sin motos para crear" });
  }
  const creados = [];
  const errores = [];
  for (const m of motos) {
    try {
      const resultado = await siigo.crearProducto(m);
      creados.push({
        chasis: m.chasis,
        modelo: m.modelo,
        id: resultado.id || null,
        code: resultado.code || null,
      });
    } catch (e) {
      errores.push({
        chasis: m.chasis,
        modelo: m.modelo,
        error: e.message,
      });
    }
  }
  // Invalidar cache de productos para que la próxima lectura traiga los nuevos
  siigoCache = { data: null, fetchedAt: 0 };
  res.json({ ok: true, total: motos.length, creados, errores });
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
