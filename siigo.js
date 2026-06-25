/* siigo.js — Cliente para la API REST de Siigo Nube.
 *
 * Flujo:
 *   1) POST https://api.siigo.com/auth con { username, access_key } → devuelve JWT (24h)
 *   2) GET  https://api.siigo.com/v1/products con Bearer + Partner-Id → lista productos
 *
 * Se cachea el JWT en memoria por 23h (margen de 1h antes que expire en Siigo).
 *
 * Requiere Node >= 18 (fetch nativo).
 *
 * Variables de entorno:
 *   SIIGO_USERNAME    Correo del usuario API (en Siigo → ⚙️ → Más config → API)
 *   SIIGO_ACCESS_KEY  AccessKey larga generada en la misma pantalla
 *   SIIGO_PARTNER_ID  Identificador de la integración (por defecto "ServiautecConcesionario")
 */

const SIIGO_BASE = "https://api.siigo.com";
const PARTNER_ID = process.env.SIIGO_PARTNER_ID || "ServiautecConcesionario";
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // 23h

let tokenCache = { jwt: null, expiresAt: 0 };

function siigoConfigurado() {
  return !!(process.env.SIIGO_USERNAME && process.env.SIIGO_ACCESS_KEY);
}

async function obtenerToken() {
  const now = Date.now();
  if (tokenCache.jwt && tokenCache.expiresAt > now) return tokenCache.jwt;

  if (!siigoConfigurado()) {
    throw new Error("SIIGO_USERNAME o SIIGO_ACCESS_KEY no configurados");
  }

  const resp = await fetch(`${SIIGO_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.SIIGO_USERNAME,
      access_key: process.env.SIIGO_ACCESS_KEY,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Siigo auth ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const jwt = data.access_token || data.token || data.jwt;
  if (!jwt) throw new Error("Siigo auth no devolvió access_token");

  tokenCache = { jwt, expiresAt: now + TOKEN_TTL_MS };
  return jwt;
}

/**
 * Lista productos paginando hasta agotar resultados o hasta `maxPaginas`.
 * Retorna array plano de productos.
 */
async function obtenerProductos({ pageSize = 100, maxPaginas = 50 } = {}) {
  const jwt = await obtenerToken();
  const productos = [];
  let page = 1;

  while (page <= maxPaginas) {
    const url = `${SIIGO_BASE}/v1/products?page=${page}&page_size=${pageSize}`;
    const resp = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Partner-Id": PARTNER_ID,
      },
    });

    if (resp.status === 401) {
      // Token vencido inesperadamente: invalidar y reintentar una vez
      tokenCache = { jwt: null, expiresAt: 0 };
      if (page === 1) return obtenerProductos({ pageSize, maxPaginas });
      throw new Error("Siigo 401 después de renovar token");
    }

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Siigo /v1/products ${resp.status}: ${txt.slice(0, 200)}`);
    }

    const data = await resp.json();
    const results = Array.isArray(data) ? data : (data.results || data.data || []);
    if (!results.length) break;
    productos.push(...results);

    if (results.length < pageSize) break; // última página
    page++;
  }

  return productos;
}

/**
 * Extrae chasis, motor, color, año y cilindraje desde el campo `description`
 * de Siigo. Ejemplo:
 *   "MOTOCICLETA RAIDER 125 FI GRIS CALIFORNIA CALCOMANIA DORADA 2027 (124.8CC)
 *    CHASIS 9FL25AF99VDE17429 MOTOR GF9AV10A3896"
 *
 * → { chasis: "9FL25AF99VDE17429", motor: "GF9AV10A3896",
 *     anio: "2027", cilindraje: "124.8CC", color: "GRIS CALIFORNIA CALCOMANIA DORADA" }
 */
function parseDescripcion(desc) {
  if (!desc || typeof desc !== "string") return {};
  const out = {};

  const mChasis = desc.match(/CHASIS\s+([A-Z0-9]+)/i);
  if (mChasis) out.chasis = mChasis[1].toUpperCase();

  const mMotor = desc.match(/MOTOR\s+([A-Z0-9]+)/i);
  if (mMotor) out.motor = mMotor[1].toUpperCase();

  const mAnio = desc.match(/\b(20\d{2})\b/);
  if (mAnio) out.anio = mAnio[1];

  const mCC = desc.match(/\(([\d.]+\s*CC)\)/i);
  if (mCC) out.cilindraje = mCC[1].toUpperCase().replace(/\s+/g, "");

  // Limpiar descripción: quitar MOTOCICLETA, CHASIS+..., (xCC), año
  const limpio = desc
    .replace(/^MOTOCICLET[A]?\s+/i, "")
    .replace(/\s*CHASIS\s+.*$/i, "")
    .replace(/\s*\([\d.]+\s*CC\)\s*/i, " ")
    .replace(/\b(20\d{2})\b/, "")
    .trim();
  // Partir entre modelo y color: heurística — color empieza con palabras comunes
  const partes = limpio.split(/\s+/);
  const colorIdx = partes.findIndex(w => /^(NEGR|BLANC|ROJ|AZUL|GRIS|VERDE|AMARILL|PLATA|NARANJ|MARRON|DORAD)/i.test(w));
  if (colorIdx > 0) {
    out.color = partes.slice(colorIdx).join(" ").trim();
    out.modelo = partes.slice(0, colorIdx).join(" ").trim(); // todo lo previo al color = modelo
  } else {
    // No se detectó color → todo el limpio es modelo
    out.modelo = limpio;
  }

  return out;
}

