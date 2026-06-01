// Script para generar/regenerar users.json con claves temporales hasheadas
// Uso: node generar-usuarios.js
// Salida: users.json + impresión de claves en consola (para que Yeimy se las pase a cada asesor)

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const USERS_DEFINITION = [
  {
    email: "yeimy@yeimylaverde.com",
    nombre: "YEIMI",
    apellido: "Laverde",
    rol: "admin",
  },
  {
    email: "Lpcipuc@gmail.com",
    nombre: "JUAN PABLO",
    apellido: "",
    rol: "asesor",
  },
  {
    email: "serviautecmotos101@gmail.com",
    nombre: "ALEJANDRA",
    apellido: "",
    rol: "asesor",
  },
];

const PALABRAS = ["Apache", "Raider", "Bomber", "Ntorq", "Mrx", "Sport", "Hunter", "Switch", "Bet"];
const SIGNOS = ["!", "@", "#", "*"];
function generarClave() {
  const palabra = PALABRAS[Math.floor(Math.random() * PALABRAS.length)];
  const num = String(Math.floor(Math.random() * 900) + 100);
  const signo = SIGNOS[Math.floor(Math.random() * SIGNOS.length)];
  return palabra + num + signo;
}

(async () => {
  const usuarios = [];
  const credenciales = [];

  for (const u of USERS_DEFINITION) {
    const clave = generarClave();
    const hash = await bcrypt.hash(clave, 10);
    usuarios.push({
      email: u.email.toLowerCase(),
      nombre: u.nombre,
      apellido: u.apellido,
      rol: u.rol,
      passwordHash: hash,
      debeChangePass: true,
      creadoEn: new Date().toISOString(),
    });
    credenciales.push({ email: u.email, nombre: u.nombre, rol: u.rol, claveTemp: clave });
  }

  fs.writeFileSync(
    path.join(__dirname, "users.json"),
    JSON.stringify({ usuarios }, null, 2),
    "utf8"
  );

  console.log("");
  console.log("=========================================================");
  console.log("  USUARIOS GENERADOS — ENTREGAR A CADA UNO POR APARTE");
  console.log("=========================================================");
  console.log("");
  for (const c of credenciales) {
    console.log(`  ${c.nombre.padEnd(15)} (${c.rol})`);
    console.log(`    Email: ${c.email}`);
    console.log(`    Clave: ${c.claveTemp}`);
    console.log("");
  }
  console.log("=========================================================");
  console.log("  Estas claves se muestran SOLO esta vez (no se guardan");
  console.log("  en texto plano; en users.json va el hash bcrypt).");
  console.log("  Cada usuario debe cambiar su clave en el primer login.");
  console.log("=========================================================");
  console.log("");
})();
