function parsearValorInicial(observaciones) {
  if (!observaciones) return null;
  const t = String(observaciones).toLowerCase();
  const patrones = [
    /(?:inicial|abono|cuota\s*inicial)[^0-9]*(\$?\s*[\d.,]+)/i,
    /\$\s*([\d.,]+)/,
  ];
  for (const p of patrones) {
    const m = t.match(p);
    if (m) {
      const num = m[1].replace(/[^\d]/g, "");
      const val = parseInt(num, 10);
      if (val > 0) return val;
    }
  }
  return null;
}

const tests = [
  ["cliente aprobado por Roda, inicial de $2.100.000", 2100000],
  ["abono 500.000", 500000],
  ["inicial 2173000", 2173000],
  ["aprobado credibanco inicial $1550000", 1550000],
  ["cliente listo, cuota inicial $3.000.000 aprobada", 3000000],
  ["observaciones sin valor", null],
  ["inicial: 1.800.000", 1800000],
  ["aprobado, entrega 750000 al recibir", null],  // "entrega" no matching keyword
];

let pass = 0, fail = 0;
for (const [txt, expected] of tests) {
  const got = parsearValorInicial(txt);
  const ok = got === expected;
  console.log(ok ? "PASS" : "FAIL", `[${txt}] => ${got} (esperado ${expected})`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass+fail} tests passed`);