/**
 * Normaliza un producto Siigo al shape mínimo que usa el frontend.
 */
function normalizarProducto(p) {
  const precio = (() => {
    const lista = p?.prices?.[0]?.price_list?.[0]?.value;
    if (typeof lista === "number") return lista;
    return null;
  })();
  const desc = p.description || "";
  const parsed = parseDescripcion(desc);

  return {
    id: p.id || p.code || null,
    codigo: p.code || "",
    nombre: p.name || "",
    referencia: p.reference || "",
    descripcion: desc,
    chasis: parsed.chasis || "",
    motor: parsed.motor || "",
    modeloParsed: parsed.modelo || "",
    color: parsed.color || "",
    anio: parsed.anio || "",
    cilindraje: parsed.cilindraje || "",
    stock: typeof p.available_quantity === "number" ? p.available_quantity
         : typeof p.stock === "number" ? p.stock : null,
    precio,
    activo: p.active !== false,
    creado: p?.metadata?.created || null,
  };
}

/**
 * Crea un producto (moto) en Siigo vía POST /v1/products.
 * Defaults aplicados:
 *   - account_group: { id: 743 }  (Productos)
 *   - tax_classification: "Taxed"
 *   - taxes: [{ id: 7801 }]       (IVA 19%)
 *   - unit: { code: "94" }        (unidad)
 *   - stock_control: true
 *   - active: true
 *
 * Datos esperados:
 *   { modelo, marca, color, anio, chasis, motor, precio, cilindraje }
 *
 * Construye el `description` en el formato estándar de Siigo:
 *   "MOTOCICLETA {modelo} {color} {año} ({cilindraje}) CHASIS {x} MOTOR {y}"
 */
async function crearProducto(datos) {
  const jwt = await obtenerToken();
  const modelo = String(datos.modelo || "").trim().toUpperCase();
  const color = String(datos.color || "").trim().toUpperCase();
  const anio = String(datos.anio || "").trim();
  const chasis = String(datos.chasis || "").trim().toUpperCase();
  const motor = String(datos.motor || "").trim().toUpperCase();
  const cilindraje = String(datos.cilindraje || "").trim().toUpperCase();
  const referencia = String(datos.referencia || "").trim();
  const precio = Number(datos.precio) || 0;

  if (!chasis || !modelo) {
    throw new Error("chasis y modelo son obligatorios");
  }

  // Code: usar el motor (es el que Siigo usa hoy como code). Si no hay motor, usar chasis.
  const code = motor || chasis;

  // Description en el formato que ya usa Siigo
  const descParts = ["MOTOCICLETA", modelo];
  if (color) descParts.push(color);
  if (anio) descParts.push(anio);
  if (cilindraje) descParts.push(`(${cilindraje})`);
  if (referencia) descParts.push(`REF ${referencia}`);
  descParts.push("CHASIS", chasis);
  if (motor) descParts.push("MOTOR", motor);
  const description = descParts.join(" ");

  const body = {
    code,
    name: `MOTOCICLETA ${modelo}`,
    account_group: 743,
    type: "Product",
    stock_control: true,
    active: true,
    tax_classification: "Taxed",
    tax_included: false,
    tax_consumption_value: 0,
    taxes: [{ id: 7801 }],
    unit: { code: "94" },
    unit_label: "unidad",
    description,
    additional_fields: referencia ? { reference: referencia } : {},
  };

  // Si trae precio, agregarlo
  if (precio > 0) {
    body.prices = [{
      currency_code: "COP",
      price_list: [{ position: 1, value: precio }],
    }];
  }

  console.log("[siigo] POST /v1/products body:", JSON.stringify(body));

  const resp = await fetch(`${SIIGO_BASE}/v1/products`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Partner-Id": PARTNER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Siigo POST /v1/products ${resp.status}: ${txt.slice(0, 300)}`);
  }

  return await resp.json();
}

