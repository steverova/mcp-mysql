/**
 * Prueba del formulario web local (multiplataforma, sin navegador real).
 *
 *   npm run test:form
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.tmpdir(), "mcp-mysql-test");
const STORE = path.join(DIR, "webform.json");
const URLFILE = path.join(DIR, "webform.url");

process.env.MCP_MYSQL_STORE = STORE;
process.env.MCP_MYSQL_NO_BROWSER = "1";
process.env.MCP_MYSQL_FORM_URL_FILE = URLFILE;

fs.rmSync(STORE, { force: true });
fs.rmSync(URLFILE, { force: true });

const { abrirFormulario } = await import("../src/webform.js");
const { loadStore } = await import("../src/store.js");

let fallos = 0;
const check = (nombre, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${nombre}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) fallos++;
};

let resolver;
const alTerminar = new Promise((r) => {
  resolver = r;
});

const formulario = await abrirFormulario({
  prefill: { nombre: "local", host: "127.0.0.1", port: 3306 },
  conexiones: [],
  onDone: (resultado) => resolver(resultado),
});

check(
  "devuelve una URL local con token",
  /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/.test(formulario.url),
  formulario.url,
);
check("modo prueba no abre navegador", formulario.navegador_abierto === false);
check("escribe el archivo de URL para scripts", fs.existsSync(URLFILE));

const base = `http://127.0.0.1:${formulario.puerto}`;
const token = new URL(formulario.url).searchParams.get("token");

const sinToken = await fetch(`${base}/`);
check("GET sin token → 403", sinToken.status === 403, String(sinToken.status));

const conToken = await fetch(formulario.url);
const html = await conToken.text();
check("el formulario se sirve con el token", conToken.status === 200 && html.includes("Nueva conexión MySQL"));

const postInvalido = await fetch(`${base}/guardar`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: "token=falso&nombre=x&host=h&port=3306&user=u",
});
check("POST con token ajeno → 403", postInvalido.status === 403, String(postInvalido.status));

const sinUsuario = await fetch(`${base}/guardar`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token, nombre: "ventas", host: "db", port: "3306", user: "" }).toString(),
});
check("POST sin usuario → 400", sinUsuario.status === 400, String(sinUsuario.status));

const nombreInvalido = await fetch(`${base}/guardar`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token, nombre: "mal;nombre", host: "db", port: "3306", user: "mcp" }).toString(),
});
check("POST con nombre inválido → 400", nombreInvalido.status === 400, String(nombreInvalido.status));

const bueno = await fetch(`${base}/guardar`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    token,
    nombre: "ventas",
    host: "db.interna",
    port: "3307",
    user: "mcp",
    password: "secreto",
    database: "ventas",
    ssl: "1",
  }).toString(),
});
const htmlOk = await bueno.text();
check("POST válido → 200 con confirmación", bueno.status === 200 && /Conexión guardada/.test(htmlOk));

const resultado = await Promise.race([
  alTerminar,
  new Promise((_, rechazar) => setTimeout(() => rechazar(new Error("timeout esperando onDone")), 5000)),
]);
check("onDone informa la conexión", resultado.ok === true && resultado.nombre === "ventas");

const store = loadStore();
check("la conexión quedó guardada", store.connections.ventas?.user === "mcp", JSON.stringify(store.connections.ventas));
check("quedó como activa", store.active === "ventas", store.active);
check("guardó TLS y base", store.connections.ventas.ssl === true && store.connections.ventas.database === "ventas");

fs.rmSync(STORE, { force: true });
fs.rmSync(URLFILE, { force: true });

console.log("");
if (fallos) {
  console.error(`${fallos} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
