/* KNINE — Dashboard de ventas en vivo
   Lee el CSV publicado de Google Sheets, calcula KPIs, llena tablas y gráficas,
   y se auto-refresca cada 60 segundos.
*/

const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSh3BOUXsJVvIOH_07kqNa-BgWDBGc5bP40jrJ5I320V4SxsBrbJoHTkUD7XuTQSHvNfJ-xMc6dpAEr/pub?gid=1242633923&single=true&output=csv";
const REFRESH_MS = 60_000;
const PAGE_SIZE = 25;

// Lista de asesores activos (los que aún trabajan en el concesionario).
// Editar esta lista si entra alguien nuevo o sale alguien.
const ASESORES_ACTIVOS = [
  "YEIMI",
  "ALEJANDRA",
  "NATHALIA",
  "MIGUEL",
  "JUAN PABLO",
  "ESTEBAN",
  "XIMENA",
  "LORENA",
];

// Asesor para la vista "Mis ventas" (Yeimi) — debe coincidir con el nombre en la hoja
const MI_NOMBRE = "YEIMI";
const COMISION_PCT = 0.05; // 5% antes de IVA
function esActivo(asesor) {
  if (!asesor) return false;
  const n = asesor.trim().toUpperCase();
  return ASESORES_ACTIVOS.some(a => a.toUpperCase() === n);
}

// --- estado global ---
const state = {
  rows: [],
  filtered: [],
  page: 1,
  filters: { asesor: "", marca: "", medio: "", anio: "", mes: "", search: "" },
  charts: {},
  comisionesPagadas: {}, // { "<id_venta>": { pagada: true, fechaPago: "ISO" } }
};

function idVenta(r) {
  return r.chasis || r.factura || `${r.fechaStr || ""}-${r.modelo || ""}-${r.cliente || ""}`;
}

async function loadComisionesPagadas() {
  if (!currentUser || currentUser.rol !== "admin") return;
  try {
    const r = await fetch("/api/comisiones/pagadas");
    if (!r.ok) return;
    const data = await r.json();
    if (data.ok) state.comisionesPagadas = data.comisiones || {};
  } catch (e) {
    console.error("Error cargando comisiones pagadas:", e);
  }
}

async function marcarComisionPagada(id, pagada) {
  try {
    const r = await fetch("/api/comisiones/marcar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, pagada }),
    });
    const data = await r.json();
    if (data.ok) {
      if (pagada) {
        state.comisionesPagadas[String(id)] = { pagada: true, fechaPago: new Date().toISOString() };
      } else {
        delete state.comisionesPagadas[String(id)];
      }
      renderMisVentas();
      showToast(pagada ? "Marcada como cobrada" : "Marcada como pendiente");
    } else {
      showToast(data.error || "Error al marcar");
    }
  } catch {
    showToast("Error de conexión");
  }
}

// --- helpers ---
const fmtCOP = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("es-CO");
const $ = (sel) => document.querySelector(sel);

