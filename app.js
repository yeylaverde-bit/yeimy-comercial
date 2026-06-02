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
      <td class="num">${r.precio2026 ? fmtCOP.format(r.precio2026) : "—"}</td>
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

const invState = { rows: [], filtered: [], search: "", fuente: "—" };

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
    stock: p.stock || 0,
    estado: p.activo ? "DISPONIBLE" : "INACTIVA",
    codigoSiigo: p.codigo || "",
  };
}

async function loadInventario() {
  const warn = document.getElementById("invConfigWarn");
  const fuenteLabel = document.getElementById("invFuenteLabel");
  if (warn) warn.style.display = "none";
  if (fuenteLabel) fuenteLabel.textContent = "cargando…";

  // 1) Fuente primaria: Siigo
  try {
    const res = await fetch("/api/siigo/productos", { cache: "no-store" });
    const data = await res.json();
    if (data.ok && Array.isArray(data.productos)) {
      invState.rows = data.productos
        .map(normalizeSiigoMoto)
        .filter(r => r.modelo)
        .filter(r => r.stock > 0)
        .sort((a, b) => a.modelo.localeCompare(b.modelo));
      invState.fuente = `🧾 Siigo (${invState.rows.length} motos con stock · cache 5min)`;
      if (fuenteLabel) fuenteLabel.textContent = invState.fuente;
      renderInventario();
      // Re-render Orden Facturación: ahora puede cruzar chasis → modelo/motor desde Siigo
      if (docState.docs && Object.keys(docState.docs).length) {
        try { renderDocs(); } catch {}
      }
      return;
    }
  } catch (e) {
    console.warn("[inventario] Siigo falló, intento Sheet…", e.message);
  }

  // 2) Fallback: Google Sheets pestaña inventario
  try {
    const url = INV_CSV_URL + (INV_CSV_URL.includes("?") ? "&" : "?") + "t=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    invState.rows = parsed.data
      .map(normalizeInvRow)
      .filter(r => r.modelo || r.marca)
      .filter(r => r.estado !== "VENDIDA");
    invState.fuente = `📊 Google Sheets (Siigo no disponible)`;
    if (fuenteLabel) fuenteLabel.textContent = invState.fuente;
    renderInventario();
  } catch (e) {
    console.error("Error cargando inventario:", e);
    if (warn) warn.style.display = "block";
    document.querySelector("#tblInventario tbody").innerHTML =
      `<tr><td colspan="10" style="text-align:center;color:var(--bad);padding:20px">Error al cargar inventario.</td></tr>`;
  }
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
    // Fallback: cualquier precio disponible
    return row.precio2026 || row.precio2027 || row.precio2025 || null;
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
    return `<tr>
      <td>${marcaTag}</td>
      <td><strong>${escapeHtml(r.modelo || "—")}</strong></td>
      <td>${escapeHtml(r.anio || "—")}</td>
      <td>${escapeHtml(r.color || "—")}</td>
      <td><code style="font-size:11px;color:var(--muted)">${escapeHtml(r.chasis || "—")}</code></td>
      <td><code style="font-size:11px;color:var(--muted)">${escapeHtml(r.motor || "—")}</code></td>
      <td>${escapeHtml(r.cilindraje || "—")}</td>
      <td class="num" data-role-only="admin contable">${r.costo ? fmtCOP.format(r.costo) : "—"}</td>
      <td class="num"><strong style="color:#5be58a">${precioVenta ? fmtCOP.format(precioVenta) : "—"}</strong></td>
      <td>${escapeHtml(r.estado || "—")}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:20px">Sin resultados.</td></tr>`;
  if (invState.filtered.length > 200) {
    tbody.innerHTML += `<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:10px;font-style:italic">Mostrando primeras 200 de ${invState.filtered.length} filas — refina la búsqueda</td></tr>`;
  }
}

const invSearchEl = document.getElementById("invSearch");
if (invSearchEl) invSearchEl.addEventListener("input", e => { invState.search = e.target.value; renderInventario(); });

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
}

