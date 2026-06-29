/**
 * Test del módulo papeleria-pdf con datos demo del ejemplo Luis Miguel.
 * Genera 3 PDFs en /tmp para inspección visual:
 *   - runt-test.pdf
 *   - mandato-test.pdf
 *   - paquete-test.pdf (los 2 unidos)
 */
const fs = require("fs");
const path = require("path");
const { llenarRUNT, llenarMandato, ensamblarPaquete } = require("./papeleria-pdf");

const OUT_DIR = path.join(__dirname, "..", "papeleria-test-out");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Datos demo basados en empadronamiento + cédula del ejemplo Luis Miguel
const DATOS = {
  // De la cédula
  primer_apellido: "TABLERA",
  segundo_apellido: "MARTINEZ",
  nombres: "LUIS MIGUEL",
  cc: "1383115",
  // Del empadronamiento
  clase_vehiculo: "MOTOCICLETA",
  marca: "TVS",
  linea: "APACHE 160 FI ABS NG",
  modelo: "2027",
  cilindrada: "160",
  potencia: "17",
  color: "NEGRO NEBULOSA",
  motor: "HE5AV2XA2372",
  chasis: "9FL37GE54VDF19429",
  combustible: "GASOLINA",
  tipo_servicio: "PARTICULAR",
  // Manual / de la venta
  ciudad: "MEDELLIN",
  direccion: "CR 53 # 24-65",
  telefono: "3024676064",
  placa_letras: "KDA",
  placa_numeros: "34J",
  observaciones: "MATRICULA INICIAL - VEHICULO NUEVO",
  fecha_dia: "28",
  fecha_mes_letra: "Junio",
  fecha_anio: "2026",
  tramite: "MATRICULA INICIAL",
};

async function run() {
  console.log("Generando RUNT...");
  const runt = await llenarRUNT(DATOS, null);
  fs.writeFileSync(path.join(OUT_DIR, "runt-test.pdf"), runt);
  console.log(`  OK (${(runt.length / 1024).toFixed(0)} KB)`);

  console.log("Generando Mandato...");
  const mandato = await llenarMandato(DATOS, null);
  fs.writeFileSync(path.join(OUT_DIR, "mandato-test.pdf"), mandato);
  console.log(`  OK (${(mandato.length / 1024).toFixed(0)} KB)`);

  console.log("Ensamblando paquete (runt + mandato)...");
  const paquete = await ensamblarPaquete([runt, mandato]);
  fs.writeFileSync(path.join(OUT_DIR, "paquete-test.pdf"), paquete);
  console.log(`  OK (${(paquete.length / 1024).toFixed(0)} KB)`);

  console.log(`\nResultados en: ${OUT_DIR}`);
}

run().catch(e => {
  console.error("Error:", e);
  process.exit(1);
});