function parseMoney(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[^0-9,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  // dd/mm/yyyy
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [_, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return new Date(+y, +mo - 1, +d);
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

function pick(row, candidates) {
  for (const k of candidates) {
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase() === k.toLowerCase()) {
        const v = row[key];
        if (v != null && String(v).trim() !== "") return String(v).trim();
      }
    }
  }
  return "";
}

// Correcciones manuales de fecha: cuando el Sheet del concesionario tiene la
// fecha de facturación o pedido en vez de la fecha real de cierre de venta de Yeimy.
// La clave es el nombre del cliente (uppercase, sin acentos básicos). La fecha
// usada será la del array {anio, mes, dia}, mes 0-indexed.
const CORRECCIONES_FECHA = {
  "CARLOS ALBERTO PIEDRAHITA": { anio: 2026, mes: 4, dia: 1 }, // mover a mayo
  "LUIS ALFREDO PAREDES":      { anio: 2026, mes: 4, dia: 1 }, // mover a mayo
};

function normalizeRow(raw) {
  const fechaStr = pick(raw, ["Fecha", "Fecha_Venta"]);
  let fecha = parseDate(fechaStr);
  const clienteRaw = pick(raw, ["Nombre_Cliente", "Cliente"]).toUpperCase().trim();
  const corr = CORRECCIONES_FECHA[clienteRaw];
  if (corr) fecha = new Date(corr.anio, corr.mes, corr.dia);
  const monto = parseMoney(pick(raw, ["Precio_Venta", "Costo_Total", "Costo Total", "Valor", "Monto"]));
  const costoCompra = parseMoney(pick(raw, ["Precio_Compra", "Costo_Base"]));
  const utilidad = parseMoney(pick(raw, ["Utilidad_Neta", "Diferencia_Venta_Compra"]));
  const iva = parseMoney(pick(raw, ["Iva", "IVA"]));
  // "Antes de IVA" = precio dividido entre 1.19 (sacar la base gravable del 19%)
  // Esto da el mismo resultado que la tabla personal de Yeimi.
  const precioSinIva = monto / 1.19;
  const comision = precioSinIva * COMISION_PCT;
  // En la hoja real, la marca está en la columna llamada ":" y el modelo en "LINEA"
  const marca = pick(raw, [":", "Socio_Cormercial", "Socio_Comercial", "Marca"]).toUpperCase();
  const modelo = pick(raw, ["LINEA", "Modelo_Moto_Disponible", "Modelo"]).toUpperCase();
  const color = pick(raw, ["Color_Moto", "Color"]);
  const chasis = pick(raw, ["Numero_Chasis", "Nro. Chasis", "Nro_Chasis", "Chasis", "VIN"]);
  const factura = pick(raw, ["Num_Factura", "Nro._Factura", "Factura"]);
  const cliente = pick(raw, ["Nombre_Cliente", "Cliente"]);
  const municipio = pick(raw, ["Municipio", "Ciudad"]);
  const canal = pick(raw, ["Medios", "Canal"]);
  const placa = pick(raw, ["Numero_Placa", "Placa"]);
  // Normalizar a MAYÚSCULA para evitar duplicados por diferencias de capitalización ("Lorena" vs "LORENA")
  const asesor = pick(raw, ["NOMBRE ASESOR", "nombre de asesor", "Nombre de Asesor", "Asesor", "Vendedor"]).toUpperCase();
  const medio = pick(raw, ["Medio pago", "Medio_Pago", "Medio de pago", "Forma de pago"]);
  const financieraCol = pick(raw, ["Finacienra", "Financiera", "Entidad", "Banco"]);
  const cls = classifyMedio(medio);
  // Si es financiado, usamos el valor de Medio pago como nombre de la financiera
  // (CREDIORBE, PROGRESER, SUFI, RODAS, CEDIDA, etc.)
  const financiera = cls === "Financiado" ? (medio.toUpperCase() || financieraCol) : (cls === "Contado" ? "" : financieraCol);

  return {
    fecha, fechaStr, monto, costoCompra, utilidad, iva, precioSinIva, comision,
    marca, modelo, color, chasis, factura, cliente, municipio, canal, placa,
    asesor, medio, medioCls: cls, financiera,
    anio: fecha ? fecha.getFullYear() : null,
    mes: fecha ? `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}` : null,
  };
}

function isSold(r) {
  // Esta hoja no tiene columna Inventario: cuenta toda fila con fecha y monto válido
  return !!r.fecha && r.monto > 0;
}

function classifyMedio(medio) {
  const m = (medio || "").toLowerCase().trim();
  if (!m) return "Sin dato";
  if (m.includes("contado") || m.includes("efectivo")) return "Contado";
  // Todo lo demás (CREDIORBE, PROGRESER, SUFI, RODAS, CEDIDA...) cuenta como Financiado
  return "Financiado";
}

// --- carga ---
async function loadData() {
  try {
    const url = CSV_URL + (CSV_URL.includes("?") ? "&" : "?") + "t=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    state.rows = parsed.data.map(normalizeRow).filter(r => r.fecha || r.monto || r.modelo);
    populateFilters();
    applyFilters();
    $("#lastUpdate").textContent = new Date().toLocaleTimeString("es-CO");
    $("#rowsTotal").textContent = `${fmtNum.format(state.rows.length)} filas cargadas`;
    try { renderMetricasGerenciales(); } catch (e) { console.warn("metricas:", e.message); }
    showToast("Datos actualizados");
  } catch (e) {
    console.error(e);
    showToast("Error al cargar CSV");
  }
}

function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

// --- filtros ---
function populateFilters() {
  const sold = state.rows.filter(isSold);
  fillSelect("#filterAsesor", uniqueSorted(sold.map(r => r.asesor).filter(Boolean)));
  fillSelect("#filterMarca", uniqueSorted(sold.map(r => r.marca).filter(Boolean)));
  fillSelect("#filterMedio", uniqueSorted(sold.map(r => classifyMedio(r.medio)).filter(Boolean)));
  fillSelect("#filterAnio", uniqueSorted(sold.map(r => r.anio).filter(Boolean)).sort((a,b)=>b-a));
  // Mes: lista todos los meses YYYY-MM presentes
  const meses = uniqueSorted(sold.map(r => r.mes).filter(Boolean)).sort((a,b)=>b.localeCompare(a));
  fillSelectWithLabels("#filterMes", meses.map(m => ({ value: m, label: formatMes(m) })));
}

function fillSelectWithLabels(sel, items) {
  const el = $(sel);
  const current = el.value;
  const placeholder = el.querySelector("option").outerHTML;
  el.innerHTML = placeholder + items.map(i => `<option value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</option>`).join("");
  if (items.some(i => i.value === current) || current === "") el.value = current;
}

function fillSelect(sel, items) {
  const el = $(sel);
  const current = el.value;
  const placeholder = el.querySelector("option").outerHTML;
  el.innerHTML = placeholder + items.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if (items.includes(current) || current === "") el.value = current;
}

function uniqueSorted(arr) {
  return [...new Set(arr.map(String))].sort((a, b) => a.localeCompare(b, "es"));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function applyFilters() {
  const { asesor, marca, medio, anio, mes, search } = state.filters;
  const q = (search || "").toLowerCase().trim();
  state.filtered = state.rows
    .filter(isSold)
    .filter(r => !asesor || r.asesor === asesor)
    .filter(r => !marca || r.marca === marca)
    .filter(r => !medio || classifyMedio(r.medio) === medio)
    .filter(r => !anio || String(r.anio) === String(anio))
    .filter(r => !mes || r.mes === mes)
    .filter(r => !q || [r.asesor, r.modelo, r.marca, r.chasis, r.color, r.financiera].some(v => (v || "").toLowerCase().includes(q)));
  state.page = 1;
  renderAll();
}

// --- render ---
function renderAll() {
  renderMisVentas();
  renderKpis();
  renderAsesores();
  renderMatriz();
  renderVentas();
  renderCharts();
}

function renderMisVentas() {
  // Mis ventas respetan TODOS los filtros globales (mes, año, marca, etc.)
  // pero forzamos el asesor = YEIMI
  const misRows = state.filtered.filter(r => (r.asesor || "").toUpperCase() === MI_NOMBRE);

  const unidades = misRows.length;
  const monto = misRows.reduce((s, r) => s + r.monto, 0);
  const iva = misRows.reduce((s, r) => s + r.iva, 0);
  const sinIva = misRows.reduce((s, r) => s + r.precioSinIva, 0);
  const comision = misRows.reduce((s, r) => s + r.comision, 0);

  // Comisiones pagadas vs pendientes
  let comisionCobrada = 0;
  let comisionPendiente = 0;
  let countCobradas = 0;
  let countPendientes = 0;
  for (const r of misRows) {
    const id = idVenta(r);
    if (state.comisionesPagadas[id]?.pagada) {
      comisionCobrada += r.comision;
      countCobradas++;
    } else {
      comisionPendiente += r.comision;
      countPendientes++;
    }
  }

  $("#miUnidades").textContent = fmtNum.format(unidades);
  $("#miMonto").textContent = fmtCOP.format(monto);
  $("#miSinIva").textContent = fmtCOP.format(sinIva);
  $("#miComision").textContent = fmtCOP.format(comision);
  $("#miComisionSub").textContent = unidades
    ? `Promedio ${fmtCOP.format(comision / unidades)} por moto`
    : "5% × base sin IVA";
  $("#miUnidadesSub").textContent = unidades ? rangoFechas(misRows) : "Sin ventas en este periodo";
  $("#miMontoSub").textContent = unidades
    ? `Ticket promedio ${fmtCOP.format(monto / unidades)}`
    : "Precio total con IVA";

  // KPIs pagado/pendiente
  if ($("#miPendiente")) {
    $("#miPendiente").textContent = fmtCOP.format(comisionPendiente);
    $("#miPendienteSub").textContent = countPendientes
      ? `${countPendientes} ${countPendientes === 1 ? "moto" : "motos"} sin cobrar comisión`
      : "Todas cobradas ✓";
  }
  if ($("#miCobrado")) {
    $("#miCobrado").textContent = fmtCOP.format(comisionCobrada);
    $("#miCobradoSub").textContent = countCobradas
      ? `${countCobradas} ${countCobradas === 1 ? "moto" : "motos"} marcadas como pagadas`
      : "Marca tus comisiones cobradas con el ✓";
  }

  // Periodo badge
  const filtroMes = state.filters.mes;
  const filtroAnio = state.filters.anio;
  let periodo = "Todo el periodo";
  if (filtroMes) periodo = formatMes(filtroMes);
  else if (filtroAnio) periodo = `Año ${filtroAnio}`;
  $("#misVentasPeriodo").textContent = periodo;

  // Tabla: ordenadas de más reciente a más antigua, máx 20 filas visibles
  const sorted = [...misRows].sort((a, b) => (b.fecha?.getTime() || 0) - (a.fecha?.getTime() || 0));
  const slice = sorted.slice(0, 20);
  const tbody = $("#tblMisVentas tbody");
  tbody.innerHTML = slice.map(r => {
    const marcaTag = r.marca === "TVS" ? `<span class="tag tag-tvs">TVS</span>`
                   : r.marca === "MOBILITY" ? `<span class="tag tag-mobility">MOBILITY</span>`
                   : `<span class="tag tag-otro">${escapeHtml(r.marca || "—")}</span>`;
    const id = idVenta(r);
    const pagadaInfo = state.comisionesPagadas[id];
    const isPagada = !!pagadaInfo?.pagada;
    const fechaPagoFmt = isPagada && pagadaInfo.fechaPago
      ? new Date(pagadaInfo.fechaPago).toLocaleDateString("es-CO")
      : "";
    return `
      <tr class="${isPagada ? 'fila-pagada' : ''}" data-vid="${escapeHtml(id)}">
        <td>${r.fecha ? r.fecha.toLocaleDateString("es-CO") : "—"}</td>
        <td><code style="font-size:11px;color:var(--muted)">${escapeHtml(r.factura || "—")}</code></td>
        <td>${marcaTag}</td>
        <td><strong>${escapeHtml(r.modelo || "—")}</strong></td>
        <td>${escapeHtml(r.cliente || "—")}</td>
        <td class="num">${fmtCOP.format(r.monto)}</td>
        <td class="num muted-cell">${fmtCOP.format(r.iva)}</td>
        <td class="num">${fmtCOP.format(r.precioSinIva)}</td>
        <td class="num"><strong data-comision style="color:#5be58a">${fmtCOP.format(r.comision)}</strong></td>
        <td style="text-align:center">
          <input type="checkbox" class="chk-pagada" data-vid="${escapeHtml(id)}" ${isPagada ? 'checked' : ''} title="${isPagada ? 'Pagada el ' + fechaPagoFmt : 'Marcar como pagada'}" />
          ${isPagada ? `<span class="fecha-pago">${fechaPagoFmt}</span>` : ''}
        </td>
      </tr>`;
  }).join("") || `<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:20px">Sin ventas tuyas en el periodo seleccionado.</td></tr>`;

  if (sorted.length > 20) {
    tbody.innerHTML += `<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:10px;font-style:italic">Mostrando últimas 20 de ${sorted.length} ventas — ver todas en "Ventas detalladas" filtrando "YEIMI"</td></tr>`;
  }

  // Conectar checkboxes (delegación)
  tbody.querySelectorAll(".chk-pagada").forEach(chk => {
    chk.addEventListener("change", (ev) => {
      const id = ev.target.dataset.vid;
      const pagada = ev.target.checked;
      marcarComisionPagada(id, pagada);
    });
  });
}

function renderKpis() {
  const rows = state.filtered;
  const monto = rows.reduce((s, r) => s + r.monto, 0);
  const unidades = rows.length;
  const ticket = unidades ? monto / unidades : 0;
  const asesores = new Set(rows.map(r => r.asesor).filter(Boolean)).size;

  const contado = rows.filter(r => classifyMedio(r.medio) === "Contado").length;
  const financ = rows.filter(r => classifyMedio(r.medio) === "Financiado").length;
  const sinDato = unidades - contado - financ;

  $("#kpiUnidades").textContent = fmtNum.format(unidades);
  $("#kpiMonto").textContent = fmtCOP.format(monto);
  $("#kpiTicket").textContent = fmtCOP.format(ticket);
  $("#kpiAsesores").textContent = fmtNum.format(asesores);

  const pctContado = unidades ? Math.round(contado / unidades * 100) : 0;
  const pctFin = unidades ? Math.round(financ / unidades * 100) : 0;
  $("#kpiMedio").textContent = `${pctContado}% / ${pctFin}%`;
  $("#kpiMedioSub").textContent = `${contado} contado · ${financ} financiado${sinDato ? ` · ${sinDato} sin dato` : ""}`;
  $("#kpiUnidadesSub").textContent = rangoFechas(rows);
  $("#kpiMontoSub").textContent = `${rows.filter(r => r.marca === "TVS").length} TVS · ${rows.filter(r => r.marca === "MOBILITY").length} MOBILITY`;
}

function rangoFechas(rows) {
  const ds = rows.map(r => r.fecha).filter(Boolean);
  if (!ds.length) return "&nbsp;";
  const min = new Date(Math.min(...ds.map(d => d.getTime())));
  const max = new Date(Math.max(...ds.map(d => d.getTime())));
  const f = d => d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
  return `${f(min)} → ${f(max)}`;
}

function renderAsesores() {
  const groups = new Map();
  for (const r of state.filtered) {
    const k = r.asesor || "Sin asignar";
    if (!groups.has(k)) groups.set(k, { asesor: k, ventas: 0, monto: 0, costo: 0, utilidad: 0, contado: 0, financ: 0, modelos: new Map(), primera: null, ultima: null });
    const g = groups.get(k);
    g.ventas++;
    g.monto += r.monto;
    g.costo += r.costoCompra || 0;
    g.utilidad += r.utilidad || 0;
    if (r.fecha) {
      if (!g.primera || r.fecha < g.primera) g.primera = r.fecha;
      if (!g.ultima || r.fecha > g.ultima) g.ultima = r.fecha;
    }
    const med = classifyMedio(r.medio);
    if (med === "Contado") g.contado++;
    if (med === "Financiado") g.financ++;
    g.modelos.set(r.modelo, (g.modelos.get(r.modelo) || 0) + 1);
  }

  // Fecha de referencia para calcular antigüedad: la última venta en el set filtrado (o hoy)
  const refDate = state.filtered.reduce((m, r) => (r.fecha && (!m || r.fecha > m)) ? r.fecha : m, null) || new Date();
  const MS_PER_MONTH = 30.44 * 24 * 3600 * 1000;

  // Si hay un mes específico seleccionado, mostrar valores absolutos (no proyectados).
  // Sin filtro de mes → ritmo promedio mensual (toda la vida activa).
  const mesUnico = !!state.filters.mes;

  for (const g of groups.values()) {
    if (g.primera) {
      const diasActivo = Math.max(1, (refDate - g.primera) / (24 * 3600 * 1000));
      g.dias = Math.round(diasActivo);
      if (mesUnico) {
        // Un mes seleccionado: mostrar el total real del mes (no extrapolar)
        g.mesesActivo = 1;
        g.ventasMes = g.ventas;
        g.montoMes = g.monto;
        g.utilidadMes = g.utilidad;
      } else {
        // Vista total: ritmo promedio mensual de toda la vida activa
        g.mesesActivo = Math.max(0.5, diasActivo / 30.44);
        g.ventasMes = g.ventas / g.mesesActivo;
        g.montoMes = g.monto / g.mesesActivo;
        g.utilidadMes = g.utilidad / g.mesesActivo;
      }
      g.margen = g.monto > 0 ? (g.utilidad / g.monto) * 100 : 0;
    } else {
      g.dias = 0; g.mesesActivo = 0; g.ventasMes = 0; g.montoMes = 0; g.utilidadMes = 0; g.margen = 0;
    }
    g.activo = esActivo(g.asesor);
  }

  // Cambiar el subtítulo y los headers según el modo
  const subt = document.querySelector('#asesores .card-head h2 .muted');
  if (subt) subt.textContent = mesUnico ? `(${formatMes(state.filters.mes)} · valores reales)` : `(ajustada por tiempo activo)`;
  const headerVentas = document.querySelector('#tblAsesores thead th[title*="motos vendidas"]');
  const headerUtil = document.querySelector('#tblAsesores thead th[title*="Utilidad neta"]');
  const headerMonto = document.querySelector('#tblAsesores thead th[title*="Facturación"], #tblAsesores thead th[title*="facturado"]');
  if (headerVentas) headerVentas.textContent = mesUnico ? "Ventas" : "Ventas/mes";
  if (headerUtil) headerUtil.textContent = mesUnico ? "Utilidad" : "Utilidad/mes";
  if (headerMonto) headerMonto.textContent = mesUnico ? "Monto" : "Monto/mes";

  // Filtrar por activos si el toggle está prendido (default true)
  const soloActivos = state.soloActivos !== false;
  let visibles = [...groups.values()];
  if (soloActivos) visibles = visibles.filter(g => g.activo);

  // Orden por defecto: utilidad por mes (rentabilidad real ajustada por tiempo)
  const sortMode = state.asesorSort || "utilidadMes";
  const cmp = {
    utilidadMes: (a, b) => b.utilidadMes - a.utilidadMes,
    ventasMes:   (a, b) => b.ventasMes - a.ventasMes,
    montoMes:    (a, b) => b.montoMes - a.montoMes,
    margen:      (a, b) => b.margen - a.margen,
    utilidad:    (a, b) => b.utilidad - a.utilidad,
    monto:       (a, b) => b.monto - a.monto,
    ventas:      (a, b) => b.ventas - a.ventas,
  }[sortMode];
  const list = visibles.sort(cmp);
  const totalAll = groups.size;
  $("#asesoresCount").textContent = soloActivos ? `${list.length} activos · ${totalAll - list.length} inactivos ocultos` : `${list.length} asesores`;

  const tbody = $("#tblAsesores tbody");
  tbody.innerHTML = list.map((g, i) => {
    const top = [...g.modelos.entries()].sort((a, b) => b[1] - a[1])[0];
    const topStr = top ? `${escapeHtml(top[0])} <span class="muted">(${top[1]})</span>` : "—";
    const rankClass = i === 0 ? "rank gold" : i === 1 ? "rank silver" : i === 2 ? "rank bronze" : "rank";
    const antig = g.dias >= 30 ? `${(g.mesesActivo).toFixed(1)} m` : `${g.dias} d`;
    const estado = g.activo ? `<span class="tag tag-contado">Activo</span>` : `<span class="tag tag-otro">Inactivo</span>`;
    const margenColor = g.margen >= 8 ? "#5be58a" : g.margen >= 5 ? "#f7c272" : "#ff8c8c";
    return `
      <tr class="${g.activo ? '' : 'row-inactive'}">
        <td><span class="${rankClass}">${i + 1}</span></td>
        <td><strong>${escapeHtml(g.asesor)}</strong></td>
        <td>${estado}</td>
        <td class="num"><strong style="color:#7be6f4">${g.ventasMes.toFixed(1)}</strong></td>
        <td class="num"><strong style="color:#5be58a">${fmtCOP.format(g.utilidadMes)}</strong></td>
        <td class="num"><strong style="color:${margenColor}">${g.margen.toFixed(1)}%</strong></td>
        <td class="num">${fmtCOP.format(g.montoMes)}</td>
        <td class="num muted-cell">${antig}</td>
        <td class="num">${fmtNum.format(g.ventas)}</td>
        <td class="num">${fmtCOP.format(g.monto)}</td>
        <td class="num">${fmtCOP.format(g.utilidad)}</td>
        <td class="num">${fmtNum.format(g.contado)}</td>
        <td class="num">${fmtNum.format(g.financ)}</td>
        <td>${topStr}</td>
      </tr>`;
  }).join("") || `<tr><td colspan="14" style="text-align:center;color:var(--muted);padding:20px">Sin datos.</td></tr>`;
}

function renderMatriz() {
  // Matriz asesor x mes con la métrica seleccionada
  // IMPORTANTE: la matriz usa state.rows (todas las ventas) sin aplicar el filtro de mes,
  // porque la matriz YA muestra los meses. Pero respeta el resto de filtros.
  const { asesor, marca, medio, anio, search } = state.filters;
  const q = (search || "").toLowerCase().trim();
  const baseRows = state.rows
    .filter(isSold)
    .filter(r => !asesor || r.asesor === asesor)
    .filter(r => !marca || r.marca === marca)
    .filter(r => !medio || classifyMedio(r.medio) === medio)
    .filter(r => !anio || String(r.anio) === String(anio))
    .filter(r => !q || [r.asesor, r.modelo, r.marca, r.chasis, r.color, r.financiera].some(v => (v || "").toLowerCase().includes(q)));

  // Últimos 12 meses presentes en los datos (más reciente primero)
  const allMeses = [...new Set(baseRows.map(r => r.mes).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  const meses = allMeses.slice(0, 12).reverse(); // de más antiguo a más reciente para leer izq→der

  const metrica = state.matrizMetrica || "ventas";
  const soloActivos = state.matrizSoloActivos !== false;

  // Agrupar por asesor x mes
  const grupos = new Map();
  for (const r of baseRows) {
    const k = r.asesor || "Sin asignar";
    if (!grupos.has(k)) grupos.set(k, { asesor: k, porMes: new Map(), total: 0, activo: esActivo(k) });
    const g = grupos.get(k);
    let val = 0;
    if (metrica === "ventas") val = 1;
    else if (metrica === "monto") val = r.monto;
    else if (metrica === "utilidad") val = r.utilidad || 0;
    g.porMes.set(r.mes, (g.porMes.get(r.mes) || 0) + val);
    g.total += val;
  }

  let lista = [...grupos.values()];
  if (soloActivos) lista = lista.filter(g => g.activo);
  lista.sort((a, b) => b.total - a.total);

  const fmtCell = (v) => {
    if (!v) return `<span class="muted-cell">—</span>`;
    if (metrica === "ventas") return fmtNum.format(v);
    return fmtCOP.format(v);
  };

  // Calcular máximos por mes para heatmap
  const maxPorMes = new Map();
  for (const m of meses) {
    let max = 0;
    for (const g of lista) max = Math.max(max, g.porMes.get(m) || 0);
    maxPorMes.set(m, max);
  }

  // Render headers
  const thead = $("#tblMatriz thead");
  thead.innerHTML = `<tr>
    <th>Asesor</th>
    ${meses.map(m => `<th class="num">${formatMes(m)}</th>`).join("")}
    <th class="num"><strong>Total</strong></th>
  </tr>`;

  const tbody = $("#tblMatriz tbody");
  tbody.innerHTML = lista.map(g => `
    <tr class="${g.activo ? '' : 'row-inactive'}">
      <td><strong>${escapeHtml(g.asesor)}</strong></td>
      ${meses.map(m => {
        const v = g.porMes.get(m) || 0;
        const max = maxPorMes.get(m) || 1;
        const intensity = max ? v / max : 0;
        const bg = v ? `background:rgba(124,92,255,${(intensity * 0.35).toFixed(2)})` : '';
        return `<td class="num heat" style="${bg}">${fmtCell(v)}</td>`;
      }).join("")}
      <td class="num" style="background:rgba(34,211,238,0.10)"><strong>${fmtCell(g.total)}</strong></td>
    </tr>`).join("") || `<tr><td colspan="${meses.length + 2}" style="text-align:center;color:var(--muted);padding:20px">Sin datos.</td></tr>`;

  // Fila de totales por mes
  if (lista.length) {
    const totalRow = meses.map(m => lista.reduce((s, g) => s + (g.porMes.get(m) || 0), 0));
    const granTotal = totalRow.reduce((s, v) => s + v, 0);
    tbody.innerHTML += `
      <tr style="background:rgba(34,211,238,0.06);font-weight:700">
        <td><strong>TOTAL</strong></td>
        ${totalRow.map(v => `<td class="num">${fmtCell(v)}</td>`).join("")}
        <td class="num" style="background:rgba(34,211,238,0.20)"><strong>${fmtCell(granTotal)}</strong></td>
      </tr>`;
  }
}

function renderVentas() {
  const rows = [...state.filtered].sort((a, b) => (b.fecha?.getTime() || 0) - (a.fecha?.getTime() || 0));
  $("#ventasCount").textContent = `${fmtNum.format(rows.length)} ventas`;

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);

  const tbody = $("#tblVentas tbody");
  tbody.innerHTML = slice.map(r => {
    const med = classifyMedio(r.medio);
    const medTag = med === "Contado" ? `<span class="tag tag-contado">Contado</span>`
                : med === "Financiado" ? `<span class="tag tag-financiado">Financiado</span>`
                : `<span class="tag tag-otro">${escapeHtml(med)}</span>`;
    const marcaTag = r.marca === "TVS" ? `<span class="tag tag-tvs">TVS</span>`
                   : r.marca === "MOBILITY" ? `<span class="tag tag-mobility">MOBILITY</span>`
                   : `<span class="tag tag-otro">${escapeHtml(r.marca || "—")}</span>`;
    return `
      <tr>
        <td>${r.fecha ? r.fecha.toLocaleDateString("es-CO") : "—"}</td>
        <td>${escapeHtml(r.asesor || "—")}</td>
        <td>${marcaTag}</td>
        <td><strong>${escapeHtml(r.modelo || "—")}</strong></td>
        <td>${escapeHtml(r.color || "—")}</td>
        <td><code style="font-size:11px;color:var(--muted)">${escapeHtml(r.chasis || "—")}</code></td>
        <td>${medTag}</td>
        <td>${escapeHtml(r.financiera || "—")}</td>
        <td class="num"><strong>${fmtCOP.format(r.monto)}</strong></td>
      </tr>`;
  }).join("") || `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:20px">Sin ventas para los filtros aplicados.</td></tr>`;

  $("#pageInfo").textContent = `Página ${state.page} de ${totalPages}`;
  $("#prevPage").disabled = state.page <= 1;
  $("#nextPage").disabled = state.page >= totalPages;
}

// --- charts ---
function renderCharts() {
  const rows = state.filtered;
  Chart.defaults.color = "#9aa6cf";
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.borderColor = "rgba(154,166,207,0.1)";

  // top modelos
  const modelos = aggregate(rows, r => r.modelo, "monto");
  const top = modelos.sort((a, b) => b.value - a.value).slice(0, 10);
  upsertChart("chartModelos", {
    type: "bar",
    data: {
      labels: top.map(t => t.key || "—"),
      datasets: [{
        label: "Monto vendido",
        data: top.map(t => t.value),
        backgroundColor: "rgba(124,92,255,0.6)",
        borderColor: "#7c5cff",
        borderWidth: 1,
        borderRadius: 6,
      }]
    },
    options: barOptions(true),
  });

  // medio de pago
  const medios = aggregate(rows, r => classifyMedio(r.medio), "count");
  upsertChart("chartMedio", {
    type: "doughnut",
    data: {
      labels: medios.map(m => m.key),
      datasets: [{
        data: medios.map(m => m.value),
        backgroundColor: ["#22c55e", "#7c5cff", "#64748b", "#f59e0b"],
        borderColor: "#0b1024",
        borderWidth: 3,
      }]
    },
    options: { plugins: { legend: { position: "bottom" } }, cutout: "60%" }
  });

  // financiera (solo financiados)
  const fin = aggregate(rows.filter(r => classifyMedio(r.medio) === "Financiado"), r => r.financiera || "Sin especificar", "count")
    .sort((a, b) => b.value - a.value).slice(0, 8);
  upsertChart("chartFinanciera", {
    type: "bar",
    data: {
      labels: fin.map(f => f.key),
      datasets: [{
        label: "Ventas financiadas",
        data: fin.map(f => f.value),
        backgroundColor: "rgba(34,211,238,0.55)",
        borderColor: "#22d3ee",
        borderWidth: 1,
        borderRadius: 6,
      }]
    },
    options: {
      indexAxis: "y",
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${fmtNum.format(ctx.parsed.x)} ventas` } } },
      scales: {
        x: { grid: { color: "rgba(154,166,207,0.08)" }, ticks: { callback: v => fmtNum.format(v) } },
        y: { grid: { display: false }, ticks: { autoSkip: false } }
      }
    }
  });

  // evolución mensual
  const meses = aggregate(rows, r => r.mes, "monto").filter(m => m.key).sort((a, b) => a.key.localeCompare(b.key));
  upsertChart("chartMensual", {
    type: "line",
    data: {
      labels: meses.map(m => formatMes(m.key)),
      datasets: [{
        label: "Monto vendido",
        data: meses.map(m => m.value),
        borderColor: "#22d3ee",
        backgroundColor: (ctx) => {
          const c = ctx.chart.ctx;
          const g = c.createLinearGradient(0, 0, 0, 220);
          g.addColorStop(0, "rgba(34,211,238,0.45)");
          g.addColorStop(1, "rgba(34,211,238,0)");
          return g;
        },
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: "#22d3ee",
      }]
    },
    options: barOptions(true),
  });
}

function aggregate(rows, keyFn, mode) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, { key: k, value: 0 });
    m.get(k).value += mode === "monto" ? r.monto : 1;
  }
  return [...m.values()];
}

function barOptions(money) {
  return {
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => money ? fmtCOP.format(ctx.parsed.y ?? ctx.parsed.x) : fmtNum.format(ctx.parsed.y ?? ctx.parsed.x) } } },
    scales: {
      x: { grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } },
      y: { grid: { color: "rgba(154,166,207,0.08)" }, ticks: { callback: v => money ? abbrev(v) : fmtNum.format(v) } }
    }
  };
}

function abbrev(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n/1e9).toFixed(1) + "B";
  if (a >= 1e6) return (n/1e6).toFixed(1) + "M";
  if (a >= 1e3) return (n/1e3).toFixed(0) + "k";
  return n;
}

function formatMes(s) {
  const [y, m] = s.split("-");
  const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  return `${meses[+m - 1]} ${y.slice(2)}`;
}

function upsertChart(id, cfg) {
  if (state.charts[id]) state.charts[id].destroy();
  cfg.options = cfg.options || {};
  cfg.options.responsive = true;
  cfg.options.maintainAspectRatio = false;
  state.charts[id] = new Chart(document.getElementById(id), cfg);
}

// --- eventos ---
$("#filterAsesor").addEventListener("change", e => { state.filters.asesor = e.target.value; applyFilters(); });
$("#filterMarca").addEventListener("change", e => { state.filters.marca = e.target.value; applyFilters(); });
$("#filterMedio").addEventListener("change", e => { state.filters.medio = e.target.value; applyFilters(); });
$("#filterAnio").addEventListener("change", e => { state.filters.anio = e.target.value; applyFilters(); });
$("#filterMes").addEventListener("change", e => { state.filters.mes = e.target.value; applyFilters(); });
$("#matrizMetrica").addEventListener("change", e => { state.matrizMetrica = e.target.value; renderMatriz(); });
$("#matrizSoloActivos").addEventListener("change", e => { state.matrizSoloActivos = e.target.checked; renderMatriz(); });
$("#search").addEventListener("input", e => { state.filters.search = e.target.value; applyFilters(); });
$("#refreshBtn").addEventListener("click", loadData);
$("#asesorSort").addEventListener("change", e => { state.asesorSort = e.target.value; renderAsesores(); });
$("#asesorActivos").addEventListener("change", e => { state.soloActivos = e.target.checked; renderAsesores(); });
$("#prevPage").addEventListener("click", () => { state.page--; renderVentas(); });
$("#nextPage").addEventListener("click", () => { state.page++; renderVentas(); });

document.querySelectorAll(".nav a").forEach(a => a.addEventListener("click", () => {
  document.querySelectorAll(".nav a").forEach(x => x.classList.remove("active"));
  a.classList.add("active");
  // Cerrar el menú en celular al elegir un link
  document.body.classList.remove("menu-open");
}));

// Hamburguesa
$("#hamburger").addEventListener("click", () => document.body.classList.toggle("menu-open"));
$("#backdrop").addEventListener("click", () => document.body.classList.remove("menu-open"));
// Cerrar con tecla Escape
document.addEventListener("keydown", e => { if (e.key === "Escape") document.body.classList.remove("menu-open"); });

// ============================================================
//          LISTA DE PRECIOS (Google Sheets pestaña precios)
// ============================================================
// CSV con encabezados en la fila 2 y filas tipo MARCA (solo nombre,
// sin precios) que actúan como separador de sección. Cada modelo
// hereda la última marca vista.
const PREC_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSh3BOUXsJVvIOH_07kqNa-BgWDBGc5bP40jrJ5I320V4SxsBrbJoHTkUD7XuTQSHvNfJ-xMc6dpAEr/pub?gid=406909789&single=true&output=csv";
const MARCAS_CONOCIDAS = ["TVS", "KYMCO", "VICTORY", "CERONTE", "MOBILITY", "BENELLI", "AKT", "AUTECO", "BAJAJ", "HONDA", "YAMAHA", "SUZUKI"];

const precState = { rows: [], filtered: [], search: "", tituloHoja: "" };

function esFilaMarca(modelo, precio2026, precioContado) {
  if (!modelo) return false;
  if (precio2026 || precioContado) return false;
  // Si el texto está completamente en mayúsculas y sin precios, asumimos marca.
  if (MARCAS_CONOCIDAS.includes(modelo.toUpperCase())) return true;
  return false;
}

async function loadPrecios() {
  try {
    const url = PREC_CSV_URL + "&t=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    // Saltamos la primera fila (título) — usamos la segunda como encabezados.
    const lineas = text.split(/\r?\n/);
    if (lineas.length < 2) throw new Error("CSV de precios vacío");
    precState.tituloHoja = (lineas[0] || "").split(",")[0].trim();
    const csvSinTitulo = lineas.slice(1).join("\n");
    const parsed = Papa.parse(csvSinTitulo, { header: true, skipEmptyLines: true });

    let marcaActual = "";
    const rows = [];
    for (const raw of parsed.data) {
      const modelo = (raw["Modelo"] || "").trim();
      if (!modelo) continue;
      const precio2025 = parseMoney(raw["Precio_2025"]);
      const precio2026 = parseMoney(raw["Precio_2026"]);
      const precio2027 = parseMoney(raw["Precio_2027"]);
      const precioContado = parseMoney(raw["Precio_Contado"]);
      const transito = parseMoney(raw["Valor_Transito"]);
      const prenda = parseMoney(raw["Valor_Prenda"]);
      const cuotaInicial = parseMoney(raw["Cuota_Inicial"]);
      const bono = parseMoney(raw["Bonos"]);

      if (esFilaMarca(modelo, precio2026, precioContado)) {
        marcaActual = modelo.toUpperCase();
        continue;
      }
      // Si la fila no tiene NINGÚN precio, ignorar (es ruido de la hoja)
      if (!precio2026 && !precioContado && !precio2025 && !precio2027) continue;

      rows.push({
        marca: marcaActual,
        modelo: modelo.toUpperCase(),
        precio2025,
        precio2026,
        precio2027,
        precioContado,
        transito,
        prenda,
        cuotaInicial,
        bono,
      });
    }
    precState.rows = rows;
    renderPrecios();
    // Re-render inventario para que la columna "Precio venta" se llene con datos oficiales
    if (invState.rows.length) renderInventario();
    const info = document.getElementById("precInfo");
    if (info) {
      info.textContent = `${precState.tituloHoja || "Lista de precios"} · ${rows.length} modelos`;
    }
  } catch (e) {
    console.error("Error cargando precios:", e);
    document.querySelector("#tblPrecios tbody").innerHTML =
      `<tr><td colspan="8" style="text-align:center;color:var(--bad);padding:20px">Error al cargar precios.</td></tr>`;
  }
}

function renderPrecios() {
  const q = (precState.search || "").toLowerCase().trim();
  precState.filtered = precState.rows.filter(r =>
    !q || [r.marca, r.modelo].some(v => (v || "").toLowerCase().includes(q))
  );
  document.getElementById("precCount").textContent = fmtNum.format(precState.filtered.length);
  const tbody = document.querySelector("#tblPrecios tbody");
  if (!precState.filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:20px">Sin resultados.</td></tr>`;
    return;
  }
  // Agrupar visualmente por marca con filas separadoras
  let html = "";
  let marcaPrev = "";
  for (const r of precState.filtered) {
    if (r.marca && r.marca !== marcaPrev) {
      html += `<tr style="background:rgba(124,92,255,.08)"><td colspan="8" style="font-weight:700;letter-spacing:.04em;color:var(--accent-2);padding:10px 12px">${escapeHtml(r.marca)}</td></tr>`;
      marcaPrev = r.marca;
    }
    const marcaTag = r.marca === "TVS" ? `<span class="tag tag-tvs">TVS</span>`
                   : r.marca === "MOBILITY" ? `<span class="tag tag-mobility">MOBILITY</span>`
                   : `<span class="tag tag-otro">${escapeHtml(r.marca || "—")}</span>`;
    html += `<tr>
      <td>${marcaTag}</td>
      <td><strong>${escapeHtml(r.modelo || "—")}</strong></td>
      <td class="num">${r.precio2027 ? fmtCOP.format(r.precio2027) : "—"}</td>
      <td class="num"><strong style="color:#5be58a">${r.precioContado ? fmtCOP.format(r.precioContado) : "—"}</strong></td>
      <td class="num">${r.transito ? fmtCOP.format(r.transito) : "—"}</td>
      <td class="num">${r.prenda ? fmtCOP.format(r.prenda) : "—"}</td>
      <td class="num">${r.bono ? fmtCOP.format(r.bono) : "—"}</td>
      <td class="num">${r.cuotaInicial ? fmtCOP.format(r.cuotaInicial) : "—"}</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

const precSearchEl = document.getElementById("precSearch");
if (precSearchEl) precSearchEl.addEventListener("input", e => { precState.search = e.target.value; renderPrecios(); });

// ============================================================
//                INVENTARIO (Google Sheets pestaña inventario)
// ============================================================
// URL CSV de la pestaña de INVENTARIO del Sheets (gid=966946261).
// Trae el histórico completo de motos — el código filtra a "disponibles"
// (estado distinto de VENDIDA) antes de renderizar.
const INV_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSh3BOUXsJVvIOH_07kqNa-BgWDBGc5bP40jrJ5I320V4SxsBrbJoHTkUD7XuTQSHvNfJ-xMc6dpAEr/pub?gid=966946261&single=true&output=csv";

const invState = { rows: [], filtered: [], search: "", fuente: "—", fuenteSeleccionada: "sheets" };

// Códigos Impulsa: mapa "MODELO|COLOR|ANIO" → código Impulsa
const codigosImpulsa = { mapa: {} };

async function loadCodigosImpulsa() {
  try {
    const r = await fetch("/api/codigos-impulsa");
    const data = await r.json();
    if (data.ok) {
      codigosImpulsa.mapa = data.codigos || {};
      if (invState.rows.length) renderInventario();
    }
  } catch (e) { console.warn("loadCodigosImpulsa:", e.message); }
}

function claveCodigoImpulsa(modelo, color, anio) {
  return `${String(modelo || "").toUpperCase().trim()}|${String(color || "").toUpperCase().trim()}|${String(anio || "").trim()}`;
}

function buscarCodigoImpulsa(modelo, color, anio) {
  const exact = claveCodigoImpulsa(modelo, color, anio);
  if (codigosImpulsa.mapa[exact]) return codigosImpulsa.mapa[exact];
  // Match relajado: modelo+color (sin año) por si el año varía
  const keyMC = claveCodigoImpulsa(modelo, color, "");
  for (const k of Object.keys(codigosImpulsa.mapa)) {
    if (k.startsWith(`${String(modelo || "").toUpperCase().trim()}|${String(color || "").toUpperCase().trim()}|`)) {
      return codigosImpulsa.mapa[k];
    }
  }
  return null;
}

async function asociarCodigoImpulsa(modelo, color, anio) {
  const codigoActual = buscarCodigoImpulsa(modelo, color, anio) || "";
  const codigo = prompt(
    `Asociar código de Impulsa\n\nMoto: ${modelo}\nColor: ${color}\nAño: ${anio}\n\nPega el código exacto de Impulsa (ej: APACHE 160 FI ABS NG_GR GRA NENE_RJ_MY27):`,
    codigoActual
  );
  if (codigo === null) return; // canceló
  if (!codigo.trim()) {
    // Vacío: borrar la asociación
    try {
      await fetch("/api/codigos-impulsa", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelo, color, anio }),
      });
      delete codigosImpulsa.mapa[claveCodigoImpulsa(modelo, color, anio)];
      showToast("Código borrado");
      renderInventario();
    } catch (e) { showToast("Error: " + e.message); }
    return;
  }
  try {
    const r = await fetch("/api/codigos-impulsa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelo, color, anio, codigo: codigo.trim() }),
    });
    const data = await r.json();
    if (data.ok) {
      codigosImpulsa.mapa[data.key] = data.codigo;
      showToast("✓ Código asociado");
      renderInventario();
    } else {
      showToast("Error: " + (data.error || "no se pudo guardar"));
    }
  } catch (e) { showToast("Error: " + e.message); }
}

// Inferir marca a partir del nombre del modelo Siigo (que no la trae explícita)
function inferirMarcaPorModelo(modelo) {
  const m = String(modelo || "").toUpperCase();
  if (/RAIDER|APACHE|NTORQ|SPORT|STAR|HLX|RTX|\bRR\b|RAIDER|RADEON|JUPITER|XL|FIERO|NEO/i.test(m)) return "TVS";
  if (/KING|VICTORY|XKM|SCOOTER|MOBILITY/i.test(m)) return "MOBILITY";
  if (/AKT/i.test(m)) return "AKT";
  if (/AUTECO|KAWA|YAMAHA|SUZUKI|HONDA|BAJAJ|HERO/i.test(m)) {
    return m.match(/AUTECO|KAWA|YAMAHA|SUZUKI|HONDA|BAJAJ|HERO/)[0].toUpperCase();
  }
  return "OTRO";
}

function normalizeSiigoMoto(p) {
  const modelo = (p.nombre || "").replace(/^MOTOCICLET[A]?\s+/i, "").trim().toUpperCase();
  const stock = p.stock || 0;
  let estado;
  if (!p.activo) estado = "INACTIVA";
  else if (stock > 0) estado = "DISPONIBLE";
  else estado = "VENDIDA";
  return {
    marca: inferirMarcaPorModelo(modelo),
    modelo,
    color: (p.color || "").toUpperCase(),
    chasis: (p.chasis || "").toUpperCase(),
    motor: (p.motor || "").toUpperCase(),
    anio: p.anio || "",
    cilindraje: p.cilindraje || "",
    bodega: "—",
    costo: null,                       // Siigo /v1/products no devuelve costo
    stock,
    estado,
    codigoSiigo: p.codigo || "",
  };
}

async function loadInventario(opts = {}) {
  const warn = document.getElementById("invConfigWarn");
  const fuenteLabel = document.getElementById("invFuenteLabel");
  if (warn) warn.style.display = "none";
  if (fuenteLabel) fuenteLabel.textContent = "cargando…";
  actualizarBotonesFuente();

  const refresh = !!opts.refresh;

  // Selección del usuario: "sheets" (default) o "siigo"
  if (invState.fuenteSeleccionada === "siigo") {
    // Carga desde Siigo (puede forzar refresh) — muestra TODAS las motos
    try {
      const url = "/api/siigo/productos" + (refresh ? "?refresh=1" : "");
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      if (data.ok && Array.isArray(data.productos)) {
        // Mostrar TODAS las motos de Siigo (vendidas + disponibles)
        const todas = data.productos
          .map(normalizeSiigoMoto)
          .filter(r => r.modelo)
          .sort((a, b) => {
            // Disponibles primero, luego por modelo
            if ((b.stock > 0) !== (a.stock > 0)) return (b.stock > 0) - (a.stock > 0);
            return a.modelo.localeCompare(b.modelo);
          });
        invState.rows = todas;
        const disponibles = todas.filter(r => r.stock > 0).length;
        const vendidas = todas.length - disponibles;
        const cacheNota = data.fuente === "cache" ? " · cache" : " · recién leído";
        invState.fuente = `🧾 Siigo · ${todas.length} motos totales (${disponibles} disponibles, ${vendidas} vendidas)${cacheNota}`;
        if (fuenteLabel) fuenteLabel.textContent = invState.fuente;
        renderInventario();
        if (docState.docs && Object.keys(docState.docs).length) {
          try { renderDocs(); } catch {}
        }
        return;
      }
      throw new Error(data.error || "Siigo no devolvió productos");
    } catch (e) {
      console.error("[inventario] Siigo falló:", e.message);
      if (fuenteLabel) fuenteLabel.textContent = `🧾 Siigo · ❌ ${e.message}`;
      document.querySelector("#tblInventario tbody").innerHTML =
        `<tr><td colspan="10" style="text-align:center;color:var(--bad);padding:20px">Error al cargar Siigo: ${escapeHtml(e.message)}</td></tr>`;
      return;
    }
  }

  // Default: Google Sheets
  try {
    const url = INV_CSV_URL + (INV_CSV_URL.includes("?") ? "&" : "?") + "t=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    invState.rows = parsed.data
      .map(normalizeInvRow)
      .filter(r => r.modelo || r.marca)
      .filter(r => r.estado !== "VENDIDA");
    invState.fuente = `📊 Google Sheets · ${invState.rows.length} motos disponibles`;
    if (fuenteLabel) fuenteLabel.textContent = invState.fuente;
    renderInventario();
    if (docState.docs && Object.keys(docState.docs).length) {
      try { renderDocs(); } catch {}
    }
  } catch (e) {
    console.error("Error cargando inventario:", e);
    if (warn) warn.style.display = "block";
    document.querySelector("#tblInventario tbody").innerHTML =
      `<tr><td colspan="10" style="text-align:center;color:var(--bad);padding:20px">Error al cargar inventario.</td></tr>`;
  }
}

function actualizarBotonesFuente() {
  const btnSheets = document.getElementById("btnInvSheets");
  const btnSiigo = document.getElementById("btnInvSiigo");
  if (!btnSheets || !btnSiigo) return;
  const sel = invState.fuenteSeleccionada;
  btnSheets.style.background = sel === "sheets" ? "rgba(124,92,255,.2)" : "";
  btnSheets.style.borderColor = sel === "sheets" ? "var(--accent)" : "";
  btnSiigo.style.background = sel === "siigo" ? "rgba(34,197,94,.18)" : "";
  btnSiigo.style.borderColor = sel === "siigo" ? "#22c55e" : "";
}

function normalizeInvRow(raw) {
  // Columnas reales del Sheets de Serviautec (ojo: "Socio_Cormercial" tiene typo en la fuente).
  const estadoRaw = pick(raw, ["Inventario", "Estado", "ESTADO", "Disponible"]).toUpperCase();
  return {
    marca: pick(raw, ["Socio_Cormercial", "Socio_Comercial", "Marca", "MARCA"]).toUpperCase(),
    modelo: pick(raw, ["Modelo_Moto_Disponible", "LINEA", "Modelo", "MODELO"]).toUpperCase(),
    color: pick(raw, ["Color_Moto", "Color", "COLOR"]),
    chasis: pick(raw, ["Nro. Chasis", "Nro_Chasis", "Chasis", "VIN"]),
    motor: pick(raw, ["Nro_Motor", "Motor", "MOTOR", "Nro. Motor"]),
    anio: pick(raw, ["Anio", "Año", "AÑO", "Year"]),
    cilindraje: pick(raw, ["Cilindraje", "CC"]),
    bodega: pick(raw, ["Bodega", "BODEGA", "Almacen", "Ubicacion"]),
    costo: parseMoney(pick(raw, ["Costo_Total", "Costo_Compra", "Costo"])),  // Precio de compra (sensible)
    estado: estadoRaw || "DISPONIBLE",
  };
}

// Buscar precio de venta oficial cruzando con la Lista de Precios por modelo + año.
// Prioriza Precio_Contado (lo que paga el cliente en efectivo).
// Si no hay, usa el precio del año específico (2025/2026/2027) según `anio`.
function buscarPrecioVenta(modeloInv, anio) {
  if (!modeloInv || !precState.rows.length) return null;
  const m = String(modeloInv).toUpperCase().trim();

  function precioDe(row) {
    if (!row) return null;
    if (row.precioContado) return row.precioContado;
    // Por año específico
    if (anio === "2025" && row.precio2025) return row.precio2025;
    if (anio === "2026" && row.precio2026) return row.precio2026;
    if (anio === "2027" && row.precio2027) return row.precio2027;
    // Fallback: cualquier precio disponible (priorizar el más nuevo)
    return row.precio2027 || row.precio2025 || null;
  }

  // Match exacto
  let p = precState.rows.find(r => r.modelo === m);
  if (p) return precioDe(p);
  // Match: cualquiera contiene al otro
  p = precState.rows.find(r => r.modelo.includes(m) || m.includes(r.modelo));
  if (p) return precioDe(p);
  // Match por tokens significativos (3+ chars)
  const tokensInv = m.split(/\s+/).filter(t => t.length >= 3);
  if (tokensInv.length >= 2) {
    p = precState.rows.find(r => {
      const tp = r.modelo.split(/\s+/);
      return tokensInv.filter(t => tp.some(x => x === t)).length >= 2;
    });
    if (p) return precioDe(p);
  }
  return null;
}

function renderInventario() {
  const q = (invState.search || "").toLowerCase().trim();
  invState.filtered = invState.rows.filter(r =>
    !q || [r.marca, r.modelo, r.color, r.bodega, r.estado, r.chasis, r.motor, r.anio, r.cilindraje]
      .some(v => (v || "").toString().toLowerCase().includes(q))
  );
  document.getElementById("invCount").textContent = fmtNum.format(invState.filtered.length);
  const tbody = document.querySelector("#tblInventario tbody");
  tbody.innerHTML = invState.filtered.slice(0, 200).map(r => {
    const marcaTag = r.marca === "TVS" ? `<span class="tag tag-tvs">TVS</span>`
                   : r.marca === "MOBILITY" ? `<span class="tag tag-mobility">MOBILITY</span>`
                   : `<span class="tag tag-otro">${escapeHtml(r.marca || "—")}</span>`;
    const precioVenta = buscarPrecioVenta(r.modelo, r.anio);
    const estadoUp = String(r.estado || "").toUpperCase();
    const esVendida = estadoUp === "VENDIDA" || (typeof r.stock === "number" && r.stock <= 0 && r.estado !== "DISPONIBLE");
    const estadoTag = esVendida
      ? `<span class="tag" style="background:rgba(120,120,140,.2);color:#999;border:1px solid rgba(120,120,140,.3)">VENDIDA</span>`
      : estadoUp === "DISPONIBLE"
        ? `<span class="tag tag-contado">DISPONIBLE</span>`
        : `<span class="tag">${escapeHtml(r.estado || "—")}</span>`;
    const rowStyle = esVendida ? ' style="opacity:.55"' : "";
    // Código Impulsa
    const cod = buscarCodigoImpulsa(r.modelo, r.color, r.anio);
    const codigoCell = cod
      ? `<code style="font-size:10.5px;color:#5be58a;background:rgba(91,229,138,.08);padding:2px 6px;border-radius:4px;display:inline-block;max-width:160px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle">${escapeHtml(cod)}</code>
         <button class="btn-mini" data-copiar-codigo="${escapeHtml(cod)}" title="Copiar código" style="margin-left:4px">📋</button>
         <button class="btn-mini" data-editar-codigo data-modelo="${escapeHtml(r.modelo || '')}" data-color="${escapeHtml(r.color || '')}" data-anio="${escapeHtml(r.anio || '')}" title="Editar" style="margin-left:2px">✏️</button>`
      : `<button class="btn-mini" data-asociar-codigo data-modelo="${escapeHtml(r.modelo || '')}" data-color="${escapeHtml(r.color || '')}" data-anio="${escapeHtml(r.anio || '')}" title="Asociar código Impulsa" style="background:rgba(247,194,114,.15);border-color:rgba(247,194,114,.4);color:#f7c272">+ Asociar</button>`;
    return `<tr${rowStyle}>
      <td>${marcaTag}</td>
      <td><strong>${escapeHtml(r.modelo || "—")}</strong></td>
      <td>${escapeHtml(r.anio || "—")}</td>
      <td>${escapeHtml(r.color || "—")}</td>
      <td><code style="font-size:11px;color:var(--muted)">${escapeHtml(r.chasis || "—")}</code></td>
      <td><code style="font-size:11px;color:var(--muted)">${escapeHtml(r.motor || "—")}</code></td>
      <td>${escapeHtml(r.cilindraje || "—")}</td>
      <td class="num" data-role-only="admin contable dueno">${r.costo ? fmtCOP.format(r.costo) : "—"}</td>
      <td class="num"><strong style="color:#5be58a">${precioVenta ? fmtCOP.format(precioVenta) : "—"}</strong></td>
      <td>${codigoCell}</td>
      <td>${estadoTag}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:20px">Sin resultados.</td></tr>`;
  if (invState.filtered.length > 200) {
    tbody.innerHTML += `<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:10px;font-style:italic">Mostrando primeras 200 de ${invState.filtered.length} filas — refina la búsqueda</td></tr>`;
  }

  // Listeners de los botones de código Impulsa
  tbody.querySelectorAll("[data-copiar-codigo]").forEach(b => {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copiarCodigo);
        showToast(`📋 Copiado: ${b.dataset.copiarCodigo}`);
      } catch { showToast("No se pudo copiar"); }
    });
  });
  tbody.querySelectorAll("[data-asociar-codigo], [data-editar-codigo]").forEach(b => {
    b.addEventListener("click", () => {
      asociarCodigoImpulsa(b.dataset.modelo, b.dataset.color, b.dataset.anio);
    });
  });
}

const invSearchEl = document.getElementById("invSearch");
if (invSearchEl) invSearchEl.addEventListener("input", e => { invState.search = e.target.value; renderInventario(); });

// Toggle Sheets / Siigo
document.getElementById("btnInvSheets")?.addEventListener("click", () => {
  if (invState.fuenteSeleccionada === "sheets") return;
  invState.fuenteSeleccionada = "sheets";
  loadInventario();
});
document.getElementById("btnInvSiigo")?.addEventListener("click", () => {
  if (invState.fuenteSeleccionada === "siigo") return;
  invState.fuenteSeleccionada = "siigo";
  loadInventario();
});
document.getElementById("btnInvRefresh")?.addEventListener("click", () => {
  loadInventario({ refresh: true });
  showToast("↻ Refrescando inventario…");
});

// ============================================================
//             FORMULARIO REGISTRAR VENTA → IMPULSA
// ============================================================
async function refreshHealth() {
  try {
    const r = await fetch("/api/health");
    if (!r.ok) return;
    const h = await r.json();
    const badge = document.getElementById("envBadge");
    if (!badge) return;
    badge.textContent = h.ambiente === "prod" ? "PRODUCCIÓN" : "PRUEBAS";
    badge.classList.remove("env-test", "env-prod");
    badge.classList.add(h.ambiente === "prod" ? "env-prod" : "env-test");
    if (!h.apiKeyConfigurada) {
      badge.textContent = "SIN API KEY";
      badge.classList.add("env-prod");
    }
  } catch {
    // Backend no está disponible (probablemente abrieron el HTML directo en vez de http://localhost:3000)
    const badge = document.getElementById("envBadge");
    if (badge) { badge.textContent = "Backend offline"; badge.classList.add("env-prod"); }
  }
}

function showFormMsg(html, kind) {
  const box = document.getElementById("formMsg");
  if (!box) return;
  box.innerHTML = html;
  box.className = "form-msg " + (kind === "ok" ? "form-msg-ok" : kind === "err" ? "form-msg-err" : "form-msg-info");
  box.style.display = "block";
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Mostrar/ocultar campo Financiera según forma de pago
const formaPagoSel = document.getElementById("formaPagoSel");
const financieraField = document.getElementById("financieraField");
if (formaPagoSel && financieraField) {
  const toggleFinanciera = () => {
    financieraField.style.display = formaPagoSel.value === "Crédito" ? "" : "none";
  };
  formaPagoSel.addEventListener("change", toggleFinanciera);
  toggleFinanciera();
}

// Auto-formato de campos monetarios: escribe "10999999" y se ve "10.999.999"
// Formato manual con punto cada 3 dígitos (independiente del locale del navegador).
function desformatearMonto(valor) {
  return String(valor || "").replace(/[^0-9]/g, "");
}
function formatearMonto(valor) {
  const limpio = desformatearMonto(valor);
  if (!limpio) return "";
  // Insertar punto cada 3 dígitos desde la derecha
  return limpio.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
document.querySelectorAll("[data-format-money]").forEach(inp => {
  inp.addEventListener("input", () => {
    const sinFormato = desformatearMonto(inp.value);
    const formateado = formatearMonto(sinFormato);
    if (inp.value !== formateado) {
      inp.value = formateado;
      try { inp.setSelectionRange(formateado.length, formateado.length); } catch {}
    }
  });
  // Al perder foco, asegurar formato correcto
  inp.addEventListener("blur", () => {
    inp.value = formatearMonto(inp.value);
  });
});

const formEl = document.getElementById("formRegistrar");
if (formEl) {
  formEl.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById("btnSubmit");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Enviando…";
    showFormMsg("Enviando a Impulsa CRM…", "info");

    const fd = new FormData(formEl);
    const body = Object.fromEntries(fd.entries());
    body.HabeasData = fd.get("HabeasData") === "on";
    // Quitar puntos/comas de los montos antes de enviar
    body.PrecioMoto = desformatearMonto(body.PrecioMoto);
    body.ValorPapeles = desformatearMonto(body.ValorPapeles);

    try {
      const r = await fetch("/api/registrar-venta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data.ok && data.impulsa && data.impulsa.Exitoso !== false) {
        showFormMsg(
          `✅ <strong>Venta registrada y oportunidad creada en Impulsa</strong> (ambiente: ${data.ambiente || "?"}).<br>
           Cliente: <strong>${escapeHtml(body.NombreContacto || "")}</strong> — Moto: <strong>${escapeHtml((body.Marca || "") + " " + (body.Producto || ""))}</strong>.<br>
           Verifica la oportunidad en Impulsa CRM > Búsqueda oportunidades.`,
          "ok"
        );
        formEl.reset();
      } else {
        const errMsg = data.error || (data.impulsa && (data.impulsa.Error || JSON.stringify(data.impulsa))) || "Error desconocido";
        showFormMsg(
          `❌ <strong>No se pudo crear la oportunidad.</strong><br>${escapeHtml(String(errMsg))}
           <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`,
          "err"
        );
      }
    } catch (e) {
      showFormMsg(
        `❌ <strong>Error de conexión:</strong> ${escapeHtml(e.message)}<br>
         ¿El servidor local está corriendo? Asegúrate de haber abierto el dashboard vía <code>http://localhost:3000</code> y NO abriendo el .html directo.`,
        "err"
      );
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // ============================================================
  //   AUTO-FILL: si la cédula o nombre ya existe → traer datos
  // ============================================================
  function buscarClienteExistente() {
    const cedula = String(formEl.querySelector('[name="Documento"]')?.value || "").replace(/[^0-9]/g, "");
    const nombre = String(formEl.querySelector('[name="NombreContacto"]')?.value || "").toUpperCase().trim();

    // Buscar primero por cédula exacta
    let lead = null;
    let preasig = null;
    if (cedula.length >= 5) {
      lead = leadsState.leads.find(l => String(l.documento || "").replace(/[^0-9]/g, "") === cedula);
      preasig = Object.values(preasigState.preasignaciones || {}).find(p =>
        String(p.cedulaCliente || "").replace(/[^0-9]/g, "") === cedula);
    }
    // Si no encontró por cédula y hay nombre, buscar por nombre
    if (!lead && !preasig && nombre.length >= 4) {
      lead = leadsState.leads.find(l => (l.cliente || "").toUpperCase() === nombre)
          || leadsState.leads.find(l => (l.cliente || "").toUpperCase().includes(nombre));
    }
    if (!lead && !preasig) return;

    // Llenar campos vacíos (no sobrescribir lo que el asesor ya escribió)
    const setIfEmpty = (selector, valor) => {
      const inp = formEl.querySelector(selector);
      if (inp && valor && !inp.value) inp.value = valor;
    };
    setIfEmpty('[name="NombreContacto"]', lead?.cliente || preasig?.nombreCliente);
    setIfEmpty('[name="Documento"]', lead?.documento || preasig?.cedulaCliente);
    setIfEmpty('[name="Telefono2"]', lead?.celular || preasig?.celular);
    setIfEmpty('[name="Email"]', lead?.email);
    setIfEmpty('[name="Direccion"]', lead?.direccion);
    if (lead?.marca) setIfEmpty('[name="Marca"]', lead.marca);
    if (lead?.modelo) setIfEmpty('[name="Producto"]', lead.modelo);

    showFormMsg(
      `✓ Cliente <strong>${escapeHtml(lead?.cliente || preasig?.nombreCliente || "")}</strong> encontrado en el sistema. Datos prellenados.`,
      "info"
    );
  }

  // Listener en cédula (al perder foco o cambiar)
  const cedulaInp = formEl.querySelector('[name="Documento"]');
  if (cedulaInp) {
    cedulaInp.addEventListener("change", buscarClienteExistente);
    cedulaInp.addEventListener("blur", buscarClienteExistente);
  }
  // Listener en nombre
  const nombreInp = formEl.querySelector('[name="NombreContacto"]');
  if (nombreInp) {
    nombreInp.addEventListener("change", buscarClienteExistente);
    nombreInp.addEventListener("blur", buscarClienteExistente);
    // Datalist con clientes existentes
    let dl = document.getElementById("clientesExistentesList");
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = "clientesExistentesList";
      formEl.appendChild(dl);
    }
    nombreInp.setAttribute("list", "clientesExistentesList");
    // Re-poblar el datalist cada vez que enfoca el campo
    nombreInp.addEventListener("focus", () => {
      const vistos = new Set();
      const opts = [];
      for (const l of leadsState.leads) {
        const key = (l.cliente || "").toUpperCase().trim();
        if (!key || vistos.has(key)) continue;
        vistos.add(key);
        const det = [l.documento ? "CC " + l.documento : "", l.celular].filter(Boolean).join(" · ");
        opts.push(`<option value="${escapeHtml(l.cliente)}">${escapeHtml(det)}</option>`);
      }
      dl.innerHTML = opts.join("");
    });
  }
}

// ============================================================
//          MIS REGISTROS DEL MES — leads ingresados
// ============================================================
const leadsState = { leads: [], filtroMes: "", buscar: "", soloMios: false };

async function loadLeads() {
  try {
    const r = await fetch("/api/leads/lista");
    if (!r.ok) return;
    const data = await r.json();
    if (data.ok) {
      leadsState.leads = data.leads || [];
      populateLeadsMesFilter();
      renderLeads();
      // Re-render Orden Facturación si ya tiene docs cargados: ahora puede cruzar cliente+asesor
      if (docState.docs && Object.keys(docState.docs).length) {
        try { renderDocs(); } catch {}
        try { renderSoatPendientes(); } catch {}
      }
    }
  } catch (e) { console.error("Error loadLeads:", e); }
}

function populateLeadsMesFilter() {
  const sel = document.getElementById("leadsFiltroMes");
  if (!sel) return;
  const meses = new Set();
  for (const l of leadsState.leads) {
    if (l.ts) {
      const d = new Date(l.ts);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      meses.add(m);
    }
  }
  const mesesList = [...meses].sort().reverse();
  const meses_es = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  sel.innerHTML = `<option value="">Todos los meses</option>` +
    mesesList.map(m => {
      const [y, mo] = m.split("-");
      return `<option value="${m}">${meses_es[+mo - 1]} ${y}</option>`;
    }).join("");
}

function renderLeads() {
  const tbody = document.querySelector("#tblLeads tbody");
  if (!tbody) return;
  const q = (leadsState.buscar || "").toLowerCase().trim();
  const filtroMes = leadsState.filtroMes;
  const miEmail = (currentUser?.email || "").toLowerCase();
  const filtrados = leadsState.leads.filter(l => {
    // Filtro "solo mis registros" (toggle): solo aplica si el usuario es admin/contable/dueno
    // y tiene el toggle activado. Asesor siempre ve solo los suyos por el backend.
    if (leadsState.soloMios && miEmail && (l.usuario || "").toLowerCase() !== miEmail) return false;
    if (filtroMes && l.ts) {
      const d = new Date(l.ts);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (m !== filtroMes) return false;
    }
    if (q) {
      return [l.cliente, l.documento, l.celular, l.modelo, l.marca, l.email, l.usuarioNombre].some(v => (v || "").toLowerCase().includes(q));
    }
    return true;
  });
  document.getElementById("leadsCount").textContent = fmtNum.format(filtrados.length);

  if (filtrados.length === 0) {
    const colspan = currentUser?.rol === "admin" || currentUser?.rol === "contable" ? 10 : 9;
    tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;color:var(--muted);padding:20px">Sin registros en este filtro.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtrados.map(l => {
    const fecha = l.ts ? new Date(l.ts).toLocaleDateString("es-CO") + " " + new Date(l.ts).toLocaleTimeString("es-CO", {hour:"2-digit",minute:"2-digit"}) : "—";
    const moto = `${l.marca || ""} ${l.modelo || ""}`.trim() || "—";
    // Extraer info de pago de las observaciones (formato "Pago: CONTADO | Precio moto: $X | ...")
    const obs = l.observaciones || "";
    const pago = obs.match(/Pago:\s*([^|]+)/i)?.[1].trim() || "—";
    const total = obs.match(/Total:\s*\$?([\d.,]+)/i)?.[1] || "";
    let estado;
    if (l.enviadoAImpulsa && l.statusImpulsa >= 200 && l.statusImpulsa < 300) {
      estado = `<span class="tag tag-contado">✓ Enviado · #${l.idImpulsa || "?"}</span>`;
    } else if (l.enviadoAImpulsa === false) {
      estado = `<span class="tag tag-otro">⏳ No enviado</span>`;
    } else {
      estado = `<span class="tag" style="background:rgba(239,68,68,.12);color:#fca5a5;border:1px solid rgba(239,68,68,.35)">✗ Error ${l.statusImpulsa || ""}</span>`;
    }
    const showAsesor = currentUser?.rol === "admin" || currentUser?.rol === "contable";
    // Modo pruebas: cualquier usuario autenticado puede borrar
    const puedeBorrar = true;
    return `<tr>
      <td>${fecha}</td>
      <td><strong>${escapeHtml(l.cliente)}</strong></td>
      <td><code style="font-size:11px;color:var(--muted)">${escapeHtml((l.tipoDocumento ? l.tipoDocumento + " " : "") + l.documento)}</code></td>
      <td>${escapeHtml(l.celular)}</td>
      <td>${escapeHtml(moto)}</td>
      <td>${escapeHtml(pago)}</td>
      <td class="num">${total ? "$" + escapeHtml(total) : "—"}</td>
      ${showAsesor ? `<td>${escapeHtml(l.usuarioNombre || l.usuario)}</td>` : ""}
      <td>${estado}</td>
      <td style="text-align:center;white-space:nowrap">
        <button class="btn-ver-lead" data-ver-ts="${escapeHtml(l.ts)}" title="Ver toda la info">📋 Ver</button>
        ${puedeBorrar ? ` <button class="btn-borrar-lead" data-borrar-ts="${escapeHtml(l.ts)}" title="Borrar este registro">🗑️</button>` : ""}
      </td>
    </tr>`;
  }).join("");

  // Listeners "Ver completo"
  document.querySelectorAll(".btn-ver-lead").forEach(b => {
    b.addEventListener("click", () => abrirDetalleLead(b.dataset.verTs));
  });

  // Listeners de borrar
  document.querySelectorAll(".btn-borrar-lead").forEach(b => {
    b.addEventListener("click", async () => {
      const ts = b.dataset.borrarTs;
      const fila = b.closest("tr");
      const nombre = fila?.querySelector("strong")?.textContent || "este registro";
      if (!confirm(`¿Borrar el registro de "${nombre}"? Esta acción no se puede deshacer.`)) return;
      try {
        const r = await fetch(`/api/leads/${encodeURIComponent(ts)}`, { method: "DELETE" });
        const data = await r.json();
        if (data.ok) {
          showToast(`Registro borrado (${data.borrados})`);
          loadLeads();
        } else {
          showToast("Error: " + (data.error || "no se pudo borrar"));
        }
      } catch (e) { showToast("Error: " + e.message); }
    });
  });
}

// Abrir modal con detalle COMPLETO de un lead (cruzado con preasignación)
function celda(label, valor) {
  const v = valor && String(valor).trim();
  return `<div><span class="lab">${escapeHtml(label)}</span><span class="val ${v ? '' : 'vacio'}">${v ? escapeHtml(v) : "— sin dato"}</span></div>`;
}

function abrirDetalleLead(ts) {
  const lead = leadsState.leads.find(l => l.ts === ts);
  if (!lead) return;

  const fecha = lead.ts ? new Date(lead.ts).toLocaleString("es-CO") : "—";
  document.getElementById("leadTitulo").textContent = lead.cliente || "(sin nombre)";
  document.getElementById("leadSubtitulo").innerHTML =
    `<code style="color:var(--accent-2)">${escapeHtml(lead.tipoDocumento || "")} ${escapeHtml(lead.documento || "")}</code> · ${escapeHtml(lead.celular || "")} · Registrado el ${fecha}`;

  document.getElementById("leadAvisoSinPreasig").style.display = lead.tienePreasignacion ? "none" : "block";

  document.getElementById("leadDatosCliente").innerHTML = `
    ${celda("Nombre completo", lead.cliente)}
    ${celda("Tipo documento", lead.tipoDocumento)}
    ${celda("Número documento", lead.documento)}
    ${celda("Celular", lead.celular)}
    ${celda("Correo electrónico", lead.email)}
    ${celda("Dirección", lead.direccion)}
    ${celda("Fecha de nacimiento", lead.fechaNacimiento)}
  `;

  document.getElementById("leadDatosMoto").innerHTML = `
    ${celda("Marca", lead.marca)}
    ${celda("Modelo", lead.modelo)}
    ${celda("Color", lead.color)}
    ${celda("Chasis (VIN)", lead.chasis)}
    ${celda("Motor", lead.motor)}
    ${celda("Placa", lead.placa)}
    ${celda("GPS", ({sin:"Sin GPS",instalar:"Instalar",activar:"Activar"})[lead.gps] || "—")}
    ${celda("Estado preasignación", lead.estadoPreasignacion)}
  `;

  // Extraer datos de pago de las observaciones (formato "Pago: CONTADO | Precio moto: ... | Papeles: ... | Total: ...")
  const obs = lead.observaciones || "";
  const formaPago = obs.match(/Pago:\s*([^|]+)/i)?.[1].trim() || "";
  const precioMoto = obs.match(/Precio moto:\s*\$?([\d.,]+)/i)?.[1] || "";
  const papeles = obs.match(/Papeles:\s*\$?([\d.,]+)/i)?.[1] || "";
  const total = obs.match(/Total:\s*\$?([\d.,]+)/i)?.[1] || "";

  document.getElementById("leadDatosCredito").innerHTML = `
    ${celda("Forma de pago", formaPago)}
    ${celda("Financiera", lead.financiera)}
    ${celda("# Crédito", lead.numCredito)}
    ${celda("Precio moto", precioMoto ? "$" + precioMoto : "")}
    ${celda("Valor papeles", papeles ? "$" + papeles : "")}
    ${celda("Total", total ? "$" + total : "")}
  `;

  let estadoImpulsa;
  if (lead.enviadoAImpulsa && lead.statusImpulsa >= 200 && lead.statusImpulsa < 300) {
    estadoImpulsa = `✓ Enviado · oportunidad #${lead.idImpulsa || "?"}`;
  } else if (lead.statusImpulsa) {
    estadoImpulsa = `✗ Error ${lead.statusImpulsa}`;
  } else {
    estadoImpulsa = "No enviado";
  }

  document.getElementById("leadDatosRegistro").innerHTML = `
    ${celda("Origen del lead", lead.origen)}
    ${celda("Campaña", lead.campanna)}
    ${celda("Asesor que registró", lead.usuarioNombre || lead.usuario)}
    ${celda("Fecha de registro", fecha)}
    ${celda("Estado en Impulsa", estadoImpulsa)}
    ${celda("ID Impulsa", lead.idImpulsa)}
  `;

  document.getElementById("modalDetalleLead").classList.add("show");
}

document.getElementById("btnCerrarLead")?.addEventListener("click", () => document.getElementById("modalDetalleLead").classList.remove("show"));
document.getElementById("btnCerrarLead2")?.addEventListener("click", () => document.getElementById("modalDetalleLead").classList.remove("show"));

// Copiar todo el detalle al portapapeles (útil para WhatsApp o pasar a contabilidad)
document.getElementById("btnCopiarLead")?.addEventListener("click", () => {
  const titulo = document.getElementById("leadTitulo").textContent;
  const subt = document.getElementById("leadSubtitulo").textContent;
  const secciones = ["leadDatosCliente", "leadDatosMoto", "leadDatosCredito", "leadDatosRegistro"];
  const lines = [titulo, subt, ""];
  for (const id of secciones) {
    const h3 = document.querySelector(`h3[style*="accent-2"] + .lead-grid[id="${id}"]`)?.previousElementSibling?.textContent
            || document.querySelector(`#${id}`)?.previousElementSibling?.textContent;
    if (h3) lines.push("=== " + h3 + " ===");
    document.getElementById(id).querySelectorAll("div").forEach(d => {
      const lab = d.querySelector(".lab")?.textContent;
      const val = d.querySelector(".val")?.textContent;
      if (lab && val) lines.push(lab + ": " + val);
    });
    lines.push("");
  }
  const texto = lines.join("\n");
  navigator.clipboard.writeText(texto).then(() => showToast("✓ Copiado al portapapeles"));
});

const leadsBuscarEl = document.getElementById("leadsBuscar");
if (leadsBuscarEl) leadsBuscarEl.addEventListener("input", e => { leadsState.buscar = e.target.value; renderLeads(); });
const leadsFiltroMesEl = document.getElementById("leadsFiltroMes");
if (leadsFiltroMesEl) leadsFiltroMesEl.addEventListener("change", e => { leadsState.filtroMes = e.target.value; renderLeads(); });
const leadsSoloMiosEl = document.getElementById("leadsSoloMios");
if (leadsSoloMiosEl) leadsSoloMiosEl.addEventListener("change", e => { leadsState.soloMios = e.target.checked; renderLeads(); });

// ============================================================
//          PREASIGNACIÓN — chasis → cliente + crédito
// ============================================================
const preasigState = { preasignaciones: {}, verTodos: false };

async function loadPreasignaciones() {
  try {
    const url = "/api/preasignaciones/lista" + (preasigState.verTodos ? "?todos=1" : "");
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    if (data.ok) {
      preasigState.preasignaciones = data.preasignaciones || {};
      renderPreasignaciones();
      renderTaller();  // taller depende de preasignaciones
      try { renderGpsLista("instalar"); } catch {}
      try { renderGpsLista("activar"); } catch {}
      // Re-render Orden Facturación + SOAT: cruza info de preasignaciones
      if (docState.docs && Object.keys(docState.docs).length) {
        try { renderDocs(); } catch {}
        try { renderSoatPendientes(); } catch {}
      }
    }
  } catch (e) { console.error("Error loadPreasignaciones:", e); }
}

function renderPreasignaciones() {
  const wrap = document.getElementById("preasigListWrap");
  if (!wrap) return;
  const entradas = Object.entries(preasigState.preasignaciones)
    .filter(([_, p]) => p.estado !== "entregada")
    .sort((a, b) => (b[1].actualizadoEn || "").localeCompare(a[1].actualizadoEn || ""));
  document.getElementById("preasigCount").textContent = fmtNum.format(entradas.length);

  if (entradas.length === 0) {
    wrap.innerHTML = `<div style="text-align:center;color:var(--muted);padding:30px;border:1px dashed var(--line);border-radius:12px">
      Sin preasignaciones todavía. Usa el botón <strong>"+ Nueva preasignación"</strong> para empezar.
    </div>`;
    return;
  }

  wrap.innerHTML = entradas.map(([id, p]) => {
    const gpsLabel = { sin: "Sin GPS", instalar: "Instalar GPS", activar: "Activar GPS" }[p.gps] || "Sin GPS";
    const estadoLabel = { preasignada: "Preasignada", en_taller: "En taller", entregada: "Entregada" }[p.estado] || p.estado;
    const estadoColor = p.estado === "preasignada" ? "vacio" : p.estado === "en_taller" ? "parcial" : "";
    return `<div class="docs-venta-card">
      <div class="docs-venta-head">
        <div>
          <h3>${escapeHtml(p.nombreCliente || "(sin cliente)")} <code>${escapeHtml(id)}</code></h3>
          <div class="docs-venta-sub">
            ${escapeHtml(p.marca || "")} ${escapeHtml(p.modelo || "")} · ${escapeHtml(p.color || "")} · Motor ${escapeHtml(p.motor || "—")}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <span class="docs-progress ${estadoColor}">${estadoLabel}</span>
          <button class="btn-primary" data-preasig-subirdocs="${escapeHtml(id)}" data-cliente="${escapeHtml(p.nombreCliente || '')}" data-modelo="${escapeHtml((p.marca || '') + ' ' + (p.modelo || ''))}" style="padding:5px 10px;font-size:11px;border:none">📑 Subir docs</button>
          ${p.estado === "preasignada" ? `<button class="btn-secondary" data-preasig-taller="${escapeHtml(id)}" style="padding:5px 10px;font-size:11px">→ A taller</button>` : ""}
          <button class="btn-secondary" data-preasig-edit="${escapeHtml(id)}" style="padding:5px 10px;font-size:11px">Editar</button>
          <button class="btn-secondary" data-preasig-borrar="${escapeHtml(id)}" style="padding:5px 10px;font-size:11px;color:#fca5a5">Borrar</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:11.5px;color:var(--text-soft)">
        <div><span class="muted">Cédula:</span> ${escapeHtml(p.cedulaCliente || "—")}</div>
        <div><span class="muted">F. nacimiento:</span> ${escapeHtml(p.fechaNacimiento || "—")}</div>
        <div><span class="muted">Celular:</span> ${escapeHtml(p.celular || "—")}</div>
        <div><span class="muted">Placa:</span> ${escapeHtml(p.placa || "—")}</div>
        <div><span class="muted"># Crédito:</span> ${escapeHtml(p.numCredito || "—")}</div>
        <div><span class="muted">Financiera:</span> ${escapeHtml(p.financiera || "—")}</div>
        <div><span class="muted">GPS:</span> ${gpsLabel}</div>
        <div><span class="muted">Asesor:</span> ${escapeHtml(p.asesorNombre || p.asesorEmail)}</div>
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-preasig-edit]").forEach(b => b.addEventListener("click", () => abrirPreasigModal(b.dataset.preasigEdit)));
  wrap.querySelectorAll("[data-preasig-borrar]").forEach(b => b.addEventListener("click", () => borrarPreasig(b.dataset.preasigBorrar)));
  wrap.querySelectorAll("[data-preasig-taller]").forEach(b => b.addEventListener("click", () => cambiarEstadoPreasig(b.dataset.preasigTaller, "en_taller")));
  wrap.querySelectorAll("[data-preasig-subirdocs]").forEach(b => b.addEventListener("click", () => {
    const id = b.dataset.preasigSubirdocs;
    const cliente = b.dataset.cliente;
    const modelo = b.dataset.modelo;
    // Crear placeholder en docState si no existe y saltar al área de docs
    if (!docState.docs[id]) docState.docs[id] = { cliente, modelo, archivos: {} };
    renderDocs();
    document.getElementById("ordenfac")?.scrollIntoView({ behavior: "smooth", block: "start" });
    showToast(`Lista para subir documentos de ${cliente || id}`);
  }));
}

async function cambiarEstadoPreasig(chasis, estado) {
  try {
    const r = await fetch(`/api/preasignaciones/${encodeURIComponent(chasis)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado }),
    });
    const data = await r.json();
    if (data.ok) { showToast(`Estado: ${estado}`); loadPreasignaciones(); }
    else showToast("Error: " + data.error);
  } catch (e) { showToast("Error: " + e.message); }
}

async function borrarPreasig(chasis) {
  if (!confirm(`¿Borrar la preasignación del chasis ${chasis}?`)) return;
  try {
    const r = await fetch(`/api/preasignaciones/${encodeURIComponent(chasis)}`, { method: "DELETE" });
    const data = await r.json();
    if (data.ok) { showToast("Preasignación borrada"); loadPreasignaciones(); }
    else showToast("Error: " + data.error);
  } catch (e) { showToast("Error: " + e.message); }
}

function abrirPreasigModal(chasisExistente) {
  const modal = document.getElementById("modalPreasig");
  const f = document.getElementById("formPreasig");
  f.reset();
  document.getElementById("preasigMsg").className = "modal-msg";
  document.getElementById("modalPreasigTitle").textContent = chasisExistente ? "Editar preasignación" : "Nueva preasignación";

  // Llenar el datalist de chasis disponibles desde el inventario
  const dl = document.getElementById("chasisList");
  dl.innerHTML = (invState.rows || [])
    .filter(r => r.chasis)
    .slice(0, 200)
    .map(r => `<option value="${escapeHtml(r.chasis)}">${escapeHtml(r.marca)} ${escapeHtml(r.modelo)} · ${escapeHtml(r.color)}</option>`)
    .join("");

  // Llenar el datalist de clientes desde leads existentes
  const dlClientes = document.getElementById("clientesLeadsList");
  if (dlClientes) {
    // Quitar duplicados por nombre
    const vistos = new Set();
    const opciones = [];
    for (const l of leadsState.leads) {
      const key = (l.cliente || "").toUpperCase().trim();
      if (!key || vistos.has(key)) continue;
      vistos.add(key);
      const detalles = [
        l.documento ? "CC " + l.documento : "",
        l.modelo ? l.modelo : "",
        l.celular ? l.celular : "",
      ].filter(Boolean).join(" · ");
      opciones.push(`<option value="${escapeHtml(l.cliente)}">${escapeHtml(detalles)}</option>`);
    }
    dlClientes.innerHTML = opciones.join("");
  }

  if (chasisExistente && preasigState.preasignaciones[chasisExistente]) {
    const p = preasigState.preasignaciones[chasisExistente];
    for (const [k, v] of Object.entries(p)) {
      const inp = f.querySelector(`[name="${k}"]`);
      if (inp) inp.value = v;
    }
    f.querySelector('[name="chasis"]').readOnly = true;
  } else {
    f.querySelector('[name="chasis"]').readOnly = false;
  }
  modal.classList.add("show");
}

// Auto-completar marca/modelo/motor/color al pegar chasis
// Busca primero en el inventario local (rápido); si no, en Siigo (más completo)
function attachChasisAutocomplete() {
  const f = document.getElementById("formPreasig");
  const chasisInp = f?.querySelector('[name="chasis"]');
  if (!chasisInp) return;

  let timer = null;
  async function buscarYRellenar() {
    const c = chasisInp.value.trim().toUpperCase();
    if (c.length < 3) return;

    // Helper para llenar campos
    function llenar(m, fuente) {
      if (!f.querySelector('[name="marca"]').value) f.querySelector('[name="marca"]').value = m.marca || "";
      if (!f.querySelector('[name="modelo"]').value) f.querySelector('[name="modelo"]').value = m.modelo || "";
      if (!f.querySelector('[name="color"]').value) f.querySelector('[name="color"]').value = m.color || "";
      if (m.motor && !f.querySelector('[name="motor"]').value) f.querySelector('[name="motor"]').value = m.motor;
      // Reemplazar el chasis parcial por el COMPLETO
      if (m.chasis && m.chasis !== c) chasisInp.value = m.chasis;
      mostrarMsgAutofill(`✓ Datos prellenados desde ${fuente} · ${m.modelo} ${m.color || ""}${m.stock === 0 ? " · ⚠️ VENDIDA (stock 0)" : ""}`, "ok");
    }

    // 1) Inventario local primero — match exacto o parcial
    let motosLocal = (invState.rows || []).filter(r => (r.chasis || "").includes(c));
    if (motosLocal.length === 1) {
      llenar(motosLocal[0], "inventario");
      return;
    }
    if (motosLocal.length > 1 && motosLocal.length <= 20) {
      mostrarOpcionesEnDatalist(motosLocal);
      mostrarMsgAutofill(`📋 ${motosLocal.length} coincidencias — abre el menú o escribe más caracteres`, "info");
      return;
    }

    // 2) Buscar en Siigo (búsqueda parcial)
    mostrarMsgAutofill("🔎 Buscando en Siigo…", "");
    try {
      const r = await fetch(`/api/siigo/buscar/${encodeURIComponent(c)}`);
      const data = await r.json();
      if (!data.ok || !data.encontrado) {
        mostrarMsgAutofill("⚠️ Chasis no está en Siigo ni en inventario · llena los datos manualmente", "info");
        return;
      }
      if (data.multiple && data.opciones?.length > 1) {
        // Hay varias motos que matchean — mostrar opciones en el datalist
        mostrarOpcionesEnDatalist(data.opciones);
        mostrarMsgAutofill(`📋 ${data.total} coincidencias en Siigo — abre el menú desplegable o escribe más caracteres`, "info");
        return;
      }
      const m = data.moto || data.opciones?.[0];
      if (m) llenar(m, "Siigo");
    } catch (e) {
      mostrarMsgAutofill("", "");
    }
  }

  function mostrarOpcionesEnDatalist(motos) {
    const dl = document.getElementById("chasisList");
    if (!dl) return;
    dl.innerHTML = motos.slice(0, 20).map(m => {
      const estado = m.stock === 0 ? " · VENDIDA" : "";
      const label = `${m.marca || ""} ${m.modelo || ""} · ${m.color || ""}${estado}`.trim();
      return `<option value="${escapeHtml(m.chasis)}">${escapeHtml(label)}</option>`;
    }).join("");
  }

  function mostrarMsgAutofill(texto, tipo) {
    const msgEl = document.getElementById("preasigMsg");
    if (!msgEl) return;
    if (!texto) { msgEl.className = "modal-msg"; msgEl.textContent = ""; return; }
    msgEl.className = "modal-msg " + (tipo === "ok" ? "ok" : tipo === "info" ? "info" : "");
    msgEl.textContent = texto;
  }

  // Buscar al pegar/cambiar (con debounce de 400ms al escribir)
  chasisInp.addEventListener("change", buscarYRellenar);
  chasisInp.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(buscarYRellenar, 400);
  });

  // Auto-llenar datos del cliente al escoger desde leads
  const clienteInp = f.querySelector('[name="nombreCliente"]');
  if (clienteInp) {
    const llenarDatosCliente = () => {
      const nombre = clienteInp.value.trim().toUpperCase();
      if (!nombre || nombre.length < 3) return;
      // Buscar lead con nombre exacto, luego que empiece igual, luego que incluya
      const lead = leadsState.leads.find(l => (l.cliente || "").toUpperCase() === nombre)
                || leadsState.leads.find(l => (l.cliente || "").toUpperCase().startsWith(nombre))
                || leadsState.leads.find(l => (l.cliente || "").toUpperCase().includes(nombre));
      if (!lead) return;
      // Auto-llenar cédula, celular, fecha nacimiento, # crédito, financiera SOLO si están vacíos
      const camposLead = {
        cedulaCliente: lead.documento,
        celular: lead.celular,
        fechaNacimiento: lead.fechaNacimiento,
        numCredito: lead.numCredito,
        financiera: lead.financiera,
        placa: lead.placa,
      };
      let llenados = [];
      for (const [campo, valor] of Object.entries(camposLead)) {
        const inp = f.querySelector(`[name="${campo}"]`);
        if (inp && valor && !inp.value) {
          inp.value = valor;
          llenados.push(campo);
        }
      }
      // Si el nombre del input no es exactamente el del lead, usar el del lead
      if (clienteInp.value !== lead.cliente) clienteInp.value = lead.cliente;
      if (llenados.length > 0) {
        const msgEl = document.getElementById("preasigMsg");
        if (msgEl) {
          msgEl.className = "modal-msg ok";
          msgEl.textContent = `✓ Datos del cliente cargados desde lead existente (${llenados.length} campos)`;
        }
      }
    };
    clienteInp.addEventListener("change", llenarDatosCliente);
    clienteInp.addEventListener("blur", llenarDatosCliente);
  }
}

