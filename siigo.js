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
 * Normaliza un producto Siigo al shape mínimo que usa el frontend.
 * Siigo retorna campos como: id, code, name, account_group, stock, available_quantity,
 * prices: [{ currency_code, price_list: [{ position, value }] }], etc.
 */
function normalizarProducto(p) {
  const precio = (() => {
    const lista = p?.prices?.[0]?.price_list?.[0]?.value;
    if (typeof lista === "number") return lista;
    return null;
  })();
  return {
    id: p.id || p.code || null,
    codigo: p.code || "",
    nombre: p.name || "",
    referencia: p.reference || "",
    stock: typeof p.available_quantity === "number" ? p.available_quantity
         : typeof p.stock === "number" ? p.stock : null,
    precio,
    activo: p.active !== false,
    raw: p,
  };
}

module.exports = {
  siigoConfigurado,
  obtenerToken,
  obtenerProductos,
  normalizarProducto,
};
