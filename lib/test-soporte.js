const fs = require("fs");
const path = require("path");
const { llenarSoportePago } = require("./papeleria-pdf");

(async () => {
  const bytes = await llenarSoportePago({
    numero_orden: "4433",
    cliente:      "KEISTEN DANIEL CABAS",
    cc:           "5288024",
    fecha:        "14/08/2026",
    direccion:    "CL 51 # 56-18",
    telefono:     "3146058998",
    ciudad:       "BELLO",
    descripcion:  "Abono inicial moto TVS APACHE 160 FI RACING",
    valor:        2173000,
    vendedor:     "YEIMY LAVERDE",
  });
  const out = path.join(__dirname, "..", "papeleria-test-out", "soporte-pago-test.pdf");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log("OK", out, "(" + (bytes.length/1024).toFixed(0) + " KB)");
})().catch(e => { console.error(e); process.exit(1); });