const btnNuevaPreasignacion = document.getElementById("btnNuevaPreasignacion");
if (btnNuevaPreasignacion) btnNuevaPreasignacion.addEventListener("click", () => abrirPreasigModal());

const btnCancelarPreasig = document.getElementById("btnCancelarPreasig");
if (btnCancelarPreasig) btnCancelarPreasig.addEventListener("click", () => document.getElementById("modalPreasig").classList.remove("show"));

const preasigVerTodos = document.getElementById("preasigVerTodos");
if (preasigVerTodos) preasigVerTodos.addEventListener("change", e => { preasigState.verTodos = e.target.checked; loadPreasignaciones(); });

const formPreasig = document.getElementById("formPreasig");
if (formPreasig) {
  formPreasig.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(formPreasig);
    const body = Object.fromEntries(fd.entries());
    const msg = document.getElementById("preasigMsg");
    msg.className = "modal-msg";
    const btn = document.getElementById("btnGuardarPreasig");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const r = await fetch("/api/preasignaciones/crear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data.ok) {
        msg.textContent = "✓ Guardado"; msg.className = "modal-msg ok";
        setTimeout(() => { document.getElementById("modalPreasig").classList.remove("show"); }, 700);
        loadPreasignaciones();
      } else {
        msg.textContent = data.error || "Error"; msg.className = "modal-msg err";
      }
    } catch (e) {
      msg.textContent = "Error: " + e.message; msg.className = "modal-msg err";
    } finally {
      btn.disabled = false; btn.textContent = "Guardar preasignación";
    }
  });
}