// ============================================================
//      FACTURA DE COMPRA — POST /v1/purchases
// ============================================================
// Cachea el ID del tipo de documento "Factura de Compra" (FC) para no consultarlo
// en cada llamada. Se invalida cuando arranca el server o cuando falla la autenticacion.
let tipoFCCache = { id: null, name: null, fetchedAt: 0 };
const TIPO_FC_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Lista los tipos de documento de Siigo, opcionalmente filtrados.
 * type: "FC" (Factura de Compra), "FV" (Factura Venta), etc.
 */
async function listarTiposDocumento(type) {
  const jwt = await obtenerToken();
  const qs = type ? `?type=${encodeURIComponent(type)}` : "";
  const url = `${SIIGO_BASE}/v1/document-types${qs}`;
  const resp = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Partner-Id": PARTNER_ID,
    },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Siigo GET /v1/document-types ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return await resp.json();
}

/**
 * Lista todos los medios de pago de Siigo via /v1/payment-types.
 * documentType: opcional, ej "FC" para filtrar por tipo
 */
async function listarPaymentTypes(documentType) {
  const jwt = await obtenerToken();
  const qs = documentType ? `?document_type=${encodeURIComponent(documentType)}` : "";
  const url = `${SIIGO_BASE}/v1/payment-types${qs}`;
  const resp = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Partner-Id": PARTNER_ID,
    },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Siigo GET /v1/payment-types ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return await resp.json();
}

/**
 * Obtiene el ID del tipo "Factura de Compra".
 * Prioridad:
 *   1. process.env.SIIGO_FC_DOC_TYPE_ID si esta definido
 *   2. Cache si todavia es valido
 *   3. Llamada a Siigo: primer FC activo
 */
async function obtenerTipoFacturaCompra() {
  if (process.env.SIIGO_FC_DOC_TYPE_ID) {
    return { id: parseInt(process.env.SIIGO_FC_DOC_TYPE_ID, 10), name: "(env)" };
  }
  const now = Date.now();
  if (tipoFCCache.id && tipoFCCache.fetchedAt + TIPO_FC_TTL_MS > now) {
    return { id: tipoFCCache.id, name: tipoFCCache.name };
  }
  const lista = await listarTiposDocumento("FC");
  const tipos = Array.isArray(lista) ? lista : (lista.results || []);
  const activo = tipos.find(t => t.active !== false) || tipos[0];
  if (!activo || !activo.id) {
    throw new Error("Siigo no devolvio ningun tipo de documento 'FC' (Factura de Compra) activo");
  }
  tipoFCCache = { id: activo.id, name: activo.name || activo.code || "FC", fetchedAt: now };
  return { id: activo.id, name: tipoFCCache.name };
}

/**
 * Crea una Factura de Compra en Siigo.
 *
 * Required en datos:
 *   - fecha           "YYYY-MM-DD"
 *   - numero          ej "F660057710" (solo para observations / trazabilidad)
 *   - nitProveedor    solo digitos, ej "890900317"
 *   - items[]         [{ code, description, price }, ...]  cada code debe existir como producto
 *   - total           numero, valor total de la factura
 *
 * Opcionales:
 *   - observaciones  texto libre
 *   - paymentTypeId  override del medio de pago (default: process.env.SIIGO_FC_PAYMENT_TYPE_ID)
 *   - costCenterId   override del centro de costos
 */
