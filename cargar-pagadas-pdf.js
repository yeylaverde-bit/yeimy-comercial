/* Script de un solo uso: marca como pagadas en comisiones-pagadas.json
 * todas las ventas que aparecen como pagadas (amarillas) en el PDF
 * VENTAS PAGADAS.pdf que Yeimy envió 2026-05-29.
 *
 * Hace match por nombre cliente (fuzzy) contra el Sheet de ventas.
 *
 * Uso: node cargar-pagadas-pdf.js
 * Genera/actualiza: comisiones-pagadas.json + imprime reporte de match.
 */

const fs = require("fs");
const path = require("path");

// Clientes pagados según mi lectura del PDF (filas amarillas)
// CORRECCIÓN 2026-05-29: las amarillas de MAYO NO son pagadas (Yeimy confirmó
// que las comisiones de mayo todavía no las cobra). Solo las de ABRIL están
// realmente pagadas. MAYO queda como pendiente. MARZO no se procesa aquí
// (todas pagadas hace rato, si quiere las marca después).
const PAGADOS_PDF = {
  // MAYO: NO pagar — todas pendientes (la comisión se cobra 30-60 días después)
  ABRIL: [
    "WILMAR NICOLAS OSORIO ZAPATA",
    "HERNAN ANTONIO COLMENARES",
    "MIGUEL ANGEL ROLON ROJAS",
    "FRANKLIN ALEXANDER CONTRERAS",
    "JAVIER JOSUE CUARO URBINA",
    "EZEQUIEL ALEJANDRO CASTILLO",
    "JOKSER GABRIEL GELVIZ GUERRERO",
    "YESENIA PAOLA CASTRILLON ARIZA",
    "YEIMI DANIELA ECHEVERRIA FAJARDO",
    "DISMAR ROMERO MARTINEZ",
    "RONNY ARTURO CASTILLO PERNALETE",
    "MARCOS ISRRAEL MOLINA MENDOZA",
    "RAFAEL HERNANDEZ NIÑO",
    "YEISSON DANIEL PINEDA CAMACARO",
    "CLAUDIO ANTONIO CALATAYUD",
    "EDDY COLMENARES",
  ],
};

// Normalización: minúsculas, sin acentos, sin signos
function normalizar(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Match: bidireccional, considerando que el Sheet a veces tiene nombre cortado.
// Acepta typos pequeños (1 letra distinta) comparando con includes parcial.
function nombresCoinciden(nombreSheet, nombrePagado) {
  const a = normalizar(nombreSheet);
  const b = normalizar(nombrePagado);
  if (!a || !b) return false;
  const tokensA = a.split(" ").filter(t => t.length >= 3);
  const tokensB = b.split(" ").filter(t => t.length >= 3);
  if (tokensA.length === 0 || tokensB.length === 0) return false;

  // Token "fuzzy" — coincide si está exacto o si solo difiere en 1 letra (typos como ISRAEL/ISRRAEL, GELVIS/GELVIZ)
  function tokenMatch(t1, t2) {
    if (t1 === t2) return true;
    // Concatenación (ej. "arroyopedraza" contiene "arroyo")
    if (t1.length >= 5 && t2.length >= 5 && (t1.includes(t2) || t2.includes(t1))) return true;
    // Mismas longitudes ±1 → Levenshtein simple
    if (Math.abs(t1.length - t2.length) > 1) return false;
    let diffs = 0; let i = 0, j = 0;
    while (i < t1.length && j < t2.length) {
      if (t1[i] === t2[j]) { i++; j++; }
      else { diffs++; if (diffs > 1) return false;
        if (t1.length > t2.length) i++;
        else if (t2.length > t1.length) j++;
        else { i++; j++; }
      }
    }
    return diffs + (t1.length - i) + (t2.length - j) <= 1;
  }

  // Cuántos tokens de A coinciden con algún token de B (y viceversa)
  const matchAB = tokensA.filter(ta => tokensB.some(tb => tokenMatch(ta, tb))).length;
  const matchBA = tokensB.filter(tb => tokensA.some(ta => tokenMatch(ta, tb))).length;

  // El nombre más corto debe matchear ≥60% Y mínimo 2 tokens coincidentes
  const minLen = Math.min(tokensA.length, tokensB.length);
  const matchCount = Math.max(matchAB, matchBA);
  return matchCount >= 2 && (matchCount / minLen) >= 0.6;
}

// Cálculo de IDs igual que el dashboard: chasis || factura || fechaStr-modelo-cliente
function idVenta(r) {
  return r.chasis || r.factura || `${r.fechaStr || ""}-${r.modelo || ""}-${r.cliente || ""}`;
}

// Parser básico de CSV (sin librería, suficiente para Google Sheets)
function parseCsv(text) {
  const rows = [];
  let cur = [], buf = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { buf += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else buf += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { cur.push(buf); buf = ""; }
      else if (c === "\n") { cur.push(buf); rows.push(cur); cur = []; buf = ""; }
      else if (c === "\r") {}
      else buf += c;
    }
  }
  if (buf.length || cur.length) { cur.push(buf); rows.push(cur); }
  const headers = rows.shift();
  return rows.map(r => Object.fromEntries(headers.map((h, i) => [h.trim(), (r[i] || "").trim()])));
}