// ============================================================
//          TALLER — vista de motos en proceso
// ============================================================
function renderTaller() {
  const tbody = document.querySelector("#tblTaller tbody");
  if (!tbody) return;
  const esRolTaller = currentUser?.rol === "taller";
  // Para el rol taller: mostrar solo las que están en taller (pendientes) — no muestra entregadas ni listas
  // Para los demás: mostrar en_taller + lista_para_entregar + entregada
  const enTaller = Object.values(preasigState.preasignaciones).filter(p => {
    if (esRolTaller) return p.estado === "en_taller"; // solo pendientes para taller
    return p.estado === "en_taller" || p.estado === "lista_para_entregar" || p.estado === "entregada";
  });
  document.getElementById("tallerCount").textContent = fmtNum.format(enTaller.length);

  if (enTaller.length === 0) {
    const colspan = esRolTaller ? 9 : 10;
    tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;color:var(--muted);padding:30px">
      ${esRolTaller ? "✓ ¡Todo al día! Sin motos pendientes de alistar." : 'Sin motos en taller. Mueve una preasignación con el botón <strong>"→ A taller"</strong>.'}
    </td></tr>`;
    return;
  }

  // Ordenar por fecha de entrada a taller — MÁS ANTIGUAS PRIMERO (orden de cola)
  const sorted = enTaller.sort((a, b) => {
    const ta = a.entradaTaller || a.actualizadoEn || "";
    const tb = b.entradaTaller || b.actualizadoEn || "";
    return ta.localeCompare(tb); // ascendente: las que llevan más tiempo primero
  });

  tbody.innerHTML = sorted.map(p => {
      const gpsLabel = { sin: "Sin GPS", instalar: "⚙ Instalar", activar: "📡 Activar" }[p.gps] || "—";
      const estadoCls = p.estado === "entregada" ? "tag-contado"
                      : p.estado === "lista_para_entregar" ? "tag-financiado" : "tag-financiado";
      const estadoTexto = p.estado === "entregada" ? "✓ Entregada"
                        : p.estado === "lista_para_entregar" ? "✓ Lista — avisar cliente"
                        : "🛠 En taller";
      // Fecha + hora de entrada a taller
      const fechaEntrada = p.entradaTaller || p.actualizadoEn;
      const fechaFmt = fechaEntrada
        ? new Date(fechaEntrada).toLocaleString("es-CO", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" })
        : "—";
      // Calcular cuánto tiempo lleva en taller
      let tiempoLleva = "";
      if (fechaEntrada) {
        const mins = Math.floor((Date.now() - new Date(fechaEntrada).getTime()) / 60000);
        if (mins < 60) tiempoLleva = `${mins} min`;
        else if (mins < 60*24) tiempoLleva = `${Math.floor(mins/60)}h ${mins%60}min`;
        else tiempoLleva = `${Math.floor(mins/(60*24))} días`;
      }

      // Acciones según rol
      let acciones = "";
      if (esRolTaller && p.estado === "en_taller") {
        // Taller: botón "Lista para entregar"
        acciones = `<button class="btn-primary" data-taller-lista="${escapeHtml(p.chasis)}" style="padding:6px 12px;font-size:12px;background:#22c55e;border-color:#22c55e">✓ Lista para entregar</button>`;
      } else if (!esRolTaller && p.estado === "en_taller") {
        acciones = `<span class="muted" style="font-size:11px">Esperando taller…</span>`;
      } else if (!esRolTaller && p.estado === "lista_para_entregar") {
        // Asesor/admin: ahora puede marcar entregada o avisar cliente
        acciones = `<button class="btn-primary" data-taller-entregar="${escapeHtml(p.chasis)}" style="padding:6px 12px;font-size:12px">✓ Marcar entregada</button>`;
      }

      // Columna asesor (oculta para taller mediante data-role-only del th)
      const asesorCell = esRolTaller ? "" : `<td>${escapeHtml(p.asesorNombre || "—")}</td>`;

      return `<tr ${p.estado === "entregada" ? 'class="row-inactive"' : ""}>
        <td>
          <div style="font-size:12px">${escapeHtml(fechaFmt)}</div>
          ${tiempoLleva ? `<div class="muted" style="font-size:10.5px">hace ${tiempoLleva}</div>` : ""}
        </td>
        <td><strong>${escapeHtml(p.placa || "—")}</strong></td>
        <td><code style="font-size:11px;color:var(--accent-2)">${escapeHtml(p.chasis)}</code></td>
        <td><code style="font-size:11px;color:var(--muted)">${escapeHtml(p.motor || "—")}</code></td>
        <td><strong>${escapeHtml(p.marca || "")} ${escapeHtml(p.modelo || "")}</strong></td>
        <td>${escapeHtml(p.nombreCliente || "—")}</td>
        ${asesorCell}
        <td>${gpsLabel}</td>
        <td><span class="tag ${estadoCls}">${estadoTexto}</span></td>
        <td>${acciones}</td>
      </tr>`;
    }).join("");

  tbody.querySelectorAll("[data-taller-entregar]").forEach(b => {
    b.addEventListener("click", async () => {
      if (!confirm("¿Marcar como entregada al cliente?")) return;
      await cambiarEstadoPreasig(b.dataset.tallerEntregar, "entregada");
    });
  });
  // Botón "Lista para entregar" (rol taller)
  tbody.querySelectorAll("[data-taller-lista]").forEach(b => {
    b.addEventListener("click", async () => {
      if (!confirm("¿Marcar esta moto como Lista para entregar?\n\nSe avisará al asesor para que contacte al cliente.")) return;
      await cambiarEstadoPreasig(b.dataset.tallerLista, "lista_para_entregar");
    });
  });

  // Actualizar el badge del sidebar con el conteo de motos listas para entregar
  // (solo aplica para asesor/admin/dueno — para que vean cuántas hay listas)
  const motosListas = Object.values(preasigState.preasignaciones || {})
    .filter(p => p.estado === "lista_para_entregar");
  // Para asesor: solo las suyas; para admin/dueno: todas
  const propias = currentUser?.rol === "asesor"
    ? motosListas.filter(p => p.asesorEmail === currentUser.email)
    : motosListas;
  const badge = document.getElementById("tallerListasBadge");
  if (badge) {
    if (propias.length > 0) {
      badge.textContent = propias.length;
      badge.style.display = "inline-block";
      badge.title = `${propias.length} moto(s) lista(s) para avisar al cliente`;
    } else {
      badge.style.display = "none";
    }
  }
}

const tallerVerTodos = document.getElementById("tallerVerTodos");
if (tallerVerTodos) tallerVerTodos.addEventListener("change", e => { preasigState.verTodos = e.target.checked; loadPreasignaciones(); });

// ============================================================
//          SOAT — pendientes de crear (vista contabilidad)
// ============================================================
const soatState = { search: "" };

function renderSoatPendientes() {
  const wrap = document.getElementById("soatLista");
  const countEl = document.getElementById("soatCount");
  if (!wrap || !countEl) return;

  // Fuente: TODAS las preasignaciones que no tengan SOAT subido todavía
  // (no requiere empadronamiento previo — el asesor puede subirlo desde acá)
  const preasigs = Object.values(preasigState.preasignaciones || {})
    .filter(p => p.chasis)  // solo las que tienen chasis válido
    .filter(p => p.estado !== "entregada");  // no las ya entregadas

  // Verificar cuáles no tienen SOAT subido en docState.docs
  const candidatas = preasigs.filter(p => {
    const docs = docState.docs?.[p.chasis] || docState.docs?.[String(p.chasis).toUpperCase()];
    return !docs?.archivos?.soat;
  });

  // Filtro de búsqueda
  const q = (soatState.search || "").toLowerCase().trim();
  const filtradas = candidatas.filter(p => {
    if (!q) return true;
    const lead = leadsState.leads.find(l => (l.chasis || "").toUpperCase() === (p.chasis || "").toUpperCase());
    return [p.chasis, p.placa, p.nombreCliente, p.cedulaCliente, p.modelo, p.marca,
            lead?.email, lead?.celular, lead?.direccion]
      .some(v => String(v || "").toLowerCase().includes(q));
  });

  countEl.textContent = fmtNum.format(filtradas.length);

  if (filtradas.length === 0) {
    wrap.innerHTML = `<div style="text-align:center;color:var(--muted);padding:30px;border:1px dashed var(--line);border-radius:12px">
      ${candidatas.length === 0
        ? "Sin SOATs pendientes. Cuando un asesor cree una <strong>preasignación</strong>, aparecerá aquí para crear el SOAT."
        : "Sin resultados para esa búsqueda."}
    </div>`;
    return;
  }

  // Ordenar: las que tienen empadronamiento primero (listas para SOAT), después las que faltan
  filtradas.sort((a, b) => {
    const docsA = docState.docs?.[a.chasis] || docState.docs?.[String(a.chasis).toUpperCase()];
    const docsB = docState.docs?.[b.chasis] || docState.docs?.[String(b.chasis).toUpperCase()];
    const empA = !!docsA?.archivos?.empadronamiento;
    const empB = !!docsB?.archivos?.empadronamiento;
    if (empA !== empB) return empB - empA;  // con empadronamiento primero
    return (b.creadoEn || "").localeCompare(a.creadoEn || "");
  });

  wrap.innerHTML = filtradas.map(p => {
    const chasis = p.chasis;
    const docs = docState.docs?.[chasis] || docState.docs?.[String(chasis).toUpperCase()] || { archivos: {} };
    const lead = leadsState.leads.find(l => (l.chasis || "").toUpperCase() === chasis.toUpperCase())
              || leadsState.leads.find(l => String(l.documento || "").replace(/[^0-9]/g, "") === String(p.cedulaCliente || "").replace(/[^0-9]/g, ""));

    const empArchivo = docs.archivos?.empadronamiento;
    const facturaArchivo = docs.archivos?.facturaVenta;
    const tieneEmp = !!empArchivo;
    const fechaEmp = empArchivo?.subidoEn ? new Date(empArchivo.subidoEn).toLocaleDateString("es-CO") : "—";
    const fechaFac = facturaArchivo?.subidoEn ? new Date(facturaArchivo.subidoEn).toLocaleDateString("es-CO") : "—";
    const cliente = p.nombreCliente || lead?.cliente || "(sin cliente)";
    const cedula = p.cedulaCliente || lead?.documento || "";
    const correo = lead?.email || "";
    const celular = p.celular || lead?.celular || "";
    const direccion = lead?.direccion || "";
    const modelo = `${p.marca || ""} ${p.modelo || ""}`.trim();

    const statusTag = tieneEmp
      ? `<span class="tag tag-contado">✓ Listo para SOAT</span>`
      : `<span class="tag tag-financiado">⏳ Falta empadronamiento</span>`;

    return `<div class="card" style="border:1px solid var(--line);padding:16px;background:rgba(8,12,28,.5)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:14px">
        <div>
          <h3 style="margin:0 0 4px;font-size:16px">${escapeHtml(cliente)} <code style="font-size:11px;color:var(--accent-2);font-weight:400;margin-left:6px">${escapeHtml(chasis)}</code></h3>
          <p class="muted" style="margin:0;font-size:12.5px">${escapeHtml(modelo || "—")}${p.color ? ` · ${escapeHtml(p.color)}` : ""}</p>
        </div>
        ${statusTag}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 18px;font-size:13px;margin-bottom:14px">
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Placa</span><br>
          <strong style="font-size:15px;color:var(--accent-2)">${escapeHtml(p.placa || "—")}</strong>
          ${p.placa ? `<button class="btn-mini" data-copy="${escapeHtml(p.placa)}" title="Copiar">📋</button>` : ""}
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Cédula</span><br>
          <strong>${escapeHtml(cedula || "—")}</strong>
          ${cedula ? `<button class="btn-mini" data-copy="${escapeHtml(cedula)}" title="Copiar">📋</button>` : ""}
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Correo</span><br>
          <strong>${escapeHtml(correo || "—")}</strong>
          ${correo ? `<button class="btn-mini" data-copy="${escapeHtml(correo)}" title="Copiar">📋</button>` : ""}
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Celular</span><br>
          <strong>${escapeHtml(celular || "—")}</strong>
          ${celular ? `<button class="btn-mini" data-copy="${escapeHtml(celular)}" title="Copiar">📋</button>` : ""}
        </div>
        <div style="grid-column:span 2">
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Dirección</span><br>
          <strong>${escapeHtml(direccion || "—")}</strong>
          ${direccion ? `<button class="btn-mini" data-copy="${escapeHtml(direccion)}" title="Copiar">📋</button>` : ""}
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Chasis</span><br>
          <code style="font-size:12px;color:var(--accent-2)">${escapeHtml(chasis)}</code>
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Motor</span><br>
          <code style="font-size:12px;color:var(--muted)">${escapeHtml(p.motor || "—")}</code>
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em"># Crédito</span><br>
          <strong>${escapeHtml(p.numCredito || "—")}</strong>
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Financiera</span><br>
          <strong>${escapeHtml(p.financiera || "—")}</strong>
        </div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        ${tieneEmp
          ? `<a class="btn-primary" href="/uploads/${encodeURIComponent(chasis)}/${encodeURIComponent(empArchivo.path)}" target="_blank" style="padding:8px 14px;font-size:13px;text-decoration:none">
              📋 Ver empadronamiento <span class="muted" style="font-size:11px;font-weight:400">(${fechaEmp})</span>
            </a>`
          : `<label class="btn-primary" style="padding:8px 14px;font-size:13px;cursor:pointer;background:#f7c272;border-color:#f7c272;color:#1a1a1a">
              📋 Subir empadronamiento
              <input type="file" data-emp-upload data-id="${escapeHtml(chasis)}" accept="image/*,application/pdf" style="display:none" />
            </label>`}
        ${facturaArchivo ? `<a class="btn-secondary" href="/uploads/${encodeURIComponent(chasis)}/${encodeURIComponent(facturaArchivo.path)}" target="_blank" style="padding:8px 14px;font-size:13px;text-decoration:none">
          🧾 Ver factura <span class="muted" style="font-size:11px;font-weight:400">(${fechaFac})</span>
        </a>` : ""}
        <label class="btn-primary" data-role-only="admin contable" style="padding:8px 14px;font-size:13px;cursor:pointer;background:#22c55e;border-color:#22c55e">
          ✓ Subir SOAT generado
          <input type="file" data-soat-upload data-id="${escapeHtml(chasis)}" accept="image/*,application/pdf" style="display:none" />
        </label>
      </div>
    </div>`;
  }).join("");

  // Copy al portapapeles
  wrap.querySelectorAll("[data-copy]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        showToast(`Copiado: ${btn.dataset.copy}`);
      } catch { showToast("No se pudo copiar"); }
    });
  });

  // Subir empadronamiento (asesor o admin)
  wrap.querySelectorAll("input[data-emp-upload]").forEach(inp => {
    inp.addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      const id = inp.dataset.id;
      const fd = new FormData();
      fd.append("idVenta", id);
      fd.append("tipo", "empadronamiento");
      fd.append("archivo", file);
      try {
        const r = await fetch("/api/docs/upload", { method: "POST", body: fd });
        const data = await r.json();
        if (data.ok) {
          showToast("✓ Empadronamiento subido");
          await loadDocs();
        } else {
          showToast("Error: " + (data.error || "no se pudo subir"));
        }
      } catch (e) { showToast("Error: " + e.message); }
    });
  });

  // Subir SOAT (contabilidad)
  wrap.querySelectorAll("input[data-soat-upload]").forEach(inp => {
    inp.addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      const id = inp.dataset.id;
      const fd = new FormData();
      fd.append("idVenta", id);
      fd.append("tipo", "soat");
      fd.append("archivo", file);
      try {
        const r = await fetch("/api/docs/upload", { method: "POST", body: fd });
        const data = await r.json();
        if (data.ok) {
          showToast("✓ SOAT subido");
          await loadDocs();
        } else {
          showToast("Error: " + (data.error || "no se pudo subir"));
        }
      } catch (e) { showToast("Error: " + e.message); }
    });
  });
}

const soatSearchEl = document.getElementById("soatSearch");
if (soatSearchEl) soatSearchEl.addEventListener("input", e => { soatState.search = e.target.value; renderSoatPendientes(); });

// ============================================================
//          GPS INSTALAR / ACTIVAR — secciones del instalador
// ============================================================
const gpsState = { searchInstalar: "", searchActivar: "" };

function renderGpsLista(tipo) {
  // tipo: "instalar" o "activar"
  const wrapId = tipo === "instalar" ? "gpsInstalarLista" : "gpsActivarLista";
  const countId = tipo === "instalar" ? "gpsInstalarCount" : "gpsActivarCount";
  const badgeId = tipo === "instalar" ? "gpsInstalarBadge" : "gpsActivarBadge";
  const search = tipo === "instalar" ? gpsState.searchInstalar : gpsState.searchActivar;
  const wrap = document.getElementById(wrapId);
  const countEl = document.getElementById(countId);
  if (!wrap || !countEl) return;

  // Estado complemento: si ya fue instalado, no aparece
  const flagCompletado = tipo === "instalar" ? "gpsInstaladoEn" : "gpsActivadoEn";

  // Fuente: preasignaciones con gps == tipo, no entregadas, sin marcar completado
  const candidatas = Object.values(preasigState.preasignaciones || {})
    .filter(p => p.gps === tipo)
    .filter(p => p.estado !== "entregada")
    .filter(p => !p[flagCompletado]);

  const q = (search || "").toLowerCase().trim();
  const filtradas = q ? candidatas.filter(p =>
    [p.placa, p.chasis, p.nombreCliente, p.cedulaCliente, p.modelo, p.marca]
      .some(v => String(v || "").toLowerCase().includes(q))
  ) : candidatas;

  // Ordenar más antiguas primero
  filtradas.sort((a, b) => (a.creadoEn || "").localeCompare(b.creadoEn || ""));

  countEl.textContent = fmtNum.format(filtradas.length);

  // Actualizar badge en sidebar (para asesor/admin)
  const badge = document.getElementById(badgeId);
  if (badge) {
    if (candidatas.length > 0) {
      badge.textContent = candidatas.length;
      badge.style.display = "inline-block";
    } else { badge.style.display = "none"; }
  }

  if (filtradas.length === 0) {
    const esRolGps = currentUser?.rol === ("gps_" + tipo);
    wrap.innerHTML = `<div style="text-align:center;color:var(--muted);padding:30px;border:1px dashed var(--line);border-radius:12px">
      ${candidatas.length === 0
        ? (esRolGps
            ? `✓ Sin motos pendientes de ${tipo === "instalar" ? "instalación" : "activación"} ahora.`
            : `Sin motos pendientes de ${tipo === "instalar" ? "instalación" : "activación"} de GPS. Cuando un asesor marque GPS=${tipo} en la preasignación, aparecerán aquí.`)
        : "Sin resultados para esa búsqueda."}
    </div>`;
    return;
  }

  const titulo = tipo === "instalar" ? "Instalado" : "Activado";
  const flagColor = tipo === "instalar" ? "#06b6d4" : "#a855f7";
  const lead = (chasis) => leadsState.leads.find(l => (l.chasis || "").toUpperCase() === (chasis || "").toUpperCase());

  wrap.innerHTML = filtradas.map(p => {
    const l = lead(p.chasis) || {};
    const fechaPreasig = p.creadoEn
      ? new Date(p.creadoEn).toLocaleString("es-CO", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" })
      : "—";
    let tiempoLleva = "";
    if (p.creadoEn) {
      const mins = Math.floor((Date.now() - new Date(p.creadoEn).getTime()) / 60000);
      if (mins < 60) tiempoLleva = `${mins} min`;
      else if (mins < 60*24) tiempoLleva = `${Math.floor(mins/60)}h ${mins%60}min`;
      else tiempoLleva = `${Math.floor(mins/(60*24))} días`;
    }
    const evidenciaURL = p[`gps${tipo === "instalar" ? "Instalar" : "Activar"}EvidenciaPath`]
      ? `/uploads/${encodeURIComponent(p.chasis)}/${encodeURIComponent(p[`gps${tipo === "instalar" ? "Instalar" : "Activar"}EvidenciaPath`])}`
      : null;

    return `<div class="card" style="border:1px solid var(--line);padding:16px;background:rgba(8,12,28,.5)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:14px">
        <div>
          <h3 style="margin:0 0 4px;font-size:16px">${escapeHtml(p.nombreCliente || "(sin cliente)")}
            <code style="font-size:11px;color:${flagColor};font-weight:400;margin-left:6px">${escapeHtml(p.chasis)}</code>
          </h3>
          <p class="muted" style="margin:0;font-size:12.5px">${escapeHtml(p.marca || "")} ${escapeHtml(p.modelo || "")}${p.color ? ` · ${escapeHtml(p.color)}` : ""}</p>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Preasignada</div>
          <div style="font-size:13px">${escapeHtml(fechaPreasig)}</div>
          ${tiempoLleva ? `<div class="muted" style="font-size:10.5px">hace ${tiempoLleva}</div>` : ""}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px 18px;font-size:13px;margin-bottom:14px">
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Placa</span><br>
          <strong style="font-size:15px;color:${flagColor}">${escapeHtml(p.placa || "—")}</strong>
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Cédula</span><br>
          <strong>${escapeHtml(p.cedulaCliente || l.documento || "—")}</strong>
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Celular</span><br>
          <strong>${escapeHtml(p.celular || l.celular || "—")}</strong>
        </div>
        <div>
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Motor</span><br>
          <code style="font-size:11px;color:var(--muted)">${escapeHtml(p.motor || "—")}</code>
        </div>
      </div>

      ${tipo === "activar" ? `
      <div style="background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.25);border-radius:8px;padding:12px;margin:10px 0;font-size:13px">
        <div style="font-weight:600;color:#c084fc;margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em">
          🔧 Activar en Impulsa Trakku — copia cada dato
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:12.5px">
          <div><span class="muted">Cédula:</span> <code>${escapeHtml(p.cedulaCliente || l.documento || "—")}</code> ${(p.cedulaCliente || l.documento) ? `<button class="btn-mini" data-copy="${escapeHtml(p.cedulaCliente || l.documento)}" title="Copiar">📋</button>` : ""}</div>
          <div><span class="muted"># Crédito:</span> <code>${escapeHtml(p.numCredito || "—")}</code> ${p.numCredito ? `<button class="btn-mini" data-copy="${escapeHtml(p.numCredito)}" title="Copiar">📋</button>` : ""}</div>
          <div><span class="muted">Cliente:</span> ${escapeHtml(p.nombreCliente || "—")} ${p.nombreCliente ? `<button class="btn-mini" data-copy="${escapeHtml(p.nombreCliente)}" title="Copiar">📋</button>` : ""}</div>
          <div><span class="muted">Email:</span> ${escapeHtml(l.email || "—")} ${l.email ? `<button class="btn-mini" data-copy="${escapeHtml(l.email)}" title="Copiar">📋</button>` : ""}</div>
          <div style="grid-column:span 2">
            <span class="muted">IMEI GPS:</span>
            ${p.imeiGps
              ? `<code style="color:#22d3ee">${escapeHtml(p.imeiGps)}</code> <button class="btn-mini" data-copy="${escapeHtml(p.imeiGps)}" title="Copiar">📋</button>`
              : `<label class="btn-secondary" style="padding:4px 10px;font-size:11px;cursor:pointer;margin-left:6px">
                  📸 Foto sticker GPS
                  <input type="file" data-gps-imei="${escapeHtml(p.chasis)}" accept="image/*" capture="environment" style="display:none" />
                </label>`}
          </div>
        </div>
        <a href="https://socios.impulsacrm.com" target="_blank" style="display:inline-block;margin-top:10px;padding:6px 12px;background:#a855f7;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600">🔗 Abrir Impulsa Trakku</a>
      </div>
      ` : ""}

      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding-top:10px;border-top:1px solid rgba(255,255,255,.06)">
        ${evidenciaURL
          ? `<a class="btn-secondary" href="${evidenciaURL}" target="_blank" style="padding:6px 12px;font-size:12px;text-decoration:none">🎥 Ver evidencia</a>`
          : tipo === "instalar"
            ? `<label class="btn-secondary" style="padding:6px 12px;font-size:12px;cursor:pointer">
                🎥 Subir video evidencia
                <input type="file" data-gps-video="${escapeHtml(p.chasis)}" accept="video/*,image/*" style="display:none" />
              </label>`
            : ""}
        <button class="btn-primary" data-gps-completar="${escapeHtml(p.chasis)}" data-gps-tipo="${tipo}" style="padding:6px 12px;font-size:12px;background:#22c55e;border-color:#22c55e">
          ✓ GPS ${titulo}
        </button>
      </div>
    </div>`;
  }).join("");

  // Listener — copy general
  wrap.querySelectorAll("[data-copy]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        showToast(`📋 Copiado: ${btn.dataset.copy}`);
      } catch { showToast("No se pudo copiar"); }
    });
  });

  // Listener — foto del sticker GPS → OCR IMEI
  wrap.querySelectorAll("input[data-gps-imei]").forEach(inp => {
    inp.addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      const chasis = inp.dataset.gpsImei;
      showToast("🔎 Leyendo IMEI con IA…");
      const fd = new FormData();
      fd.append("archivo", file);
      try {
        const r = await fetch("/api/gps/leer-imei", { method: "POST", body: fd });
        const data = await r.json();
        if (!data.ok || !data.imei) {
          // Permitir entrada manual si OCR falló
          const imei = prompt(`No pude leer el IMEI claramente.\n\nEscríbelo manualmente (15 dígitos):`, data.imei || "");
          if (!imei) return;
          await guardarImei(chasis, imei);
          return;
        }
        // Confirmar IMEI con el usuario antes de guardar
        const imei = prompt(`IMEI detectado:\n\n${data.imei}\n\n¿Es correcto? Edita si hace falta:`, data.imei);
        if (!imei) return;
        await guardarImei(chasis, imei);
      } catch (e) { showToast("Error: " + e.message); }
    });
  });

  // Listeners — subir video evidencia (GPS Instalar)
  wrap.querySelectorAll("input[data-gps-video]").forEach(inp => {
    inp.addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      const chasis = inp.dataset.gpsVideo;
      const fd = new FormData();
      fd.append("idVenta", chasis);
      fd.append("tipo", "gpsInstalarEvidencia");
      fd.append("archivo", file);
      try {
        const r = await fetch("/api/docs/upload", { method: "POST", body: fd });
        const data = await r.json();
        if (data.ok) {
          showToast("✓ Evidencia subida");
          // Guardar referencia en preasignación
          await fetch(`/api/preasignaciones/${encodeURIComponent(chasis)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gpsInstalarEvidenciaPath: data.archivo?.path || file.name }),
          });
          await loadPreasignaciones();
        } else {
          showToast("Error: " + (data.error || "no se pudo subir"));
        }
      } catch (e) { showToast("Error: " + e.message); }
    });
  });

  // Listeners — botón completar GPS
  wrap.querySelectorAll("[data-gps-completar]").forEach(b => {
    b.addEventListener("click", async () => {
      const tipoBtn = b.dataset.gpsTipo;
      const verbo = tipoBtn === "instalar" ? "instalada" : "activada";
      if (!confirm(`¿Marcar el GPS de esta moto como ${verbo}?`)) return;
      const chasis = b.dataset.gpsCompletar;
      const campo = tipoBtn === "instalar" ? "gpsInstaladoEn" : "gpsActivadoEn";
      try {
        const r = await fetch(`/api/preasignaciones/${encodeURIComponent(chasis)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [campo]: new Date().toISOString() }),
        });
        const data = await r.json();
        if (data.ok) {
          showToast(`✓ GPS ${verbo}`);
          await loadPreasignaciones();
        } else {
          showToast("Error: " + (data.error || "no se pudo guardar"));
        }
      } catch (e) { showToast("Error: " + e.message); }
    });
  });
}

// Helper (afuera de renderGpsLista) — guarda IMEI en una preasignación
async function guardarImei(chasis, imei) {
  try {
    const r = await fetch(`/api/preasignaciones/${encodeURIComponent(chasis)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imeiGps: imei.trim() }),
    });
    const data = await r.json();
    if (data.ok) {
      showToast(`✓ IMEI guardado: ${imei}`);
      await loadPreasignaciones();
    } else {
      showToast("Error: " + (data.error || "no se pudo guardar"));
    }
  } catch (e) { showToast("Error: " + e.message); }
}

const gpsInstalarSearchEl = document.getElementById("gpsInstalarSearch");
if (gpsInstalarSearchEl) gpsInstalarSearchEl.addEventListener("input", e => { gpsState.searchInstalar = e.target.value; renderGpsLista("instalar"); });
const gpsActivarSearchEl = document.getElementById("gpsActivarSearch");
if (gpsActivarSearchEl) gpsActivarSearchEl.addEventListener("input", e => { gpsState.searchActivar = e.target.value; renderGpsLista("activar"); });

// ============================================================
//          FACTURA AUTECO — OCR con Claude Vision (solo admin)
// ============================================================
const formFactura = document.getElementById("formFactura");
if (formFactura) {
  formFactura.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(formFactura);
    const msg = document.getElementById("facturaMsg");
    const btn = document.getElementById("btnProcesarFactura");
    msg.style.display = "block";
    msg.className = "form-msg";
    msg.textContent = "🤖 Procesando factura con Claude IA, esto toma 10-30 segundos…";
    btn.disabled = true;
    btn.textContent = "Procesando…";
    document.getElementById("facturaResultado").style.display = "none";

    try {
      const r = await fetch("/api/factura/procesar", { method: "POST", body: fd });
      const data = await r.json();
      if (data.ok) {
        const n = data.motos.length;
        if (n === 0) {
          msg.className = "form-msg form-msg-info";
          msg.textContent = "⚠️ La IA no detectó motos en esta imagen. Asegúrate que la foto sea clara y muestre la factura completa con los datos de cada moto.";
        } else {
          msg.className = "form-msg form-msg-ok";
          const tokens = data.usoTokens ? ` · Tokens: ${data.usoTokens.input}+${data.usoTokens.output}` : "";
          msg.innerHTML = `✅ <strong>${n} ${n === 1 ? 'moto detectada' : 'motos detectadas'}</strong>. Revisa y corrige abajo antes de confirmar.${tokens}`;
          renderFacturaMotos(data.motos);
          document.getElementById("facturaResultado").style.display = "block";
        }
      } else {
        msg.className = "form-msg form-msg-err";
        msg.textContent = "❌ " + (data.error || "Error procesando");
      }
    } catch (e) {
      msg.className = "form-msg form-msg-err";
      msg.textContent = "Error de conexión: " + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "🤖 Procesar con IA";
    }
  });
}

