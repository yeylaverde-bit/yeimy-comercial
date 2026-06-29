/**
 * Módulo de generación de papelería con pdf-lib.
 *
 * Funciones:
 *   - llenarRUNT(datos, firmaPngBytes)          → Buffer del RUNT lleno
 *   - llenarMandato(datos, firmaPngBytes)       → Buffer del mandato lleno
 *   - ensamblarPaquete(buffersOrdenados)        → Buffer del paquete unido
 *   - generarFirmaDemo(nombre)                  → Buffer PNG de firma cursiva
 *
 * Coordenadas vienen de papeleria-coordenadas.json (generado por el script
 * Python de detección de zonas amarillas). El JSON ya tiene mapeo R# → campo.
 */

const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");

const TEMPLATES_DIR = path.join(__dirname, "..", "papeleria-templates");
const COORDS_PATH = path.join(__dirname, "..", "papeleria-coordenadas.json");

// Carga perezosa de la config para que el server no la lea hasta usarla
let _coords = null;
function getCoords() {
  if (!_coords) _coords = JSON.parse(fs.readFileSync(COORDS_PATH, "utf8"));
  return _coords;
}

/**
 * Mapea los nombres canónicos de campos lógicos a un valor del objeto `datos`.
 * Devuelve string (vacío si no hay nada que escribir).
 */
function valorPara(campo, datos) {
  if (!campo) return "";
  const d = datos || {};
  const mapeo = {
    placa_letras:      d.placa_letras,
    placa_numeros:     d.placa_numeros,
    marca:             d.marca,
    linea:             d.linea,
    combustible:       d.combustible,
    cilindrada:        d.cilindrada,
    modelo:            d.modelo,
    modelo_alt:        d.modelo,
    potencia:          d.potencia,
    motor:             d.motor,
    chasis:            d.chasis,
    primer_apellido:   d.primer_apellido,
    segundo_apellido:  d.segundo_apellido,
    nombres:           d.nombres,
    numero_documento:  d.cc,
    tipo_doc_cc:       d.cc ? "CC" : "",
    tipo_servicio:     d.tipo_servicio || "PARTICULAR",
    observaciones:     d.observaciones || "",
    motocicleta_check: d.clase_vehiculo && /motocicleta/i.test(d.clase_vehiculo) ? "X" : "",
  };
  return String(mapeo[campo] ?? "");
}

/**
 * Llena el formulario RUNT con los datos provistos.
 * @param {Object} datos - cliente y moto combinados (ver mapeo en valorPara)
 * @param {Buffer|Uint8Array|null} firmaPngBytes - firma del cliente
 * @returns {Promise<Uint8Array>} - bytes del PDF resultante
 */