async function crearFacturaCompra(datos) {
  const jwt = await obtenerToken();
  const tipoFC = await obtenerTipoFacturaCompra();

  const fecha = String(datos.fecha || "").trim();
  const numero = String(datos.numero || "").trim();
  const nitProveedor = String(datos.nitProveedor || "").trim().replace(/[^0-9]/g, "");
  const items = Array.isArray(datos.items) ? datos.items : [];
  const total = Number(datos.total) || 0;
  const observaciones = String(datos.observaciones || `Factura ${numero} - Auteco`).slice(0, 250);

  if (!fecha) throw new Error("fecha es obligatoria (YYYY-MM-DD)");
  if (!nitProveedor) throw new Error("nitProveedor es obligatorio");
  if (items.length === 0) throw new Error("items vacio");

  let paymentTypeId = datos.paymentTypeId
    || (process.env.SIIGO_FC_PAYMENT_TYPE_ID ? parseInt(process.env.SIIGO_FC_PAYMENT_TYPE_ID, 10) : null);

  // Auto-deteccion: si no hay env var, intentar descubrir un payment_type
  // Intento 1: payment_types embebidos en el doc FC
  if (!paymentTypeId) {
    try {
      const lista = await listarTiposDocumento("FC");
      const tipos = Array.isArray(lista) ? lista : (lista.results || []);
      const fc = tipos.find(t => t.id === tipoFC.id) || tipos[0];
      if (fc && Array.isArray(fc.payment_types) && fc.payment_types.length > 0) {
        const credito = fc.payment_types.find(p => /cred|cxp|prove|30/i.test((p.name || "") + " " + (p.code || "")))
          || fc.payment_types[0];
        paymentTypeId = credito.id;
        console.log(`[siigo] payment_type via document-types: "${credito.name || credito.code}" id=${credito.id}`);
      }
    } catch (e) {
      console.warn("[siigo] document-types embedded payment_types fallo:", e.message);
    }
  }

  // Intento 2: endpoint /v1/payment-types directo
  if (!paymentTypeId) {
    try {
      const lista = await listarPaymentTypes("FC");
      const pts = Array.isArray(lista) ? lista : (lista.results || []);
      if (pts.length > 0) {
        const credito = pts.find(p => /cred|cxp|prove|30/i.test((p.name || "") + " " + (p.code || "")))
          || pts[0];
        paymentTypeId = credito.id;
        console.log(`[siigo] payment_type via /v1/payment-types: "${credito.name || credito.code}" id=${credito.id}`);
      }
    } catch (e) {
      console.warn("[siigo] /v1/payment-types fallo:", e.message);
    }
  }

  if (!paymentTypeId) {
    throw new Error("No se encontro un medio de pago para Factura de Compra. Configura SIIGO_FC_PAYMENT_TYPE_ID en variables de entorno (Render). Para ver los disponibles abre /api/siigo/payment-types-fc");
  }

  // Parsear el numero de factura del proveedor en {prefix, number}
  // Ej: "F660057710" -> prefix:"F", number:"660057710"
  //     "FE-123"    -> prefix:"FE", number:"123"
  //     "12345"     -> prefix:"", number:"12345"
  let providerPrefix = "";
  let providerNumber = numero;
  const m = String(numero || "").match(/^([A-Za-z]+)[-]?(\d+)$/);
  if (m) {
    providerPrefix = m[1].toUpperCase();
    providerNumber = m[2];
  } else {
    // Si no matchea, intentar separar primer bloque alfanumerico no-numerico del resto
    const m2 = String(numero || "").match(/^([^\d]+)(.+)$/);
    if (m2) {
      providerPrefix = m2[1].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      providerNumber = m2[2].replace(/[^0-9]/g, "");
    }
  }

  // OJO: NO incluir currency en el body.
  // Siigo Colombia asume COP por defecto en cuentas locales. Si se envía
  // currency:{code:"COP"} el endpoint /v1/purchases lo rechaza con
  // "invalid_currency" en cuentas Colombia, y si se manda con exchange_rate
  // pide más campos. La solución oficial verificada (test directo a la API)
  // es omitir el campo currency completamente.
  const body = {
    document: { id: tipoFC.id },
    date: fecha,
    supplier: { identification: nitProveedor },
    provider_invoice: {
      prefix: providerPrefix || "FE",
      number: String(providerNumber || numero).replace(/[^0-9]/g, "") || "0",
    },
    items: items.map(it => ({
      type: "Product",
      code: String(it.code || ""),
      description: String(it.description || ""),
      quantity: 1,
      price: Number(it.price) || 0,
      taxes: [{ id: 7801 }], // IVA 19%
    })),
    // El payment.value debe ser exactamente igual al total que Siigo calcula
    // internamente desde los items + sus impuestos. Si items.price está sin IVA
    // y taxes incluye IVA 19%, entonces:
    //   total_siigo = sum(item.price) * 1.19   (redondeado a 2 decimales)
    payments: [{
      id: paymentTypeId,
      value: Math.round(items.reduce((s, it) => s + (Number(it.price) || 0), 0) * 1.19 * 100) / 100,
      due_date: fecha,
    }],
    observations: observaciones,
  };

  if (datos.costCenterId) {
    body.cost_center = parseInt(datos.costCenterId, 10);
  }

  // Log destacado para verificar que el campo currency está completo
  console.log("[siigo] === FACTURA DE COMPRA ===");
  console.log("[siigo] currency enviado:", JSON.stringify(body.currency));
  console.log("[siigo] POST /v1/purchases body completo:", JSON.stringify(body));

  const resp = await fetch(`${SIIGO_BASE}/v1/purchases`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Partner-Id": PARTNER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Siigo POST /v1/purchases ${resp.status}: ${txt.slice(0, 400)}`);
  }

  return await resp.json();
}

module.exports = {
  siigoConfigurado,
  obtenerToken,
  obtenerProductos,
  normalizarProducto,
  crearProducto,
  listarTiposDocumento,
  listarPaymentTypes,
  obtenerTipoFacturaCompra,
  crearFacturaCompra,
};