function renderFacturaMotos(motos) {
  const tbody = document.querySelector("#tblFacturaMotos tbody");
  tbody.innerHTML = motos.map((m, i) => `
    <tr data-idx="${i}">
      <td style="text-align:center"><input type="checkbox" class="moto-check" checked data-idx="${i}" title="Marcar para enviar a Siigo" /></td>
      <td><input class="celda-edit" data-campo="marca" value="${escapeHtml(m.marca || '')}" /></td>
      <td><input class="celda-edit" data-campo="modelo" value="${escapeHtml(m.modelo || '')}" /></td>
      <td><input class="celda-edit" data-campo="color" value="${escapeHtml(m.color || '')}" /></td>
      <td><input class="celda-edit" data-campo="anio" value="${escapeHtml(m.anio || '')}" style="width:70px" /></td>
      <td><input class="celda-edit" data-campo="chasis" value="${escapeHtml(m.chasis || '')}" style="font-family:monospace;font-size:11px" /></td>
      <td><input class="celda-edit" data-campo="motor" value="${escapeHtml(m.motor || '')}" style="font-family:monospace;font-size:11px" /></td>
      <td><input class="celda-edit" data-campo="precio" value="${m.precio || ''}" inputmode="numeric" style="width:120px;text-align:right" /></td>
      <td><button class="btn-borrar-lead" data-quitar-idx="${i}" title="Quitar esta moto">🗑️</button></td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-quitar-idx]").forEach(b => {
    b.addEventListener("click", () => {
      b.closest("tr").remove();
    });
  });
}

function recolectarMotosFactura() {
  const filas = document.querySelectorAll("#tblFacturaMotos tbody tr");
  const motos = [];
  for (const tr of filas) {
    const check = tr.querySelector(".moto-check");
    if (check && !check.checked) continue;  // saltar las no marcadas
    const moto = {};
    tr.querySelectorAll(".celda-edit").forEach(inp => {
      moto[inp.dataset.campo] = inp.value.trim();
    });
    moto.precio = parseInt(String(moto.precio).replace(/[^0-9]/g, ""), 10) || 0;
    if (moto.chasis || moto.modelo) motos.push(moto);
  }
  return motos;
}

document.getElementById("btnCancelarFactura")?.addEventListener("click", () => {
  document.getElementById("facturaResultado").style.display = "none";
  document.getElementById("facturaMsg").style.display = "none";
  formFactura?.reset();
});

document.getElementById("btnConfirmarFactura")?.addEventListener("click", async () => {
  const motos = recolectarMotosFactura();
  if (motos.length === 0) { showToast("No hay motos marcadas para enviar"); return; }
  if (!confirm(`¿Enviar ${motos.length} ${motos.length === 1 ? 'moto' : 'motos'} al inventario de Siigo?\n\nEsto las creará como productos nuevos en Siigo con sus datos (chasis, motor, modelo, precio).`)) return;

  const msg = document.getElementById("facturaMsg");
  const btn = document.getElementById("btnConfirmarFactura");
  btn.disabled = true; btn.textContent = "Enviando a Siigo…";
  msg.style.display = "block";
  msg.className = "form-msg";
  msg.textContent = `🚀 Creando ${motos.length} producto(s) en Siigo...`;

  try {
    const r = await fetch("/api/siigo/crear-productos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motos }),
    });
    const data = await r.json();

    if (!data.ok) {
      msg.className = "form-msg form-msg-error";
      msg.innerHTML = `❌ Error: ${escapeHtml(data.error || "no se pudo enviar a Siigo")}`;
      btn.disabled = false; btn.textContent = "Enviar a Siigo";
      return;
    }

    const okCount = data.creados?.length || 0;
    const errCount = data.errores?.length || 0;
    let html = `<strong>${okCount} de ${data.total} motos creadas en Siigo.</strong>`;
    if (okCount > 0) {
      html += `<br><br>✅ <strong>Creadas:</strong><ul style="margin:6px 0 0 18px;font-size:12px">`;
      html += data.creados.map(c => `<li>${escapeHtml(c.modelo || "—")} · chasis <code>${escapeHtml(c.chasis || "—")}</code></li>`).join("");
      html += `</ul>`;
    }
    if (errCount > 0) {
      html += `<br>⚠️ <strong>${errCount} con error:</strong><ul style="margin:6px 0 0 18px;font-size:12px;color:#f7c272">`;
      html += data.errores.map(e => `<li>chasis <code>${escapeHtml(e.chasis || "—")}</code> · ${escapeHtml(e.error || "error")}</li>`).join("");
      html += `</ul>`;
    }

    msg.className = errCount === 0 ? "form-msg form-msg-ok" : "form-msg form-msg-info";
    msg.innerHTML = html;

    // Refrescar inventario en background para mostrar las nuevas
    setTimeout(() => loadInventario(), 1000);
  } catch (e) {
    msg.className = "form-msg form-msg-error";
    msg.innerHTML = `❌ Error de red: ${escapeHtml(e.message)}`;
  } finally {
    btn.disabled = false; btn.textContent = "Enviar a Siigo";
  }
});

// Estilos inline para los inputs de la tabla editable de factura
const styleEditTbl = document.createElement("style");
styleEditTbl.textContent = `
  .celda-edit { background:rgba(8,12,28,.55); border:1px solid var(--line); color:var(--text); border-radius:6px; padding:5px 8px; font:inherit; font-size:12px; width:100%; outline:none; }
  .celda-edit:focus { border-color:var(--accent); }
`;
document.head.appendChild(styleEditTbl);

// ============================================================
//          ACTUALIZAR PRECIOS — subir PDF (solo admin)
// ============================================================
const formSubirPrecios = document.getElementById("formSubirPrecios");
if (formSubirPrecios) {
  formSubirPrecios.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(formSubirPrecios);
    const msg = document.getElementById("preciosUploadMsg");
    msg.style.display = "block"; msg.className = "form-msg"; msg.textContent = "Subiendo…";
    try {
      const r = await fetch("/api/precios/upload", { method: "POST", body: fd });
      const data = await r.json();
      if (data.ok) {
        msg.className = "form-msg form-msg-ok";
        msg.innerHTML = `✅ PDF subido correctamente como <strong>${escapeHtml(data.archivo)}</strong>. <a href="${data.url}" target="_blank" style="color:var(--accent-2)">Abrir</a>`;
        formSubirPrecios.reset();
        loadHistorialPrecios();
      } else {
        msg.className = "form-msg form-msg-err";
        msg.textContent = "Error: " + (data.error || "no se pudo subir");
      }
    } catch (e) {
      msg.className = "form-msg form-msg-err";
      msg.textContent = "Error de conexión: " + e.message;
    }
  });
}

// --- Procesar circular con IA (Claude Vision extrae precios) ---
let circularModelos = [];
let circularInfo = { marca: "", fecha: "" };

const btnProcesarCircular = document.getElementById("btnProcesarCircular");
if (btnProcesarCircular) {
  btnProcesarCircular.addEventListener("click", async () => {
    const fileInput = formSubirPrecios?.querySelector('input[name="archivo"]');
    const file = fileInput?.files?.[0];
    if (!file) { showToast("Primero selecciona el PDF de la circular"); return; }
    const msg = document.getElementById("preciosUploadMsg");
    msg.style.display = "block"; msg.className = "form-msg";
    msg.textContent = "🤖 Claude IA está leyendo el PDF, esto toma 20-40 segundos…";
    btnProcesarCircular.disabled = true;
    btnProcesarCircular.textContent = "Procesando…";

    try {
      const fd = new FormData();
      fd.append("archivo", file);
      const r = await fetch("/api/circular-precios/procesar", { method: "POST", body: fd });
      const data = await r.json();
      if (!data.ok) {
        msg.className = "form-msg form-msg-err";
        msg.textContent = "❌ Error: " + (data.error || "no se pudo procesar");
        return;
      }
      circularModelos = data.modelos || [];
      circularInfo = { marca: data.marca || "", fecha: data.fecha || "" };

      if (circularModelos.length === 0) {
        msg.className = "form-msg form-msg-err";
        msg.textContent = "⚠️ Claude no detectó precios en este PDF. Verifica que sea una circular válida.";
        return;
      }
      msg.style.display = "none";
      renderCircularResultado();
    } catch (e) {
      msg.className = "form-msg form-msg-err";
      msg.textContent = "Error de red: " + e.message;
    } finally {
      btnProcesarCircular.disabled = false;
      btnProcesarCircular.textContent = "🤖 Procesar con IA (extraer precios)";
    }
  });
}

function renderCircularResultado() {
  document.getElementById("circularInfoMarca").textContent = circularInfo.marca || "—";
  document.getElementById("circularInfoFecha").textContent = circularInfo.fecha || "—";
  document.getElementById("circularInfoTotal").textContent = circularModelos.length;
  document.getElementById("circularResultado").style.display = "block";

  const tbody = document.querySelector("#tblCircular tbody");
  tbody.innerHTML = circularModelos.map((m, i) => {
    // Buscar comparativa con Sheet actual
    const enSheet = precState.rows.find(r => r.modelo === (m.modelo || "").toUpperCase().trim());
    let comparativa = `<span class="muted">—</span>`;
    if (enSheet) {
      const sheetP2027 = enSheet.precio2027 || 0;
      const pdfP2027 = m.precio_2027 || 0;
      if (sheetP2027 === pdfP2027 && sheetP2027 > 0) {
        comparativa = `<span style="color:#5be58a">✓ Igual</span>`;
      } else if (sheetP2027 > 0 && pdfP2027 > 0) {
        const diff = pdfP2027 - sheetP2027;
        const arrow = diff > 0 ? "↑" : "↓";
        const color = diff > 0 ? "#f7c272" : "#f87171";
        comparativa = `<span style="color:${color}">${arrow} ${fmtCOP.format(Math.abs(diff))} vs Sheet</span>`;
      } else if (sheetP2027 === 0 && pdfP2027 > 0) {
        comparativa = `<span style="color:#22d3ee">➕ Nuevo precio</span>`;
      }
    } else {
      comparativa = `<span style="color:#22d3ee">⭐ Modelo nuevo</span>`;
    }
    const fmt = v => v ? fmtCOP.format(v) : "—";
    return `<tr data-circ-idx="${i}">
      <td><input class="celda-edit" data-c="modelo" value="${escapeHtml(m.modelo || '')}" /></td>
      <td><input class="celda-edit num" data-c="precio_2025" value="${m.precio_2025 || ''}" style="text-align:right" /></td>
      <td><input class="celda-edit num" data-c="precio_2026" value="${m.precio_2026 || ''}" style="text-align:right" /></td>
      <td><input class="celda-edit num" data-c="precio_2027" value="${m.precio_2027 || ''}" style="text-align:right;color:#5be58a;font-weight:600" /></td>
      <td class="num">${m.iva || 19}%</td>
      <td>${comparativa}</td>
    </tr>`;
  }).join("");

  // Recolectar cambios en inputs
  tbody.querySelectorAll("[data-c]").forEach(inp => {
    inp.addEventListener("input", (ev) => {
      const tr = ev.target.closest("tr");
      const idx = parseInt(tr.dataset.circIdx, 10);
      const campo = ev.target.dataset.c;
      let val = ev.target.value;
      if (campo.startsWith("precio_")) val = parseInt(String(val).replace(/[^0-9]/g, ""), 10) || 0;
      circularModelos[idx][campo] = val;
    });
  });
}

function generarCircularCSV() {
  const headers = ["Modelo", "Precio_2025", "Precio_2026", "Precio_2027", "IVA"];
  const rows = circularModelos.map(m => [
    (m.modelo || "").replace(/"/g, "''"),
    m.precio_2025 || "",
    m.precio_2026 || "",
    m.precio_2027 || "",
    m.iva || 19,
  ]);
  return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
}

document.getElementById("btnDescargarCircularCSV")?.addEventListener("click", () => {
  const csv = generarCircularCSV();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const fechaSlug = (circularInfo.fecha || "circular").replace(/[^a-zA-Z0-9]/g, "_");
  a.href = url;
  a.download = `precios_${(circularInfo.marca || "").toLowerCase()}_${fechaSlug}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("btnCopiarCircularCSV")?.addEventListener("click", async () => {
  const csv = generarCircularCSV();
  try {
    await navigator.clipboard.writeText(csv);
    showToast("📋 CSV copiado al portapapeles · pega en el Sheet");
  } catch { showToast("No se pudo copiar"); }
});

document.getElementById("btnCerrarCircular")?.addEventListener("click", () => {
  document.getElementById("circularResultado").style.display = "none";
  circularModelos = [];
});

async function loadHistorialPrecios() {
  const wrap = document.getElementById("preciosHistorial");
  if (!wrap) return;
  try {
    const r = await fetch("/api/precios/historial");
    if (!r.ok) return;
    const data = await r.json();
    if (!data.ok || !data.historial || data.historial.length === 0) {
      wrap.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:16px;border:1px dashed var(--line);border-radius:10px;text-align:center">
        Sin actualizaciones todavía.
      </div>`;
      return;
    }
    wrap.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Fecha</th><th>Subido por</th><th>Archivo</th><th>Notas</th><th>Acción</th></tr></thead>
      <tbody>
        ${data.historial.map(h => `<tr>
          <td>${new Date(h.subidoEn).toLocaleString("es-CO")}</td>
          <td>${escapeHtml(h.subidoPor)}</td>
          <td>${escapeHtml(h.originalName)} <span class="muted">(${(h.size/1024).toFixed(0)} KB)</span></td>
          <td>${escapeHtml(h.notas || "—")}</td>
          <td><a href="/precios/${encodeURIComponent(h.archivo)}" target="_blank" style="color:var(--accent-2);text-decoration:underline">Abrir</a></td>
        </tr>`).join("")}
      </tbody>
    </table></div>`;
  } catch (e) { console.error(e); }
}

// ============================================================
//          ORDEN FACTURACIÓN — Upload de documentos
// ============================================================
const docState = { docs: {}, tipos: [], tiposNombre: {}, search: "", verTodos: false };

async function loadDocs() {
  try {
    const url = "/api/docs/lista" + (docState.verTodos ? "?todos=1" : "");
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    if (data.ok) {
      docState.docs = data.docs || {};
      docState.tipos = data.tipos || [];
      docState.tiposNombre = data.tiposNombre || {};
      renderDocs();
      try { renderSoatPendientes(); } catch {}
    }
  } catch (e) { console.error("Error cargando docs:", e); }
}

function renderDocs() {
  const wrap = document.getElementById("docsListWrap");
  if (!wrap) return;
  // Si es contable, usar vista de tabla compacta
  if (currentUser?.rol === "contable") {
    return renderDocsTablaContable();
  }
  const q = (docState.search || "").toLowerCase().trim();
  const entradas = Object.entries(docState.docs).filter(([id, info]) => {
    if (!q) return true;
    return [id, info.cliente || "", info.modelo || ""].some(v => v.toLowerCase().includes(q));
  });
  document.getElementById("docCount").textContent = fmtNum.format(entradas.length);

  if (entradas.length === 0) {
    wrap.innerHTML = `<div style="text-align:center;color:var(--muted);padding:30px;border:1px dashed var(--line);border-radius:12px">
      Sin ventas con documentos todavía. Usa el botón <strong>"+ Subir docs de venta nueva"</strong> para empezar.
    </div>`;
    return;
  }

  // Ordenar por última subida descendente
  entradas.sort((a, b) => {
    const ta = Math.max(0, ...Object.values(a[1].archivos || {}).map(x => new Date(x.subidoEn).getTime() || 0));
    const tb = Math.max(0, ...Object.values(b[1].archivos || {}).map(x => new Date(x.subidoEn).getTime() || 0));
    return tb - ta;
  });

  wrap.innerHTML = entradas.map(([id, info]) => {
    const archivos = info.archivos || {};
    const subidos = docState.tipos.filter(t => archivos[t]).length;
    const total = docState.tipos.length;
    const progClass = subidos === total ? "" : subidos === 0 ? "vacio" : "parcial";
    const slots = docState.tipos.map(tipo => {
      const a = archivos[tipo];
      const nombre = docState.tiposNombre[tipo] || tipo;
      if (a) {
        return `<label class="doc-slot subido">
          <div class="doc-slot-titulo">${escapeHtml(nombre)}</div>
          <div class="doc-slot-estado">✓</div>
          <div class="doc-slot-acciones">
            <a href="/uploads/${encodeURIComponent(id)}/${encodeURIComponent(a.path)}" target="_blank">Ver</a>
            <button class="borrar" data-borrar data-id="${escapeHtml(id)}" data-tipo="${tipo}">Borrar</button>
            <label style="cursor:pointer;color:var(--accent-2);text-decoration:underline">
              Reemplazar
              <input type="file" data-upload data-id="${escapeHtml(id)}" data-tipo="${tipo}" accept="image/*,application/pdf" />
            </label>
          </div>
        </label>`;
      }
      return `<label class="doc-slot vacio">
        <div class="doc-slot-titulo">${escapeHtml(nombre)}</div>
        <div class="doc-slot-estado">⏳</div>
        <div class="doc-slot-acciones">
          <span style="color:var(--accent);text-decoration:underline">Subir archivo</span>
        </div>
        <input type="file" data-upload data-id="${escapeHtml(id)}" data-tipo="${tipo}" accept="image/*,application/pdf" />
      </label>`;
    }).join("");

    // Modo pruebas: cualquier usuario autenticado puede borrar
    const puedeBorrar = true;
    return `<div class="docs-venta-card">
      <div class="docs-venta-head">
        <div>
          <h3>${escapeHtml(info.cliente || "(sin cliente)")} <code>${escapeHtml(id)}</code></h3>
          <div class="docs-venta-sub">${escapeHtml(info.modelo || "")}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="docs-progress ${progClass}">${subidos}/${total} ${subidos === total ? "✓ listo contabilidad" : "subidos"}</span>
          ${puedeBorrar ? `<button class="btn-borrar-venta" data-borrar-venta="${escapeHtml(id)}" title="Borrar esta venta y todos sus documentos">🗑️ Borrar venta</button>` : ""}
        </div>
      </div>
      <div class="docs-slots">${slots}</div>
    </div>`;
  }).join("");

  // Listeners
  wrap.querySelectorAll("input[data-upload]").forEach(inp => {
    inp.addEventListener("change", subirDocHandler);
  });
  wrap.querySelectorAll("button[data-borrar]").forEach(btn => {
    btn.addEventListener("click", borrarDocHandler);
  });
  // Borrar venta completa
  wrap.querySelectorAll("button[data-borrar-venta]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.borrarVenta;
      if (!confirm(`¿Borrar la venta del chasis "${id}" con TODOS sus documentos?\n\nEsta acción no se puede deshacer.`)) return;
      try {
        const r = await fetch(`/api/docs/${encodeURIComponent(id)}`, { method: "DELETE" });
        const data = await r.json();
        if (data.ok) {
          showToast("Venta borrada completa");
          loadDocs();
        } else {
          showToast("Error: " + (data.error || "no se pudo borrar"));
        }
      } catch (e) { showToast("Error: " + e.message); }
    });
  });
}