async function llenarRUNT(datos, firmaPngBytes) {
  const coords = getCoords();
  const pdfBytes = fs.readFileSync(path.join(TEMPLATES_DIR, "runt.pdf"));
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.getPages()[0];

  // Recorrer las regiones del RUNT y dibujar el valor correspondiente
  for (const [rId, def] of Object.entries(coords.runt.regiones)) {
    const texto = valorPara(def.campo, datos);
    if (!texto) continue;

    const esX = texto === "X";
    const fontSize = esX ? 16 : Math.max(8, Math.min(11, def.h * 0.6));
    const font = esX ? helvBold : helv;

    // Centrado vertical básico dentro del rectángulo amarillo
    const y = def.y + Math.max(0, (def.h - fontSize) / 2);
    page.drawText(texto, {
      x: def.x + 2,
      y,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
  }

  // Estampar firma del propietario (sección 21)
  if (firmaPngBytes) {
    try {
      const firmaImg = await pdfDoc.embedPng(firmaPngBytes);
      const f = coords.runt.firma_propietario;
      page.drawImage(firmaImg, { x: f.x, y: f.y, width: f.w, height: f.h });
    } catch (e) {
      console.warn("No se pudo embeder firma en RUNT:", e.message);
    }
  }

  return await pdfDoc.save();
}

/**
 * Llena el CONTRATO DE MANDATO de EMTRASUR.
 */
async function llenarMandato(datos, firmaPngBytes) {
  const coords = getCoords();
  const pdfBytes = fs.readFileSync(path.join(TEMPLATES_DIR, "mandato.pdf"));
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.getPages()[0];
  const C = coords.mandato.campos;
  const d = datos || {};
  const nombreCompleto = [d.nombres, d.primer_apellido, d.segundo_apellido]
    .filter(Boolean).join(" ").trim();

  const draw = (def, texto, opts = {}) => {
    if (texto === null || texto === undefined || texto === "") return;
    const fontSize = opts.size || def.size || 11;
    const font = opts.bold ? helvBold : helv;
    page.drawText(String(texto), {
      x: def.x, y: def.y, size: fontSize, font, color: rgb(0, 0, 0),
    });
  };

  // Encabezado
  draw(C.fecha_dia,    d.fecha_dia);
  draw(C.fecha_mes,    d.fecha_mes_letra || d.fecha_mes);
  draw(C.fecha_anio,   d.fecha_anio);
  draw(C.nombre_arriba, nombreCompleto);
  draw(C.ciudad_arriba, d.ciudad || "MEDELLIN");
  draw(C.cc_arriba,    d.cc);

  // Cláusula PRIMERA
  draw(C.tramite,      d.tramite || "MATRICULA INICIAL");

  // ACEPTO (marca con X)
  draw(C.acepto_x,     "X", { bold: true, size: 16 });

  // Bloque MANDANTE abajo
  if (firmaPngBytes) {
    try {
      const firmaImg = await pdfDoc.embedPng(firmaPngBytes);
      const f = C.firma_mandante;
      page.drawImage(firmaImg, { x: f.x, y: f.y, width: f.w, height: f.h });
    } catch (e) {
      console.warn("No se pudo embeder firma en Mandato:", e.message);
    }
  }
  draw(C.nombre_abajo, nombreCompleto);
  draw(C.cc_abajo,     d.cc);
  draw(C.tel_abajo,    d.telefono);
  draw(C.dir_abajo,    d.direccion);

  return await pdfDoc.save();
}

/**
 * Une múltiples PDFs (Uint8Array o Buffer) en uno solo, en orden.
 * Cada item puede ser:
 *   - Uint8Array / Buffer con bytes de un PDF
 *   - null/undefined (se ignora)
 */
async function ensamblarPaquete(items) {
  const out = await PDFDocument.create();
  for (const item of items) {
    if (!item) continue;
    try {
      const src = await PDFDocument.load(item);
      const copied = await out.copyPages(src, src.getPageIndices());
      for (const p of copied) out.addPage(p);
    } catch (e) {
      console.warn("Saltando item no-PDF en ensamblarPaquete:", e.message);
    }
  }
  return await out.save();
}

/**
 * Convierte una imagen (PNG o JPG) a un PDF de una sola página tamaño carta
 * con la imagen centrada y escalada para caber. Útil para anexar fotos de
 * cédula, plaquetas, recibos al paquete final.
 */
async function imagenAPDF(imageBytes, mimeType) {
  const doc = await PDFDocument.create();
  const isPng = /png/i.test(mimeType || "");
  const img = isPng ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes);
  const PW = 612, PH = 792;  // Letter portrait
  const page = doc.addPage([PW, PH]);
  const ratio = Math.min(PW / img.width, PH / img.height) * 0.95;
  const w = img.width * ratio;
  const h = img.height * ratio;
  page.drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
  return await doc.save();
}

/**
 * Acepta bytes de un archivo + mimeType. Si es PDF devuelve los bytes tal cual.
 * Si es imagen, genera un PDF de una página con la imagen.
 */
async function aPDF(bytes, mimeType) {
  if (!bytes) return null;
  if ((mimeType || "").toLowerCase() === "application/pdf") return bytes;
  return await imagenAPDF(bytes, mimeType);
}

/**
 * Genera una firma "manuscrita" demo en PNG con fondo transparente.
 * Reemplázalo eventualmente por la firma real extraída del recibo.
 */
async function generarFirmaDemo(nombre = "Firma") {
  // pdf-lib no genera PNGs; usamos un truco: un PDF con texto y lo convertimos
  // visualmente. En producción la firma viene de un PNG real cargado.
  // Por ahora devolvemos null y el código superior simplemente no estampa firma.
  return null;
}

module.exports = {
  llenarRUNT,
  llenarMandato,
  ensamblarPaquete,
  imagenAPDF,
  aPDF,
  generarFirmaDemo,
};