function parseMoney(s) {
  if (!s) return 0;
  const v = String(s).replace(/[^0-9,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function parseDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [_, d, mo, y] = m;
  if (y.length === 2) y = "20" + y;
  return new Date(+y, +mo - 1, +d);
}

(async () => {
  const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSh3BOUXsJVvIOH_07kqNa-BgWDBGc5bP40jrJ5I320V4SxsBrbJoHTkUD7XuTQSHvNfJ-xMc6dpAEr/pub?gid=1242633923&single=true&output=csv";
  console.log("Bajando CSV de ventas...");
  const res = await fetch(CSV_URL);
  const text = await res.text();
  const raw = parseCsv(text);

  // Normalizar campos relevantes
  const ventas = raw.map(r => ({
    fecha: parseDate(r["Fecha"]),
    fechaStr: r["Fecha"] || "",
    asesor: (r["NOMBRE ASESOR"] || "").trim().toUpperCase(),
    cliente: r["Nombre_Cliente"] || "",
    modelo: (r["LINEA"] || "").toUpperCase(),
    marca: (r[":"] || "").toUpperCase(),
    chasis: r["Numero_Chasis"] || "",
    factura: r[" Num_Factura"] || r["Num_Factura"] || "",
    monto: parseMoney(r["Precio_Venta"]),
  }));

  const yeimi = ventas.filter(v => v.asesor === "YEIMI" && v.cliente && v.fecha);
  console.log(`Total ventas de YEIMI en el Sheet: ${yeimi.length}`);

  // Match: para cada cliente pagado del PDF, buscar en yeimi
  const matches = [];
  const sinMatch = [];
  const todosLosPagados = Object.values(PAGADOS_PDF).flat();
  for (const nombrePagado of todosLosPagados) {
    const venta = yeimi.find(v => nombresCoinciden(v.cliente, nombrePagado));
    if (venta) {
      matches.push({ nombrePagado, venta });
    } else {
      sinMatch.push(nombrePagado);
    }
  }

  console.log("");
  console.log("=== MATCHES ENCONTRADOS ===");
  for (const m of matches) {
    console.log(`  ✓ "${m.nombrePagado}" → "${m.venta.cliente}" (${m.venta.fechaStr}, ${m.venta.modelo}, chasis ${m.venta.chasis})`);
  }
  console.log("");
  console.log("=== SIN MATCH (revisar) ===");
  for (const s of sinMatch) console.log(`  ✗ ${s}`);

  // Cargar comisiones-pagadas.json existente
  const COMIS_PATH = path.join(__dirname, "comisiones-pagadas.json");
  let existentes = {};
  try { existentes = JSON.parse(fs.readFileSync(COMIS_PATH, "utf8")); } catch {}

  // Marcar como pagadas
  let nuevasMarcas = 0;
  for (const m of matches) {
    const id = idVenta(m.venta);
    if (!existentes[id]?.pagada) {
      existentes[id] = {
        pagada: true,
        fechaPago: new Date().toISOString(),
        marcadoPor: "carga-masiva-pdf-2026-05-29",
        cliente: m.venta.cliente,
        modelo: m.venta.modelo,
      };
      nuevasMarcas++;
    }
  }

  fs.writeFileSync(COMIS_PATH, JSON.stringify(existentes, null, 2), "utf8");
  console.log("");
  console.log("=== RESUMEN ===");
  console.log(`  Clientes pagados según PDF:    ${todosLosPagados.length}`);
  console.log(`  Matches contra Sheet:          ${matches.length}`);
  console.log(`  Nuevas marcas escritas:        ${nuevasMarcas}`);
  console.log(`  Sin match:                     ${sinMatch.length}`);
  console.log(`  Archivo actualizado:           ${COMIS_PATH}`);
})();