// ============================================================
//          VISTA CONTABLE — tabla compacta + modal detalle
// ============================================================
let filtroContable = "sin_facturar";  // sin_facturar (default) | facturadas | todos

/**
 * Resuelve TODOS los datos de una venta (chasis) cruzando 4 fuentes:
 *   1) docs-ventas (info que metió quien subió el archivo)
 *   2) preasignaciones (chasis → cliente + crédito)
 *   3) leads registrados (chasis del lead → cliente + asesor)
 *   4) inventario Siigo (chasis → modelo + color + año)
 *
 * Para el asesor, usa el `usuarioNombre` que el backend ya resuelve desde users.json
 * (vía leads). Si no hay lead, intenta inferir del email del subidoPor.
 */
function resolverContextoVenta(id, info) {
  const idUp = String(id || "").toUpperCase().trim();
  const p = preasigState.preasignaciones[id] || preasigState.preasignaciones[idUp];

  // 1) Buscar lead por chasis exacto
  let lead = leadsState.leads.find(l => (l.chasis || "").toUpperCase() === idUp) || null;

  // 2) Si no encontró por chasis, intentar por documento del cliente (si docs lo tiene)
  if (!lead && info?.cedula) {
    const cc = String(info.cedula).replace(/[^0-9]/g, "");
    lead = leadsState.leads.find(l => String(l.documento || "").replace(/[^0-9]/g, "") === cc) || null;
  }

  // 3) Buscar moto en inventario Siigo por chasis
  const motoSiigo = invState.rows.find(r => (r.chasis || "").toUpperCase() === idUp) || null;

  // Email del primer asesor que subió un archivo
  const emailRaw = Object.values(info?.archivos || {})[0]?.subidoPor || "";
  // Resolver email → nombre usando el mapa de leads (backend ya pobla usuarioNombre)
  const lookup = leadsState.leads.find(l => l.usuario === emailRaw);
  const asesorNombre = p?.asesorNombre
    || lead?.usuarioNombre
    || lookup?.usuarioNombre
    || "";

  return {
    cliente: info?.cliente || p?.nombreCliente || lead?.cliente || "",
    documento: info?.cedula || p?.cedulaCliente || lead?.documento || "",
    modelo: info?.modelo
      || (p ? `${p.marca || ""} ${p.modelo || ""}`.trim() : "")
      || (lead ? `${lead.marca || ""} ${lead.modelo || ""}`.trim() : "")
      || (motoSiigo ? `${motoSiigo.marca || ""} ${motoSiigo.modelo || ""}`.trim() : ""),
    color: p?.color || p?.colorMoto || motoSiigo?.color || "",
    motor: p?.motor || motoSiigo?.motor || "",
    asesorNombre,
    asesorRaw: emailRaw ? emailRaw.split("@")[0].toUpperCase() : "",
    lead,
    motoSiigo,
  };
}

