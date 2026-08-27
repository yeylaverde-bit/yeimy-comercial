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
const Jimp = require("jimp");

const TEMPLATES_DIR = path.join(__dirname, "..", "papeleria-templates");
const COORDS_PATH = path.join(__dirname, "..", "papeleria-coordenadas.json");

// Se re-lee el JSON en cada uso (archivo pequeño). Así, si ajustas una
// coordenada, el cambio aplica sin tener que reiniciar el servidor.
function getCoords() {
  return JSON.parse(fs.readFileSync(COORDS_PATH, "utf8"));
}

/**
 * Mapea los nombres canónicos de campos lógicos a un valor del objeto `datos`.
 * Devuelve string (vacío si no hay nada que escribir).
 */
function valorPara(campo, datos) {
  if (!campo) return "";
  const d = datos || {};
  // En MATRÍCULA INICIAL la moto aún NO tiene placa (la asigna el tránsito),
  // así que los campos de placa van en blanco.
  const esMatriculaInicial = /matricula\s*inicial/i.test(d.tramite || "");
  const mapeo = {
    placa_letras:      esMatriculaInicial ? "" : d.placa_letras,
    placa_numeros:     esMatriculaInicial ? "" : d.placa_numeros,
    marca:             d.marca,
    linea:             d.linea,
    combustible:       d.combustible,
    cilindrada:        d.cilindrada,
    modelo:            d.modelo,
    potencia:          d.potencia,
    motor:             d.motor,
    chasis:            d.chasis,
    color:             d.color,
    direccion:         d.direccion,
    ciudad:            d.ciudad,
    telefono:          d.telefono,
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
    // Fuente: mas grande que antes para que sea legible (12-15 pt segun la altura)
    const fontSize = esX ? 22 : Math.max(12, Math.min(15, def.h * 0.85));
    const font = esX ? helvBold : helv;

    const y = def.y + Math.max(0, (def.h - fontSize) / 2);
    page.drawText(texto, {
      x: def.x + 2,
      y,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
  }

  // Campos extra (color, observaciones, etc.) que no se detectaron automático
  const extras = coords.runt.campos_extra || {};
  for (const [campo, def] of Object.entries(extras)) {
    const texto = valorPara(campo, datos);
    if (!texto) continue;
    page.drawText(String(texto), {
      x: def.x,
      y: def.y,
      size: def.size || 13,
      font: helv,
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

  // Nombre arriba: si es demasiado largo para la raya, achicamos la
  // fuente para que no se salga y se monte con el texto "mayor de edad".
  // Ancho útil ~160 pt (deja margen para no pegarse a la siguiente palabra).
  const ANCHO_RAYA_NOMBRE = 160;
  const sizeBase = C.nombre_arriba.size || 11;
  let sizeNombre = sizeBase;
  while (sizeNombre > 6 && helv.widthOfTextAtSize(nombreCompleto, sizeNombre) > ANCHO_RAYA_NOMBRE) {
    sizeNombre -= 0.5;
  }
  page.drawText(nombreCompleto, {
    x: C.nombre_arriba.x, y: C.nombre_arriba.y,
    size: sizeNombre, font: helv, color: rgb(0,0,0),
  });

  draw(C.ciudad_arriba, d.ciudad || "MEDELLIN");
  draw(C.cc_arriba,    d.cc);

  // Cláusula PRIMERA: solo trámite (NO placa — no se pide llenar aquí)
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
  // Nombre abajo: auto-shrink para que no invada la columna MANDATARIO
  const ANCHO_NOMBRE_ABAJO = 130;
  let sizeNombreAbajo = C.nombre_abajo.size || 11;
  while (sizeNombreAbajo > 6 && helv.widthOfTextAtSize(nombreCompleto, sizeNombreAbajo) > ANCHO_NOMBRE_ABAJO) {
    sizeNombreAbajo -= 0.5;
  }
  page.drawText(nombreCompleto, {
    x: C.nombre_abajo.x, y: C.nombre_abajo.y,
    size: sizeNombreAbajo, font: helv, color: rgb(0,0,0),
  });
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
  return null;
}

/**
 * Extrae la firma del cliente desde la imagen del recibo de inicial.
 *
 * Algoritmo:
 *   1. Carga imagen (JPG / PNG).
 *   2. Convierte a escala de grises.
 *   3. Aísla la mitad inferior de la imagen (la firma siempre va abajo).
 *   4. Threshold: píxeles más oscuros que 110 = tinta de firma.
 *   5. Calcula el bounding box de los píxeles oscuros encontrados.
 *   6. Recorta con padding.
 *   7. Reemplaza el fondo blanco/claro con transparente (alpha 0).
 *   8. Devuelve PNG buffer.
 *
 * Si no encuentra suficientes píxeles oscuros, devuelve null.
 */
async function extraerFirma(reciboBytes, mimeType) {
  if (!reciboBytes) return null;
  // jimp soporta png/jpg directamente; PDF no
  if (/pdf/i.test(mimeType || "")) {
    console.warn("extraerFirma: recibo es PDF, conversión no implementada. Sube imagen.");
    return null;
  }
  try {
    const img = await Jimp.read(Buffer.from(reciboBytes));
    const W = img.bitmap.width;
    const H = img.bitmap.height;

    // Trabajar solo con la mitad inferior (donde típicamente va la firma)
    const yStart = Math.floor(H * 0.40);
    const yEnd = H;

    // Encontrar bounding box de píxeles oscuros (intensidad gris < UMBRAL)
    const UMBRAL = 110;
    let minX = W, minY = H, maxX = 0, maxY = 0;
    let darkCount = 0;
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < W; x++) {
        const idx = img.getPixelIndex(x, y);
        const r = img.bitmap.data[idx];
        const g = img.bitmap.data[idx + 1];
        const b = img.bitmap.data[idx + 2];
        const gris = (r + g + b) / 3;
        if (gris < UMBRAL) {
          darkCount++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    // Mínimo de píxeles oscuros para considerar que hay firma
    if (darkCount < 200) {
      console.warn(`extraerFirma: solo ${darkCount} píxeles oscuros, no parece firma`);
      return null;
    }

    // Padding alrededor del bbox
    const PAD = 10;
    minX = Math.max(0, minX - PAD);
    minY = Math.max(0, minY - PAD);
    maxX = Math.min(W, maxX + PAD);
    maxY = Math.min(H, maxY + PAD);
    const cropW = maxX - minX;
    const cropH = maxY - minY;

    if (cropW < 30 || cropH < 15) {
      console.warn(`extraerFirma: bbox demasiado pequeño ${cropW}x${cropH}`);
      return null;
    }

    // Recortar
    const firmaImg = img.clone().crop(minX, minY, cropW, cropH);

    // Hacer transparente todo lo que NO sea tinta de firma
    firmaImg.scan(0, 0, firmaImg.bitmap.width, firmaImg.bitmap.height, (x, y, idx) => {
      const r = firmaImg.bitmap.data[idx];
      const g = firmaImg.bitmap.data[idx + 1];
      const b = firmaImg.bitmap.data[idx + 2];
      const gris = (r + g + b) / 3;
      if (gris >= UMBRAL) {
        // Fondo → transparente
        firmaImg.bitmap.data[idx + 3] = 0;
      } else {
        // Tinta → forzar azul oscuro como una firma real
        firmaImg.bitmap.data[idx]     = 25;
        firmaImg.bitmap.data[idx + 1] = 35;
        firmaImg.bitmap.data[idx + 2] = 90;
        firmaImg.bitmap.data[idx + 3] = 255;
      }
    });

    const buf = await firmaImg.getBufferAsync(Jimp.MIME_PNG);
    return buf;
  } catch (e) {
    console.error("extraerFirma error:", e.message);
    return null;
  }
}

/**
 * Llena la ORDEN DE PAGO (recibo de abono/inicial) de Yeimy Laverde.
 * @param {Object} datos {cliente, cc, fecha (DD/MM/YYYY), direccion, telefono,
 *                       ciudad, descripcion, valor, numero_orden, vendedor}
 * @returns {Promise<Uint8Array>}
 */
async function llenarSoportePago(datos) {
  const coords = getCoords();
  const pdfBytes = fs.readFileSync(path.join(TEMPLATES_DIR, "soporte_pago.pdf"));
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.getPages()[0];
  const C = coords.soporte_pago.campos;
  const d = datos || {};

  const draw = (def, texto, opts = {}) => {
    if (texto === null || texto === undefined || texto === "") return;
    const size = opts.size || def.size || 10;
    const font = (opts.bold || def.bold) ? helvBold : helv;
    let color = rgb(0, 0, 0);
    if (def.color === "red") color = rgb(0.78, 0.06, 0.18);
    page.drawText(String(texto), { x: def.x, y: def.y, size, font, color });
  };

  const fmtCop = (n) => {
    const v = Number(n) || 0;
    return v.toLocaleString("es-CO");
  };

  // El template trae "ORDEN DE PAGO 4432" pre-impreso. Tapamos ese numero
  // con un rectangulo blanco y escribimos el nuevo encima.
  if (d.numero_orden) {
    page.drawRectangle({
      x: 430, y: 649, width: 55, height: 20,
      color: rgb(1, 1, 1),
    });
    page.drawText(String(d.numero_orden), {
      x: 434, y: 655, size: 12,
      font: helvBold, color: rgb(0.78, 0.06, 0.18),
    });
  }

  // === CABECERA SERVIAUTEC (tapa TODO el bloque YEIMY LAVERDE + logo) ===
  // El template trae el bloque redondo con YEIMY LAVERDE, sus datos de
  // contacto y su logo a la derecha. Tapamos TODO con blanco y ponemos
  // solo el nombre del concesionario centrado.

  // Tapar cabecera completa (bloque texto + logo Yeimy)
  page.drawRectangle({
    x: 130, y: 685, width: 460, height: 90,
    color: rgb(1, 1, 1),
  });

  // Solo el nombre del concesionario, centrado
  const titulo = "SERVIAUTEC CONCESIONARIO";
  const tSize = 14;
  const tWidth = helvBold.widthOfTextAtSize(titulo, tSize);
  const pageW = page.getWidth();
  page.drawText(titulo, {
    x: (pageW - tWidth) / 2,
    y: 725,
    size: tSize, font: helvBold, color: rgb(0, 0, 0),
  });

  // Tapar el parrafo de Bancolombia + declaracion tributaria (cuenta personal Yeimy)
  page.drawRectangle({
    x: 40, y: 130, width: 540, height: 190,
    color: rgb(1, 1, 1),
  });
  // Auto-shrink: reduce el tamaño de fuente si el texto no cabe en su celda.
  // Si a MINSIZE aun no cabe, recorta el texto con ellipsis.
  const drawFit = (def, texto, anchoMax, opts = {}) => {
    if (texto === null || texto === undefined || texto === "") return;
    const baseSize = opts.size || def.size || 10;
    const MINSIZE = opts.minSize || 5;
    const font = (opts.bold || def.bold) ? helvBold : helv;
    let size = baseSize;
    let str = String(texto);
    while (size > MINSIZE && font.widthOfTextAtSize(str, size) > anchoMax) {
      size -= 0.5;
    }
    // Ultimo recurso: si a MINSIZE aun no cabe, recortar
    if (font.widthOfTextAtSize(str, size) > anchoMax) {
      while (str.length > 4 && font.widthOfTextAtSize(str + "...", size) > anchoMax) {
        str = str.slice(0, -1);
      }
      str = str + "...";
    }
    let color = rgb(0, 0, 0);
    if (def.color === "red") color = rgb(0.78, 0.06, 0.18);
    page.drawText(str, { x: def.x, y: def.y, size, font, color });
  };

  drawFit(C.cliente,     (d.cliente   || "").toUpperCase(),     190);
  drawFit(C.cc,          d.cc || "",                            118);
  drawFit(C.fecha,       d.fecha || "",                         100);
  drawFit(C.direccion,   (d.direccion || "").toUpperCase(),     190);
  drawFit(C.telefono,    d.telefono || "",                      118);
  drawFit(C.ciudad,      (d.ciudad || "MEDELLIN").toUpperCase(), 100);
  drawFit(C.descripcion, d.descripcion || "",                   155);
  draw(C.cant,           "1");
  if (d.valor) {
    drawFit(C.valor_unitario, "$ " + fmtCop(d.valor), 90);
    drawFit(C.valor_total,    "$ " + fmtCop(d.valor), 90);
    drawFit(C.subtotal,       fmtCop(d.valor),        90);
    drawFit(C.total,          fmtCop(d.valor),        90, { bold: true });
  }
  drawFit(C.recibi_nombre, (d.cliente || "").toUpperCase(), 180);
  drawFit(C.recibi_cc,     d.cc || "",                      100);
  drawFit(C.vendedor,      (d.vendedor || "").toUpperCase(), 130);

  return await pdfDoc.save();
}

module.exports = {
  llenarRUNT,
  llenarMandato,
  llenarSoportePago,
  ensamblarPaquete,
  imagenAPDF,
  aPDF,
  generarFirmaDemo,
  extraerFirma,
};