// ============================================================
//          MIS REGISTROS DEL MES — leads ingresados
// ============================================================
const leadsState = { leads: [], filtroMes: "", buscar: "" };

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
  const filtrados = leadsState.leads.filter(l => {
    if (filtroMes && l.ts) {
      const d = new Date(l.ts);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (m !== filtroMes) return false;
    }
    if (q) {
      return [l.cliente, l.documento, l.celular, l.modelo, l.marca, l.email].some(v => (v || "").toLowerCase().includes(q));
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
    const puedeBorrar = currentUser?.rol === "admin" || l.usuario === currentUser?.email;
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
      // Re-render Orden Facturación: ahora puede cruzar info de preasignaciones
      if (docState.docs && Object.keys(docState.docs).length) {
        try { renderDocs(); } catch {}
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
function attachChasisAutocomplete() {
  const f = document.getElementById("formPreasig");
  const chasisInp = f?.querySelector('[name="chasis"]');
  if (!chasisInp) return;
  chasisInp.addEventListener("change", () => {
    const c = chasisInp.value.trim().toUpperCase();
    const moto = (invState.rows || []).find(r => r.chasis === c);
    if (moto) {
      f.querySelector('[name="marca"]').value = moto.marca || "";
      f.querySelector('[name="modelo"]').value = moto.modelo || "";
      f.querySelector('[name="color"]').value = moto.color || "";
    }
  });
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
  const enTaller = Object.values(preasigState.preasignaciones).filter(p => p.estado === "en_taller" || p.estado === "entregada");
  document.getElementById("tallerCount").textContent = fmtNum.format(enTaller.length);

  if (enTaller.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:30px">
      Sin motos en taller. Mueve una preasignación con el botón <strong>"→ A taller"</strong>.
    </td></tr>`;
    return;
  }
  tbody.innerHTML = enTaller.sort((a, b) => (b.actualizadoEn || "").localeCompare(a.actualizadoEn || ""))
    .map(p => {
      const gpsLabel = { sin: "Sin GPS", instalar: "⚙ Instalar", activar: "📡 Activar" }[p.gps] || "—";
      const estadoCls = p.estado === "entregada" ? "tag-contado" : "tag-financiado";
      const estadoTexto = p.estado === "entregada" ? "✓ Entregada" : "🛠 En taller";
      return `<tr ${p.estado === "entregada" ? 'class="row-inactive"' : ""}>
        <td>${escapeHtml(p.placa || "—")}</td>
        <td><code style="font-size:11px;color:var(--accent-2)">${escapeHtml(p.chasis)}</code></td>
        <td><code style="font-size:11px;color:var(--muted)">${escapeHtml(p.motor || "—")}</code></td>
        <td><strong>${escapeHtml(p.marca || "")} ${escapeHtml(p.modelo || "")}</strong></td>
        <td>${escapeHtml(p.nombreCliente || "—")}</td>
        <td>${escapeHtml(p.asesorNombre || "—")}</td>
        <td>${gpsLabel}</td>
        <td><span class="tag ${estadoCls}">${estadoTexto}</span></td>
        <td>
          ${p.estado === "en_taller" ? `<button class="btn-secondary" data-taller-entregar="${escapeHtml(p.chasis)}" style="padding:5px 10px;font-size:11px">✓ Marcar entregada</button>` : ""}
        </td>
      </tr>`;
    }).join("");

  tbody.querySelectorAll("[data-taller-entregar]").forEach(b => {
    b.addEventListener("click", async () => {
      if (!confirm("¿Marcar como entregada al cliente?")) return;
      await cambiarEstadoPreasig(b.dataset.tallerEntregar, "entregada");
    });
  });
}

const tallerVerTodos = document.getElementById("tallerVerTodos");
if (tallerVerTodos) tallerVerTodos.addEventListener("change", e => { preasigState.verTodos = e.target.checked; loadPreasignaciones(); });

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
  if (motos.length === 0) { showToast("No hay motos para confirmar"); return; }
  if (!confirm(`¿Confirmar y agregar ${motos.length} ${motos.length === 1 ? 'moto' : 'motos'} al inventario?`)) return;
  // TODO Fase 2: enviar a backend que escribe en Google Sheets oficial
  // Por ahora muestro mensaje
  showToast(`✓ ${motos.length} motos guardadas (pendiente Google Sheets)`);
  console.log("Motos a confirmar:", motos);
  const msg = document.getElementById("facturaMsg");
  msg.className = "form-msg form-msg-info";
  msg.innerHTML = `📌 <strong>${motos.length} motos listas para subir al Sheets oficial.</strong><br>
    Pendiente: configurar permisos de escritura del Google Sheets con el encargado del concesionario.
    Cuando esté listo, las subimos con un clic.`;
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

    const puedeBorrar = currentUser?.rol === "admin"
      || Object.values(info.archivos || {})[0]?.subidoPor === currentUser?.email;
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
let filtroContable = "todos";  // todos | pendientes | listos

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
    const completados = tipos.filter(t => info.archivos?.[t]).length;
    if (filtroContable === "pendientes") return completados < totalTipos;
    if (filtroContable === "listos") return completados === totalTipos;
    return true;
  });
  document.getElementById("docCount").textContent = fmtNum.format(entradas.length);

  if (entradas.length === 0) {
    wrap.innerHTML = `<div style="text-align:center;color:var(--muted);padding:30px;border:1px dashed var(--line);border-radius:12px">
      ${filtroContable === "pendientes" ? "Sin ventas pendientes." : filtroContable === "listos" ? "Sin ventas listas para facturar todavía." : "Sin ventas registradas con documentos todavía."}
    </div>`;
    return;
  }

  entradas.sort((a, b) => {
    const ta = Math.max(0, ...Object.values(a[1].archivos || {}).map(x => new Date(x.subidoEn).getTime() || 0));
    const tb = Math.max(0, ...Object.values(b[1].archivos || {}).map(x => new Date(x.subidoEn).getTime() || 0));
    return tb - ta;
  });

  let html = `<div class="table-wrap"><table class="tbl-contable">
    <thead><tr>
      <th>Cliente</th><th>Moto</th><th>Chasis</th><th>Asesor</th><th>Soportes</th><th></th>
    </tr></thead><tbody>`;
  for (const [id, info] of entradas) {
    const subidos = tipos.filter(t => info.archivos?.[t]).length;
    const listo = subidos === totalTipos;
    const pct = Math.round((subidos / totalTipos) * 100);
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
    html += `<tr class="${listo ? "listo" : ""}" data-detalle-id="${escapeHtml(id)}">
      <td>${clienteCell}</td>
      <td>${motoCell}</td>
      <td><code style="font-size:11px;color:var(--accent-2)">${escapeHtml(id)}</code></td>
      <td>${asesorCell}</td>
      <td>
        <span class="progreso ${listo ? "listo" : ""}">
          ${subidos}/${totalTipos} ${listo ? "✓" : ""}
          <span class="progreso-bar" style="--prog:${pct}%"></span>
        </span>
      </td>
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
    if (a) {
      const fecha = new Date(a.subidoEn).toLocaleDateString("es-CO");
      return `<label class="doc-slot subido">
        <div class="doc-slot-titulo">${escapeHtml(nombre)}</div>
        <div class="doc-slot-estado">✓</div>
        <div class="doc-slot-acciones">
          <a href="/uploads/${encodeURIComponent(idVenta)}/${encodeURIComponent(a.path)}" target="_blank">Ver/Descargar</a>
        </div>
        <span class="fecha-pago">subido ${fecha}</span>
      </label>`;
    }
    return `<label class="doc-slot vacio">
      <div class="doc-slot-titulo">${escapeHtml(nombre)}</div>
      <div class="doc-slot-estado">⏳</div>
      <div class="doc-slot-acciones">
        <span style="color:var(--accent);text-decoration:underline">Subir archivo</span>
      </div>
      <input type="file" data-upload data-id="${escapeHtml(idVenta)}" data-tipo="${tipo}" accept="image/*,application/pdf" />
    </label>`;
  }).join("");

  // Listeners de upload en slots vacíos
  slots.querySelectorAll("input[data-upload]").forEach(inp => {
    inp.addEventListener("change", async (ev) => {
      await subirDocHandler(ev);
      // Re-render detalle con datos actualizados
      setTimeout(() => abrirDetalleVenta(idVenta), 500);
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

  // Mostrar modal pidiendo SOLO el chasis
  const modal = document.getElementById("modalChasisRapido");
  const titulo = docState.tiposNombre[quickUploadState.tipo] || quickUploadState.tipo;
  document.getElementById("modalChasisRapidoTitle").textContent = `📤 Subir ${titulo}`;
  document.getElementById("modalChasisArchivo").textContent = file.name;
  document.getElementById("modalChasisRapidoMsg").className = "modal-msg";

  // Llenar datalist con preasignaciones existentes
  const dl = document.getElementById("chasisRapidoList");
  dl.innerHTML = Object.values(preasigState.preasignaciones || {})
    .map(p => `<option value="${escapeHtml(p.chasis)}">${escapeHtml(p.nombreCliente || '')} - ${escapeHtml(p.marca || '')} ${escapeHtml(p.modelo || '')}</option>`)
    .join("");

  document.getElementById("formChasisRapido").reset();
  modal.classList.add("show");
  setTimeout(() => modal.querySelector('input[name="idVenta"]').focus(), 100);
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
  document.body.classList.remove("role-admin", "role-asesor", "role-contable");
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
  if (currentUser?.rol === "admin") loadHistorialPrecios();
  attachChasisAutocomplete();
})();