function renderDocsTablaContable() {
  const wrap = document.getElementById("docsListWrap");
  if (!wrap) return;
  const q = (docState.search || "").toLowerCase().trim();
  const tipos = docState.tipos || [];
  const totalTipos = tipos.length;

  const entradas = Object.entries(docState.docs).filter(([id, info]) => {
    if (q) {
      const hay = [id, info.cliente || "", info.modelo || ""].some(v => v.toLowerCase().includes(q));
      if (!hay) return false;
    }
    // Factura de venta subida (no cuenta como facturada si está marcada "no aplica")
    const tieneFactura = !!(info.archivos?.facturaVenta && !info.archivos.facturaVenta.noAplica);
    if (filtroContable === "sin_facturar") return !tieneFactura;
    if (filtroContable === "facturadas") return tieneFactura;
    // Compatibilidad con filtros viejos por si los hay
    const completados = tipos.filter(t => info.archivos?.[t]).length;
    if (filtroContable === "pendientes") return completados < totalTipos;
    if (filtroContable === "listos") return completados === totalTipos;
    return true; // "todos"
  });
  document.getElementById("docCount").textContent = fmtNum.format(entradas.length);

  if (entradas.length === 0) {
    let mensaje;
    if (filtroContable === "sin_facturar") mensaje = "✅ ¡No hay ventas pendientes de factura! Todas las ventas ya tienen factura subida.";
    else if (filtroContable === "facturadas") mensaje = "Aún no hay ventas con factura subida.";
    else if (filtroContable === "pendientes") mensaje = "Sin ventas pendientes.";
    else if (filtroContable === "listos") mensaje = "Sin ventas listas para facturar todavía.";
    else mensaje = "Sin ventas registradas con documentos todavía.";
    wrap.innerHTML = `<div style="text-align:center;color:var(--muted);padding:30px;border:1px dashed var(--line);border-radius:12px">${mensaje}</div>`;
    return;
  }

  entradas.sort((a, b) => {
    const ta = Math.max(0, ...Object.values(a[1].archivos || {}).map(x => new Date(x.subidoEn).getTime() || 0));
    const tb = Math.max(0, ...Object.values(b[1].archivos || {}).map(x => new Date(x.subidoEn).getTime() || 0));
    return tb - ta;
  });

  // Etiquetas amigables para cada tipo de documento pendiente
  const accionPorTipo = {
    ordenFac: "📄 Subir orden facturación",
    preaprobado: "💳 Subir preaprobado",
    cedulaFrente: "🆔 Subir cédula frente",
    cedulaReverso: "🆔 Subir cédula reverso",
    comprobante: "💰 Subir comprobante",
    empadronamiento: "📋 Subir empadronamiento",
    facturaVenta: "🧾 HACER FACTURA",
    facturaGps: "📡 Subir factura GPS",
    soat: "🛡️ HACER SOAT",
  };

  let html = `<div class="table-wrap"><table class="tbl-contable">
    <thead><tr>
      <th>Cliente</th><th>Moto</th><th>Chasis</th><th>Asesor</th><th>Próximo paso</th><th></th>
    </tr></thead><tbody>`;
  for (const [id, info] of entradas) {
    // Contar como "completado" tanto los subidos como los marcados "No aplica"
    const completados = tipos.filter(t => info.archivos?.[t]).length;
    // Lista de tipos que faltan (sin archivo ni marca "no aplica")
    const tiposPendientes = tipos.filter(t => !info.archivos?.[t]);
    const listo = tiposPendientes.length === 0;
    const subidosReal = tipos.filter(t => info.archivos?.[t] && !info.archivos[t].noAplica).length;
    const noAplican = tipos.filter(t => info.archivos?.[t]?.noAplica).length;
    // Cruzar info desde tres fuentes: docs-ventas, preasignación, leads, inventario Siigo
    const ctx = resolverContextoVenta(id, info);
    const clienteCell = ctx.cliente
      ? `<strong>${escapeHtml(ctx.cliente)}</strong>${ctx.documento ? `<br><span class="muted" style="font-size:11px">CC ${escapeHtml(ctx.documento)}</span>` : ""}`
      : `<span style="color:var(--bad)">⚠️ Sin lead asociado</span>`;
    const motoCell = ctx.modelo
      ? `<strong>${escapeHtml(ctx.modelo)}</strong>${ctx.color ? `<br><span class="muted" style="font-size:11px">${escapeHtml(ctx.color)}</span>` : ""}`
      : "—";
    const asesorCell = ctx.asesorNombre
      ? `<strong>${escapeHtml(ctx.asesorNombre)}</strong>`
      : `<span class="muted">${escapeHtml(ctx.asesorRaw || "—")}</span>`;

    // Próximo paso descriptivo
    let proximoPaso;
    if (listo) {
      proximoPaso = `<span style="color:#5be58a;font-weight:600">✓ Listo para entregar</span>
        <div class="muted" style="font-size:10.5px">${subidosReal} docs · ${noAplican} no aplica</div>`;
    } else if (tiposPendientes.length === 1) {
      const t = tiposPendientes[0];
      const tag = accionPorTipo[t] || `Subir ${docState.tiposNombre[t] || t}`;
      const esContable = (t === "facturaVenta" || t === "soat" || t === "facturaGps");
      const color = esContable ? "#f7c272" : "#22d3ee";
      proximoPaso = `<strong style="color:${color}">${tag}</strong>`;
    } else {
      // Varios pendientes — destacar el primer crítico de contable si lo hay
      const criticoContable = tiposPendientes.find(t => t === "facturaVenta" || t === "soat");
      if (criticoContable) {
        const tag = accionPorTipo[criticoContable];
        proximoPaso = `<strong style="color:#f7c272">${tag}</strong>
          <div class="muted" style="font-size:10.5px">+ ${tiposPendientes.length - 1} más pendientes</div>`;
      } else {
        proximoPaso = `<span style="color:#22d3ee">${tiposPendientes.length} docs pendientes</span>
          <div class="muted" style="font-size:10.5px">Esperando asesor</div>`;
      }
    }

    html += `<tr class="${listo ? "listo" : ""}" data-detalle-id="${escapeHtml(id)}">
      <td>${clienteCell}</td>
      <td>${motoCell}</td>
      <td><code style="font-size:11px;color:var(--accent-2)">${escapeHtml(id)}</code></td>
      <td>${asesorCell}</td>
      <td>${proximoPaso}</td>
      <td><button class="btn-mini" data-detalle-id="${escapeHtml(id)}">Ver detalle</button></td>
    </tr>`;
  }
  html += "</tbody></table></div>";
  wrap.innerHTML = html;

  wrap.querySelectorAll("[data-detalle-id]").forEach(el => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      abrirDetalleVenta(el.dataset.detalleId);
    });
  });
}

function abrirDetalleVenta(idVenta) {
  const info = docState.docs[idVenta];
  if (!info) return;
  const p = preasigState.preasignaciones[idVenta] || preasigState.preasignaciones[idVenta.toUpperCase()];
  const tipos = docState.tipos || [];
  const ctx = resolverContextoVenta(idVenta, info);

  // Header
  const cliente = ctx.cliente || "(sin cliente)";
  const modelo = ctx.modelo || "—";
  document.getElementById("detalleTitulo").textContent = `${cliente} — ${modelo}`;
  document.getElementById("detalleSubtitulo").innerHTML =
    `Chasis: <code style="color:var(--accent-2)">${escapeHtml(idVenta)}</code>` +
    (ctx.motor ? ` · Motor: <code style="color:var(--muted)">${escapeHtml(ctx.motor)}</code>` : "") +
    (ctx.color ? ` · Color: ${escapeHtml(ctx.color)}` : "") +
    (ctx.asesorNombre ? ` · Asesor: <strong style="color:var(--accent)">${escapeHtml(ctx.asesorNombre)}</strong>` : "");

  // Datos del cliente — combina preasignación + lead + Siigo
  const datosCliente = document.getElementById("detalleDatosCliente");
  const lead = ctx.lead;
  const tieneDatos = p || lead;
  if (tieneDatos) {
    // Fuente del dato (preasignación gana, después lead)
    const get = (campoP, campoL, label) => {
      const valor = (p && p[campoP]) || (lead && lead[campoL]) || "";
      const fuente = (p && p[campoP]) ? "preasig" : (lead && lead[campoL] ? "lead" : "");
      return { valor, fuente, label };
    };
    const fila = [
      get("cedulaCliente", "documento", "Cédula"),
      get("fechaNacimiento", "fechaNacimiento", "F. nacimiento"),
      get("celular", "celular", "Celular"),
      get("numCredito", "numCredito", "# Crédito"),
      get("financiera", "financiera", "Financiera"),
      get("placa", "placa", "Placa"),
    ];
    const gpsLabel = p?.gps ? ({sin:"Sin GPS",instalar:"Instalar",activar:"Activar"})[p.gps] : "—";
    const asesorBlock = ctx.asesorNombre || "—";

    datosCliente.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px 18px">
        ${fila.map(f => `
          <div><span class="muted">${f.label}:</span> <strong>${escapeHtml(f.valor || "—")}</strong>
          ${f.fuente === "lead" ? `<span class="muted" style="font-size:10px">· del lead</span>` : ""}</div>
        `).join("")}
        <div><span class="muted">GPS:</span> <strong>${gpsLabel}</strong></div>
        <div><span class="muted">Asesor:</span> <strong>${escapeHtml(asesorBlock)}</strong></div>
        <div><span class="muted">Origen:</span> <strong>${escapeHtml(lead?.origen || "—")}</strong></div>
      </div>
      ${!p ? `<p class="muted" style="margin:10px 0 0;font-size:12px;color:#f7c272">
        ℹ️ No hay preasignación todavía — los datos vienen del lead registrado. Cuando el asesor cree la preasignación se mostrará más detalle (placa, # crédito, GPS, etc).
      </p>` : ""}`;
  } else {
    datosCliente.innerHTML = `<div style="padding:14px;background:rgba(247,194,114,0.1);border-left:3px solid #f7c272;border-radius:6px">
      <strong style="color:#f7c272">⚠️ Sin lead ni preasignación para este chasis</strong>
      <p class="muted" style="margin:6px 0 0;font-size:13px">
        Este chasis no aparece en los leads ingresados ni en las preasignaciones.<br>
        Verifica que el asesor haya creado el lead en <strong>Ingresar lead/cliente</strong> antes de facturar.
      </p>
    </div>`;
  }

  // Slots
  const slots = document.getElementById("detalleSoportes");
  slots.innerHTML = tipos.map(tipo => {
    const a = info.archivos?.[tipo];
    const nombre = docState.tiposNombre[tipo] || tipo;
    if (a?.noAplica) {
      // Marcado como "No aplica" — ej: Factura GPS si la moto no lleva GPS
      const fecha = a.marcadoEn ? new Date(a.marcadoEn).toLocaleDateString("es-CO") : "—";
      return `<label class="doc-slot subido" style="border-color:rgba(120,120,140,.4);background:rgba(120,120,140,.08)">
        <div class="doc-slot-titulo">${escapeHtml(nombre)}</div>
        <div class="doc-slot-estado" style="color:#aaa">∅</div>
        <div class="doc-slot-acciones">
          <strong style="color:#aaa">No aplica</strong>
        </div>
        <div class="doc-slot-acciones" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:4px">
          <button class="btn-quitar-noaplica" data-quitar-noaplica data-id="${escapeHtml(idVenta)}" data-tipo="${tipo}" style="background:transparent;border:none;color:var(--accent);cursor:pointer;font-size:11px;text-decoration:underline;padding:0">↶ Quitar marca</button>
        </div>
        <span class="fecha-pago">marcado ${fecha}</span>
      </label>`;
    }
    if (a) {
      const fecha = new Date(a.subidoEn).toLocaleDateString("es-CO");
      return `<label class="doc-slot subido">
        <div class="doc-slot-titulo">${escapeHtml(nombre)}</div>
        <div class="doc-slot-estado">✓</div>
        <div class="doc-slot-acciones" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center">
          <a href="/uploads/${encodeURIComponent(idVenta)}/${encodeURIComponent(a.path)}" target="_blank">Ver</a>
          <label style="cursor:pointer;color:var(--accent-2);text-decoration:underline">
            Reemplazar
            <input type="file" data-upload data-id="${escapeHtml(idVenta)}" data-tipo="${tipo}" accept="image/*,application/pdf" style="display:none" />
          </label>
          <button class="btn-borrar-doc" data-borrar-doc data-id="${escapeHtml(idVenta)}" data-tipo="${tipo}" title="Borrar este documento" style="background:transparent;border:none;color:#f87171;cursor:pointer;font-size:12px;text-decoration:underline;padding:0">🗑️ Borrar</button>
        </div>
        <span class="fecha-pago">subido ${fecha}</span>
      </label>`;
    }
    // Slot vacío — para tipos opcionales (facturaGps, soat) ofrecer botón "No aplica"
    const esOpcional = tipo === "facturaGps" || tipo === "empadronamiento";
    return `<label class="doc-slot vacio">
      <div class="doc-slot-titulo">${escapeHtml(nombre)}</div>
      <div class="doc-slot-estado">⏳</div>
      <div class="doc-slot-acciones">
        <span style="color:var(--accent);text-decoration:underline">Subir archivo</span>
      </div>
      <input type="file" data-upload data-id="${escapeHtml(idVenta)}" data-tipo="${tipo}" accept="image/*,application/pdf" />
      ${esOpcional ? `<button class="btn-marcar-noaplica" data-marcar-noaplica data-id="${escapeHtml(idVenta)}" data-tipo="${tipo}" style="background:transparent;border:1px solid rgba(120,120,140,.3);color:#aaa;cursor:pointer;font-size:11px;border-radius:4px;padding:3px 8px;margin-top:4px">∅ No aplica</button>` : ""}
    </label>`;
  }).join("");

  // Listeners de upload en slots vacíos / reemplazar
  slots.querySelectorAll("input[data-upload]").forEach(inp => {
    inp.addEventListener("change", async (ev) => {
      await subirDocHandler(ev);
      // Re-render detalle con datos actualizados
      setTimeout(() => abrirDetalleVenta(idVenta), 500);
    });
  });

  // Listeners de borrar documento individual
  slots.querySelectorAll("[data-borrar-doc]").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const id = btn.dataset.id;
      const tipo = btn.dataset.tipo;
      const nombreDoc = docState.tiposNombre[tipo] || tipo;
      if (!confirm(`¿Borrar el documento "${nombreDoc}"?\n\nDespués lo puedes volver a subir si fue un error.`)) return;
      try {
        const r = await fetch(`/api/docs/${encodeURIComponent(id)}/${encodeURIComponent(tipo)}`, { method: "DELETE" });
        const data = await r.json();
        if (data.ok) {
          showToast(`🗑️ ${nombreDoc} borrado`);
          await loadDocs();
          // Si la venta todavía tiene documentos, re-abrir detalle; sino, cerrar modal
          if (docState.docs?.[id]) {
            abrirDetalleVenta(id);
          } else {
            document.getElementById("modalDetalleVenta")?.classList.remove("show");
          }
        } else {
          showToast("Error: " + (data.error || "no se pudo borrar"));
        }
      } catch (e) { showToast("Error: " + e.message); }
    });
  });

  // Listeners de marcar "No aplica"
  slots.querySelectorAll("[data-marcar-noaplica]").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const id = btn.dataset.id;
      const tipo = btn.dataset.tipo;
      const nombreDoc = docState.tiposNombre[tipo] || tipo;
      if (!confirm(`¿Marcar "${nombreDoc}" como NO APLICA?\n\nNo contará como faltante para esta venta.`)) return;
      try {
        const r = await fetch(`/api/docs/no-aplica/${encodeURIComponent(id)}/${encodeURIComponent(tipo)}`, { method: "POST" });
        const data = await r.json();
        if (data.ok) {
          showToast(`∅ ${nombreDoc} marcado como no aplica`);
          await loadDocs();
          abrirDetalleVenta(id);
        } else {
          showToast("Error: " + (data.error || "no se pudo marcar"));
        }
      } catch (e) { showToast("Error: " + e.message); }
    });
  });

  // Listeners de quitar marca "No aplica"
  slots.querySelectorAll("[data-quitar-noaplica]").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const id = btn.dataset.id;
      const tipo = btn.dataset.tipo;
      try {
        const r = await fetch(`/api/docs/no-aplica/${encodeURIComponent(id)}/${encodeURIComponent(tipo)}`, { method: "DELETE" });
        const data = await r.json();
        if (data.ok) {
          showToast(`↶ Marca quitada`);
          await loadDocs();
          if (docState.docs?.[id]) abrirDetalleVenta(id);
          else document.getElementById("modalDetalleVenta")?.classList.remove("show");
        }
      } catch (e) { showToast("Error: " + e.message); }
    });
  });

  // Estado
  const subidos = tipos.filter(t => info.archivos?.[t]).length;
  const listo = subidos === tipos.length;
  document.getElementById("detalleEstado").innerHTML = listo
    ? `<span style="color:#5be58a;font-weight:700">✓ Listo para facturar (${subidos}/${tipos.length})</span>`
    : `<span style="color:#f7c272">⏳ Faltan ${tipos.length - subidos} documentos (${subidos}/${tipos.length})</span>`;

  document.getElementById("modalDetalleVenta").classList.add("show");
}

document.getElementById("btnCerrarDetalle")?.addEventListener("click", () => document.getElementById("modalDetalleVenta").classList.remove("show"));
document.getElementById("btnCerrarDetalle2")?.addEventListener("click", () => document.getElementById("modalDetalleVenta").classList.remove("show"));

// Filtros contable
document.querySelectorAll(".btn-filtro-contable").forEach(b => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".btn-filtro-contable").forEach(x => x.classList.remove("activo"));
    b.classList.add("activo");
    filtroContable = b.dataset.filtroContable;
    renderDocs();
  });
});

async function subirDocHandler(ev) {
  const inp = ev.target;
  const file = inp.files?.[0];
  if (!file) return;
  const id = inp.dataset.id;
  const tipo = inp.dataset.tipo;
  const slot = inp.closest(".doc-slot");
  slot?.classList.add("subiendo");

  const info = docState.docs[id] || {};
  const fd = new FormData();
  fd.append("idVenta", id);
  fd.append("tipo", tipo);
  fd.append("cliente", info.cliente || "");
  fd.append("modelo", info.modelo || "");
  fd.append("archivo", file);

  try {
    const r = await fetch("/api/docs/upload", { method: "POST", body: fd });
    const data = await r.json();
    if (data.ok) {
      showToast(`✓ ${docState.tiposNombre[tipo]} subido${data.completo ? " · 4/4 LISTO" : ""}`);
      await loadDocs();
    } else {
      showToast("Error: " + (data.error || "no se pudo subir"));
      slot?.classList.remove("subiendo");
    }
  } catch (e) {
    showToast("Error de red: " + e.message);
    slot?.classList.remove("subiendo");
  }
  inp.value = ""; // reset
}

async function borrarDocHandler(ev) {
  const btn = ev.target;
  const id = btn.dataset.id;
  const tipo = btn.dataset.tipo;
  if (!confirm(`¿Borrar el documento "${docState.tiposNombre[tipo]}"?`)) return;
  try {
    const r = await fetch(`/api/docs/${encodeURIComponent(id)}/${tipo}`, { method: "DELETE" });
    const data = await r.json();
    if (data.ok) {
      showToast("Documento borrado");
      await loadDocs();
    } else {
      showToast("Error: " + (data.error || "no se pudo borrar"));
    }
  } catch (e) { showToast("Error: " + e.message); }
}

// Buscador
const docSearchEl = document.getElementById("docSearch");
if (docSearchEl) docSearchEl.addEventListener("input", e => { docState.search = e.target.value; renderDocs(); });

// Toggle "ver todos" (solo admin)
const docVerTodosEl = document.getElementById("docVerTodos");
if (docVerTodosEl) docVerTodosEl.addEventListener("change", e => { docState.verTodos = e.target.checked; loadDocs(); });

// ============================================================
//          QUICK UPLOAD — botones grandes para subir directo
// ============================================================
let quickUploadState = { tipo: null, archivo: null };

function abrirSelectorArchivo(tipo) {
  quickUploadState = { tipo, archivo: null };
  const inp = document.getElementById("quickFileInput");
  inp.value = "";
  inp.click();
}

document.querySelectorAll(".btn-quickup").forEach(btn => {
  btn.addEventListener("click", () => abrirSelectorArchivo(btn.dataset.quickTipo));
});

const quickFileInput = document.getElementById("quickFileInput");
if (quickFileInput) quickFileInput.addEventListener("change", (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  quickUploadState.archivo = file;

  // Mostrar modal pidiendo cliente/chasis
  const modal = document.getElementById("modalChasisRapido");
  const titulo = docState.tiposNombre[quickUploadState.tipo] || quickUploadState.tipo;
  document.getElementById("modalChasisRapidoTitle").textContent = `📤 Subir ${titulo}`;
  document.getElementById("modalChasisArchivo").textContent = file.name;
  document.getElementById("modalChasisRapidoMsg").className = "modal-msg";
  document.getElementById("modalChasisRapidoPreview").innerHTML = "";

  // Construir opciones: cada cliente con preasignación y/o lead
  // Cada option `value` será el identificador real (chasis si existe, cédula si no)
  // y el `label` será el nombre del cliente + info corta para que se vea bonito.
  const dl = document.getElementById("chasisRapidoList");
  const opciones = [];
  const vistos = new Set();

  // 1. Preasignaciones primero (tienen chasis confirmado)
  for (const p of Object.values(preasigState.preasignaciones || {})) {
    if (!p.chasis) continue;
    const key = p.chasis.toUpperCase();
    if (vistos.has(key)) continue;
    vistos.add(key);
    const cli = p.nombreCliente || "(sin nombre)";
    const moto = `${p.marca || ""} ${p.modelo || ""}`.trim() || "(sin moto)";
    opciones.push({ value: p.chasis, label: `${cli} · ${moto} · chasis ${p.chasis}` });
  }
  // 2. Leads sin preasignación (usar cédula como id)
  for (const l of leadsState.leads) {
    const id = (l.chasis || l.documento || "").toUpperCase();
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    const cli = l.cliente || "(sin nombre)";
    const moto = `${l.marca || ""} ${l.modelo || ""}`.trim() || "—";
    const idCorto = l.chasis ? `chasis ${l.chasis}` : `CC ${l.documento || "—"}`;
    opciones.push({ value: l.chasis || l.documento, label: `${cli} · ${moto} · ${idCorto}` });
  }

  dl.innerHTML = opciones
    .map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
    .join("");

  document.getElementById("formChasisRapido").reset();
  modal.classList.add("show");
  setTimeout(() => modal.querySelector('input[name="idVenta"]').focus(), 100);
});

// Resolución en vivo: cuando escribes en el input, busca el cliente y muestra preview
document.querySelector('#formChasisRapido input[name="idVenta"]')?.addEventListener("input", (ev) => {
  const valor = String(ev.target.value || "").trim().toUpperCase();
  const preview = document.getElementById("modalChasisRapidoPreview");
  if (!valor || valor.length < 3) {
    preview.innerHTML = "";
    return;
  }
  // Match exacto contra preasignaciones por chasis
  const p = Object.values(preasigState.preasignaciones || {}).find(p =>
    (p.chasis || "").toUpperCase() === valor
    || (p.cedulaCliente || "").replace(/[^0-9]/g, "") === valor.replace(/[^0-9]/g, "")
    || (p.nombreCliente || "").toUpperCase().includes(valor)
  );
  // Match contra leads
  const l = leadsState.leads.find(l =>
    (l.chasis || "").toUpperCase() === valor
    || String(l.documento || "").replace(/[^0-9]/g, "") === valor.replace(/[^0-9]/g, "")
    || (l.cliente || "").toUpperCase().includes(valor)
  );
  if (p) {
    preview.innerHTML = `✅ <strong>${escapeHtml(p.nombreCliente)}</strong> — ${escapeHtml(p.marca || "")} ${escapeHtml(p.modelo || "")} · chasis ${escapeHtml(p.chasis)}`;
    preview.style.color = "#5be58a";
  } else if (l) {
    preview.innerHTML = `✅ <strong>${escapeHtml(l.cliente)}</strong> — ${escapeHtml(l.marca || "")} ${escapeHtml(l.modelo || "")} · CC ${escapeHtml(l.documento || "—")}`;
    preview.style.color = "#5be58a";
  } else {
    preview.innerHTML = `⚠️ No encontré ese cliente. Se guardará con el ID "${escapeHtml(valor)}"`;
    preview.style.color = "#f7c272";
  }
});

document.getElementById("btnCancelarChasisRapido")?.addEventListener("click", () => {
  document.getElementById("modalChasisRapido").classList.remove("show");
  quickUploadState = { tipo: null, archivo: null };
});

document.getElementById("formChasisRapido")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const idVenta = String(fd.get("idVenta") || "").trim();
  if (!idVenta || !quickUploadState.archivo || !quickUploadState.tipo) return;

  const msg = document.getElementById("modalChasisRapidoMsg");
  const btn = document.getElementById("btnConfirmarChasisRapido");
  btn.disabled = true; btn.textContent = "Subiendo…";
  msg.className = "modal-msg"; msg.textContent = "";

  // Buscar info de preasignación si existe (para cliente/modelo)
  const p = preasigState.preasignaciones[idVenta] || preasigState.preasignaciones[idVenta.toUpperCase()];
  const cliente = p?.nombreCliente || "";
  const modelo = p ? ((p.marca || "") + " " + (p.modelo || "")).trim() : "";

  const upFd = new FormData();
  upFd.append("idVenta", idVenta);
  upFd.append("tipo", quickUploadState.tipo);
  upFd.append("cliente", cliente);
  upFd.append("modelo", modelo);
  upFd.append("archivo", quickUploadState.archivo);

  try {
    const r = await fetch("/api/docs/upload", { method: "POST", body: upFd });
    const data = await r.json();
    if (data.ok) {
      msg.className = "modal-msg ok";
      msg.textContent = `✓ Subido${data.completo ? " · 4/4 LISTO PARA CONTABILIDAD" : ""}`;
      await loadDocs();
      setTimeout(() => {
        document.getElementById("modalChasisRapido").classList.remove("show");
        quickUploadState = { tipo: null, archivo: null };
      }, 1000);
    } else {
      msg.className = "modal-msg err";
      msg.textContent = data.error || "Error al subir";
    }
  } catch (e) {
    msg.className = "modal-msg err";
    msg.textContent = "Error de conexión: " + e.message;
  } finally {
    btn.disabled = false; btn.textContent = "📤 Subir ahora";
  }
});

// ============================================================
//          DESCARGAR IMAGEN DE COMISIONES (para contabilidad)
// ============================================================
function periodoActivo() {
  const filtroMes = state.filters.mes;
  const filtroAnio = state.filters.anio;
  if (filtroMes) return { texto: formatMes(filtroMes), slug: filtroMes };
  if (filtroAnio) return { texto: `Año ${filtroAnio}`, slug: `${filtroAnio}` };
  return { texto: "Todo el periodo", slug: "completo" };
}

function generarVistaImpresion(misRows, periodo) {
  const unidades = misRows.length;
  const monto = misRows.reduce((s, r) => s + r.monto, 0);
  const sinIva = misRows.reduce((s, r) => s + r.precioSinIva, 0);
  const comision = misRows.reduce((s, r) => s + r.comision, 0);
  let cobrada = 0, pendiente = 0, nCobr = 0, nPend = 0;
  for (const r of misRows) {
    if (state.comisionesPagadas[idVenta(r)]?.pagada) { cobrada += r.comision; nCobr++; }
    else { pendiente += r.comision; nPend++; }
  }

  const sorted = [...misRows].sort((a, b) => (b.fecha?.getTime() || 0) - (a.fecha?.getTime() || 0));
  const hoy = new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });
  const nombre = (currentUser?.nombre || "YEIMI") + (currentUser?.apellido ? " " + currentUser.apellido : " LAVERDE");

  const filas = sorted.map(r => {
    const id = idVenta(r);
    const pag = state.comisionesPagadas[id]?.pagada;
    const fechaPago = pag && state.comisionesPagadas[id]?.fechaPago
      ? new Date(state.comisionesPagadas[id].fechaPago).toLocaleDateString("es-CO") : "—";
    return `<tr class="${pag ? 'pagada' : ''}">
      <td>${r.fecha ? r.fecha.toLocaleDateString("es-CO") : "—"}</td>
      <td>${escapeHtml(r.factura || "—")}</td>
      <td>${escapeHtml(r.marca || "—")}</td>
      <td><strong>${escapeHtml(r.modelo || "—")}</strong></td>
      <td>${escapeHtml(r.cliente || "—")}</td>
      <td class="num">${fmtCOP.format(r.monto)}</td>
      <td class="num">${fmtCOP.format(r.precioSinIva)}</td>
      <td class="num"><strong>${fmtCOP.format(r.comision)}</strong></td>
      <td>${pag ? `✓ ${fechaPago}` : 'Pendiente'}</td>
    </tr>`;
  }).join("");

  return `
    <h1>Comisiones · ${escapeHtml(nombre)}</h1>
    <p class="sub">Concesionario Serviautec · Comisión 5% sobre base sin IVA</p>
    <div class="info-row">
      <span><strong>Periodo:</strong> ${escapeHtml(periodo.texto)}</span>
      <span><strong>Generado:</strong> ${hoy}</span>
    </div>
    <div class="kpis-print">
      <div class="kpi-print">
        <div class="lbl">Motos vendidas</div>
        <div class="val">${fmtNum.format(unidades)}</div>
      </div>
      <div class="kpi-print">
        <div class="lbl">Monto total vendido</div>
        <div class="val">${fmtCOP.format(monto)}</div>
      </div>
      <div class="kpi-print destacado">
        <div class="lbl">Comisión total</div>
        <div class="val">${fmtCOP.format(comision)}</div>
      </div>
      <div class="kpi-print pendiente">
        <div class="lbl">⏳ Pendiente de cobro (${nPend})</div>
        <div class="val">${fmtCOP.format(pendiente)}</div>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Factura</th>
          <th>Marca</th>
          <th>Modelo</th>
          <th>Cliente</th>
          <th class="num">Precio venta</th>
          <th class="num">Base sin IVA</th>
          <th class="num">Comisión 5%</th>
          <th>Estado</th>
        </tr>
      </thead>
      <tbody>${filas || '<tr><td colspan="9" style="text-align:center;padding:30px">Sin ventas en este periodo</td></tr>'}</tbody>
    </table>
    <div class="firma">
      <span>Generado automáticamente por dashboard Yeimy Comercial</span>
      <span>Para validar contra Impulsa CRM si requiere</span>
    </div>`;
}

async function descargarComisionesImagen() {
  if (typeof html2canvas === "undefined") {
    showToast("Librería de exportación no cargada. Recarga la página (Ctrl+Shift+R).");
    return;
  }
  const btn = document.getElementById("btnDescargarComisiones");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Generando…";

  try {
    const misRows = state.filtered.filter(r => (r.asesor || "").toUpperCase() === MI_NOMBRE);
    const periodo = periodoActivo();

    // Crear contenedor fuera de pantalla
    const wrap = document.createElement("div");
    wrap.className = "export-wrap";
    wrap.innerHTML = generarVistaImpresion(misRows, periodo);
    document.body.appendChild(wrap);

    // Capturar como canvas
    const canvas = await html2canvas(wrap, { backgroundColor: "#ffffff", scale: 2, logging: false });
    document.body.removeChild(wrap);

    // Descargar
    const link = document.createElement("a");
    link.download = `comisiones-yeimy-${periodo.slug}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    showToast("Imagen descargada ✓");
  } catch (e) {
    console.error(e);
    showToast("Error al generar imagen: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

const btnDescargar = document.getElementById("btnDescargarComisiones");
if (btnDescargar) btnDescargar.addEventListener("click", descargarComisionesImagen);

// ============================================================
//                  SESIÓN / USUARIO / ROL
// ============================================================
let currentUser = null;

async function loadCurrentUser() {
  try {
    const r = await fetch("/api/me");
    if (r.status === 401) { window.location.href = "/login.html"; return null; }
    const data = await r.json();
    if (!data.ok) { window.location.href = "/login.html"; return null; }
    currentUser = data.usuario;
    aplicarRol(currentUser);
    if (data.ambiente) actualizarBadgeAmbiente(data.ambiente);
    if (currentUser.debeChangePass) abrirModalCambioPass();
    return currentUser;
  } catch (e) {
    console.error("Error cargando usuario:", e);
    return null;
  }
}

function aplicarRol(usuario) {
  document.body.classList.remove("role-admin", "role-asesor", "role-contable", "role-dueno", "role-taller", "role-gps_instalar", "role-gps_activar");
  document.body.classList.add("role-" + usuario.rol);

  // User card
  const ini = (usuario.nombre || "?").substring(0, 2).toUpperCase();
  const nameEl = document.getElementById("userName");
  const roleEl = document.getElementById("userRole");
  const avEl = document.getElementById("userAvatar");
  if (nameEl) nameEl.textContent = usuario.nombre + (usuario.apellido ? " " + usuario.apellido : "");
  if (roleEl) {
    roleEl.textContent = ({
      admin: "Administradora",
      asesor: "Asesor",
      contable: "Contabilidad",
      dueno: "Gerencia",
      taller: "Taller",
      gps_instalar: "GPS Instalación",
      gps_activar: "GPS Activación",
    })[usuario.rol] || usuario.rol;
  }
  if (avEl) {
    avEl.textContent = ini;
    avEl.className = "user-avatar " + usuario.rol;
  }

  // Banner asesor
  const bn = document.getElementById("bannerName");
  if (bn) bn.textContent = usuario.nombre;

  // Si es asesor, el item activo del sidebar debe ser Registrar (no Mis ventas que no ve)
  if (usuario.rol === "asesor") {
    document.querySelectorAll(".nav a").forEach(a => a.classList.remove("active"));
    const asesorDefault = document.querySelector('.nav a[href="#registrar"]');
    if (asesorDefault) asesorDefault.classList.add("active");
    document.getElementById("registrar")?.scrollIntoView({ behavior: "instant", block: "start" });
  }
}

function actualizarBadgeAmbiente(ambiente) {
  const badge = document.getElementById("envBadge");
  if (!badge) return;
  badge.textContent = ambiente === "prod" ? "PRODUCCIÓN" : "PRUEBAS";
  badge.classList.remove("env-test", "env-prod");
  badge.classList.add(ambiente === "prod" ? "env-prod" : "env-test");
}

// Logout
const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    if (!confirm("¿Cerrar sesión?")) return;
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login.html";
  });
}

// Modal de cambio de password (primer login)
function abrirModalCambioPass() {
  const m = document.getElementById("changePassModal");
  if (m) m.classList.add("show");
}
function cerrarModalCambioPass() {
  const m = document.getElementById("changePassModal");
  if (m) m.classList.remove("show");
}

const changePassForm = document.getElementById("changePassForm");
if (changePassForm) {
  changePassForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(changePassForm);
    const actual = fd.get("passwordActual");
    const nueva = fd.get("passwordNueva");
    const confirma = fd.get("passwordConfirma");
    const msgEl = document.getElementById("changePassMsg");
    if (nueva !== confirma) {
      msgEl.textContent = "Las claves nuevas no coinciden";
      msgEl.className = "modal-msg err";
      return;
    }
    const btn = document.getElementById("changePassBtn");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const r = await fetch("/api/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passwordActual: actual, passwordNueva: nueva }),
      });
      const data = await r.json();
      if (data.ok) {
        msgEl.textContent = "Clave actualizada. Ya puedes usar el sistema.";
        msgEl.className = "modal-msg ok";
        setTimeout(cerrarModalCambioPass, 1200);
      } else {
        msgEl.textContent = data.error || "No se pudo cambiar la clave";
        msgEl.className = "modal-msg err";
      }
    } catch {
      msgEl.textContent = "Error de conexión";
      msgEl.className = "modal-msg err";
    } finally {
      btn.disabled = false; btn.textContent = "Guardar nueva clave";
    }
  });
}

// ============================================================
//          SESIONES ACTIVAS (solo admin)
// ============================================================
async function loadSesionesActivas() {
  if (currentUser?.rol !== "admin") return;
  try {
    const r = await fetch("/api/admin/sesiones-activas");
    if (!r.ok) return;
    const data = await r.json();
    if (!data.ok) return;
    renderSesionesActivas(data.sesiones || [], data.totalEnLinea || 0);
  } catch (e) { console.warn("[sesiones]", e.message); }
}

function renderSesionesActivas(sesiones, totalEnLinea) {
  const tbody = document.querySelector("#tblSesiones tbody");
  const countEl = document.getElementById("sesionesCount");
  const badge = document.getElementById("sesionesEnLineaBadge");

  if (countEl) countEl.textContent = `${totalEnLinea} en línea`;
  if (badge) {
    if (totalEnLinea > 0) {
      badge.textContent = totalEnLinea;
      badge.style.display = "inline-block";
      badge.title = `${totalEnLinea} usuario(s) en línea`;
    } else { badge.style.display = "none"; }
  }
  if (!tbody) return;

  if (sesiones.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:30px">
      Aún no hay sesiones registradas. Cuando alguien entre, aparecerá aquí.
    </td></tr>`;
    return;
  }

  tbody.innerHTML = sesiones.map(s => {
    const estadoTag = s.enLinea
      ? `<span class="tag tag-contado">● En línea</span>`
      : `<span class="tag" style="background:rgba(120,120,140,.2);color:#aaa">○ Inactivo</span>`;
    const ubicacion = s.ubicacion
      ? `${escapeHtml(s.ubicacion.ciudad || "—")}${s.ubicacion.region ? ", " + escapeHtml(s.ubicacion.region) : ""}${s.ubicacion.pais ? " · " + escapeHtml(s.ubicacion.pais) : ""}`
      : `<span class="muted">Resolviendo…</span>`;
    const isp = s.ubicacion?.isp ? `<div class="muted" style="font-size:10.5px">${escapeHtml(s.ubicacion.isp)}</div>` : "";
    const minAct = s.minSinActividad === 0 ? "ahora mismo" : s.minSinActividad === 1 ? "hace 1 min" : `hace ${s.minSinActividad} min`;
    const sesionHrs = Math.floor(s.sesionDuracionMin / 60);
    const sesionMins = s.sesionDuracionMin % 60;
    const sesionDur = sesionHrs > 0 ? `${sesionHrs}h ${sesionMins}min` : `${sesionMins} min`;
    const rolTag = ({
      admin: '<span class="tag" style="background:rgba(124,92,255,.2);color:#a78bfa">Admin</span>',
      asesor: '<span class="tag" style="background:rgba(34,211,238,.2);color:#22d3ee">Asesor</span>',
      contable: '<span class="tag" style="background:rgba(34,197,94,.2);color:#5be58a">Contable</span>',
      dueno: '<span class="tag" style="background:rgba(59,130,246,.2);color:#60a5fa">Dueño</span>',
      taller: '<span class="tag" style="background:rgba(249,115,22,.2);color:#fb923c">Taller</span>',
      gps_instalar: '<span class="tag" style="background:rgba(6,182,212,.2);color:#22d3ee">GPS Inst.</span>',
      gps_activar: '<span class="tag" style="background:rgba(168,85,247,.2);color:#c084fc">GPS Act.</span>',
    })[s.rol] || s.rol;

    return `<tr>
      <td>${estadoTag}</td>
      <td>
        <strong>${escapeHtml(s.nombre)} ${escapeHtml(s.apellido || "")}</strong>
        <div class="muted" style="font-size:11px">${escapeHtml(s.email)}</div>
      </td>
      <td>${rolTag}</td>
      <td>
        ${ubicacion}
        ${isp}
      </td>
      <td>
        <code style="font-size:11px;color:var(--accent-2)">${escapeHtml(s.ip || "—")}</code>
        ${s.ipPrev ? `<div class="muted" style="font-size:10px">Anterior: ${escapeHtml(s.ipPrev)}</div>` : ""}
      </td>
      <td>
        ${escapeHtml(s.dispositivo)}
        <div class="muted" style="font-size:11px">${escapeHtml(s.navegador)}</div>
      </td>
      <td>
        ${escapeHtml(minAct)}
        <div class="muted" style="font-size:10.5px">${new Date(s.lastSeen).toLocaleTimeString("es-CO", {hour:"2-digit",minute:"2-digit"})}</div>
      </td>
      <td>${escapeHtml(sesionDur)}</td>
    </tr>`;
  }).join("");
}

const btnRefrescarSesiones = document.getElementById("btnRefrescarSesiones");
if (btnRefrescarSesiones) btnRefrescarSesiones.addEventListener("click", () => {
  loadSesionesActivas();
  showToast("↻ Sesiones actualizadas");
});

// Auto-refresh cada 30 segundos
setInterval(() => {
  if (currentUser?.rol === "admin") loadSesionesActivas();
}, 30 * 1000);

// ============================================================
//          MÉTRICAS GERENCIALES (admin + dueño)
// ============================================================
const metricasState = { mesSeleccionado: "" };

function nombreMes(ym) {
  if (!ym) return "—";
  const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const [y, m] = ym.split("-");
  return `${meses[+m - 1]} ${y}`;
}

function renderMetricasGerenciales() {
  const seccion = document.getElementById("metricas");
  if (!seccion || !state?.rows) return;

  // Solo ventas con fecha y monto (no inventario)
  const ventas = state.rows.filter(isSold);
  if (ventas.length === 0) return;

  // Poblar selector de mes
  const selMes = document.getElementById("metricasMes");
  if (selMes && selMes.options.length <= 1) {
    const meses = [...new Set(ventas.map(v => v.mes).filter(Boolean))].sort().reverse();
    selMes.innerHTML = `<option value="">Todos los meses</option>` +
      meses.map(m => `<option value="${m}">${nombreMes(m)}</option>`).join("");
  }

  const mesFiltro = metricasState.mesSeleccionado || "";
  const filtradas = mesFiltro ? ventas.filter(v => v.mes === mesFiltro) : ventas;

  // ===== KPIs principales =====
  const motosVendidas = filtradas.length;
  const ingresosTotales = filtradas.reduce((s, v) => s + (v.monto || 0), 0);
  const utilidadTotal = filtradas.reduce((s, v) => s + (v.utilidad || 0), 0);
  const ticketPromedio = motosVendidas ? ingresosTotales / motosVendidas : 0;

  // Mes actual (del filtro o último mes con ventas)
  const ahora = new Date();
  const mesActualYM = `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,"0")}`;
  const ventasMesActual = ventas.filter(v => v.mes === mesActualYM);
  const motosMesActual = ventasMesActual.length;
  const ingresosMesActual = ventasMesActual.reduce((s, v) => s + (v.monto || 0), 0);

  // Comparar mes actual vs mes anterior
  const mesAnteriorYM = (() => {
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  })();
  const motosMesAnterior = ventas.filter(v => v.mes === mesAnteriorYM).length;
  const variacion = motosMesAnterior ? ((motosMesActual - motosMesActual ? motosMesActual : 0) - motosMesAnterior) / motosMesAnterior * 100 : 0;
  const variacionReal = motosMesAnterior ? ((motosMesActual - motosMesAnterior) / motosMesAnterior * 100) : 0;
  const trendIcon = variacionReal > 0 ? "↑" : variacionReal < 0 ? "↓" : "→";
  const trendCls = variacionReal > 0 ? "good" : variacionReal < 0 ? "warn" : "";

  const kpisHtml = `
    <div class="metric-card ${trendCls}">
      <div class="metric-label">Motos vendidas · ${mesFiltro ? nombreMes(mesFiltro) : nombreMes(mesActualYM)}</div>
      <div class="metric-value">${fmtNum.format(mesFiltro ? motosVendidas : motosMesActual)}</div>
      ${!mesFiltro && motosMesAnterior ? `<div class="metric-trend">${trendIcon} ${Math.abs(variacionReal).toFixed(1)}% vs ${nombreMes(mesAnteriorYM)}</div>` : ""}
    </div>
    <div class="metric-card good">
      <div class="metric-label">Ingresos totales</div>
      <div class="metric-value">${fmtCOP.format(mesFiltro ? ingresosTotales : ingresosMesActual)}</div>
      <div class="metric-trend">${mesFiltro ? "Mes seleccionado" : "Mes actual"}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Ticket promedio</div>
      <div class="metric-value">${fmtCOP.format(ticketPromedio)}</div>
      <div class="metric-trend">por moto</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Ventas totales históricas</div>
      <div class="metric-value">${fmtNum.format(ventas.length)}</div>
      <div class="metric-trend">desde el inicio del registro</div>
    </div>
  `;
  document.getElementById("metricasKpis").innerHTML = kpisHtml;

  // ===== Comparativo últimos 6 meses =====
  const mesesUlt6 = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
    mesesUlt6.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`);
  }
  const tbodyMensual = document.querySelector("#tblMetricasMensual tbody");
  tbodyMensual.innerHTML = mesesUlt6.map(m => {
    const vs = ventas.filter(v => v.mes === m);
    const motos = vs.length;
    const ingreso = vs.reduce((s, v) => s + (v.monto || 0), 0);
    const ticket = motos ? ingreso / motos : 0;
    return `<tr>
      <td><strong>${nombreMes(m)}</strong></td>
      <td class="num">${fmtNum.format(motos)}</td>
      <td class="num">${fmtCOP.format(ingreso)}</td>
      <td class="num">${motos ? fmtCOP.format(ticket) : "—"}</td>
    </tr>`;
  }).join("");

  // ===== Top asesores =====
  const porAsesor = {};
  for (const v of filtradas) {
    const a = v.asesor || "(sin asesor)";
    if (!porAsesor[a]) porAsesor[a] = { motos: 0, ingreso: 0 };
    porAsesor[a].motos++;
    porAsesor[a].ingreso += v.monto || 0;
  }
  const asesoresSorted = Object.entries(porAsesor).sort((a, b) => b[1].motos - a[1].motos);
  const tbodyAsesores = document.querySelector("#tblMetricasAsesores tbody");
  tbodyAsesores.innerHTML = asesoresSorted.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">Sin ventas en el período</td></tr>`
    : asesoresSorted.map(([a, d]) => {
        const pct = motosVendidas ? (d.motos / motosVendidas * 100) : 0;
        return `<tr>
          <td><strong>${escapeHtml(a)}</strong></td>
          <td class="num">${fmtNum.format(d.motos)}</td>
          <td class="num">${fmtCOP.format(d.ingreso)}</td>
          <td class="num">${pct.toFixed(1)}%</td>
        </tr>`;
      }).join("");

  // ===== Top modelos =====
  const porModelo = {};
  for (const v of filtradas) {
    const key = `${v.marca || "—"}|${v.modelo || "—"}`;
    if (!porModelo[key]) porModelo[key] = { marca: v.marca, modelo: v.modelo, unidades: 0 };
    porModelo[key].unidades++;
  }
  const modelosSorted = Object.values(porModelo).sort((a, b) => b.unidades - a.unidades).slice(0, 10);
  const tbodyModelos = document.querySelector("#tblMetricasModelos tbody");
  tbodyModelos.innerHTML = modelosSorted.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">Sin datos</td></tr>`
    : modelosSorted.map(m => {
        const pct = motosVendidas ? (m.unidades / motosVendidas * 100) : 0;
        return `<tr>
          <td><strong>${escapeHtml(m.modelo || "—")}</strong></td>
          <td>${escapeHtml(m.marca || "—")}</td>
          <td class="num">${fmtNum.format(m.unidades)}</td>
          <td class="num">${pct.toFixed(1)}%</td>
        </tr>`;
      }).join("");

  // ===== Estado del flujo operativo =====
  const preasigs = Object.values(preasigState.preasignaciones || {});
  const enPreasig = preasigs.filter(p => !p.estado || p.estado === "pendiente").length;
  const enTaller = preasigs.filter(p => p.estado === "en_taller").length;
  const entregadas = preasigs.filter(p => p.estado === "entregada").length;
  const leadsActivos = leadsState.leads.length;
  const docsCompletos = Object.values(docState.docs || {}).filter(d => {
    const tipos = docState.tipos || [];
    return tipos.every(t => d.archivos?.[t]);
  }).length;
  const inventarioStock = invState.rows.length;

  document.getElementById("metricasFlujo").innerHTML = `
    <div class="metric-card">
      <div class="metric-label">Leads activos en sistema</div>
      <div class="metric-value">${fmtNum.format(leadsActivos)}</div>
      <div class="metric-trend">Ingresados al CRM</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Preasignaciones pendientes</div>
      <div class="metric-value">${fmtNum.format(enPreasig)}</div>
      <div class="metric-trend">Esperando proceso</div>
    </div>
    <div class="metric-card warn">
      <div class="metric-label">Motos en taller</div>
      <div class="metric-value">${fmtNum.format(enTaller)}</div>
      <div class="metric-trend">En preparación</div>
    </div>
    <div class="metric-card good">
      <div class="metric-label">Entregadas a cliente</div>
      <div class="metric-value">${fmtNum.format(entregadas)}</div>
      <div class="metric-trend">Proceso completo</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Inventario disponible</div>
      <div class="metric-value">${fmtNum.format(inventarioStock)}</div>
      <div class="metric-trend">motos en stock</div>
    </div>
    <div class="metric-card good">
      <div class="metric-label">Listos para facturar</div>
      <div class="metric-value">${fmtNum.format(docsCompletos)}</div>
      <div class="metric-trend">Con todos los documentos</div>
    </div>
  `;
}

// Listeners de la sección métricas
const selMetricasMes = document.getElementById("metricasMes");
if (selMetricasMes) selMetricasMes.addEventListener("change", e => {
  metricasState.mesSeleccionado = e.target.value;
  try { renderMetricasGerenciales(); } catch {}
});
const btnRefrescarMet = document.getElementById("btnRefrescarMetricas");
if (btnRefrescarMet) btnRefrescarMet.addEventListener("click", async () => {
  await loadData();
  showToast("Métricas actualizadas");
});

// --- arranque ---
(async () => {
  // PWA: registrar service worker (silencioso si falla)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
  const u = await loadCurrentUser();
  if (!u) return;  // ya redirigió a login
  await loadComisionesPagadas();  // antes de loadData para que la primera render ya muestre pagadas
  loadData();
  setInterval(loadData, REFRESH_MS);
  loadInventario();
  loadPrecios();
  loadDocs();
  loadPreasignaciones();
  loadLeads();
  loadCodigosImpulsa();
  if (currentUser?.rol === "admin") {
    loadHistorialPrecios();
    loadSesionesActivas();
  }
  attachChasisAutocomplete();
})();
