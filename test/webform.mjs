/**
 * Prueba del form web local (multiplataforma, sin navegador real).
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
process.env.MCP_MYSQL_LANG = "es";
process.env.MCP_MYSQL_FORM_URL_FILE = URLFILE;

fs.rmSync(STORE, { force: true });
fs.rmSync(URLFILE, { force: true });

const { openForm } = await import("../src/webform.js");
const { loadStore } = await import("../src/store.js");

let failures = 0;
const check = (name, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${name}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) failures++;
};

let resolver;
const alTerminar = new Promise((r) => {
  resolver = r;
});

const form = await openForm({
  prefill: { name: "local", host: "127.0.0.1", port: 3306 },
  connections: [],
  onDone: (result) => resolver(result),
});

check(
  "devuelve una URL local con token",
  /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/.test(form.url),
  form.url,
);
check("modo prueba no abre navegador", form.browserOpened === false);
check("escribe el file de URL para scripts", fs.existsSync(URLFILE));

const base = `http://127.0.0.1:${form.port}`;
const token = new URL(form.url).searchParams.get("token");

const sinToken = await fetch(`${base}/`);
check("GET sin token → 403", sinToken.status === 403, String(sinToken.status));

const conToken = await fetch(form.url);
const html = await conToken.text();
check("el form se sirve con el token", conToken.status === 200 && html.includes("Nueva conexión MySQL"));

const postInvalido = await fetch(`${base}/save`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: "token=falso&name=x&host=h&port=3306&user=u",
});
check("POST con token ajeno → 403", postInvalido.status === 403, String(postInvalido.status));

const sinUsuario = await fetch(`${base}/save`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token, name: "ventas", host: "db", port: "3306", user: "" }).toString(),
});
check("POST sin user → 400", sinUsuario.status === 400, String(sinUsuario.status));

const nombreInvalido = await fetch(`${base}/save`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token, name: "mal;name", host: "db", port: "3306", user: "mcp" }).toString(),
});
check("POST con name inválido → 400", nombreInvalido.status === 400, String(nombreInvalido.status));

const good = await fetch(`${base}/save`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    token,
    name: "ventas",
    host: "db.interna",
    port: "3307",
    user: "mcp",
    password: "secreto",
    database: "ventas",
    ssl: "1",
  }).toString(),
});
const htmlOk = await good.text();
check("POST válido → 200 con confirmación", good.status === 200 && /Conexión guardada/.test(htmlOk));

const result = await Promise.race([
  alTerminar,
  new Promise((_, rechazar) => setTimeout(() => rechazar(new Error("timeout esperando onDone")), 5000)),
]);
check("onDone informa la conexión", result.ok === true && result.name === "ventas");

const store = loadStore();
check("la conexión quedó saved", store.connections.ventas?.user === "mcp", JSON.stringify(store.connections.ventas));
check("quedó como active", store.active === "ventas", store.active);
check("guardó TLS y base", store.connections.ventas.ssl === true && store.connections.ventas.database === "ventas");

fs.rmSync(STORE, { force: true });
fs.rmSync(URLFILE, { force: true });

console.log("");
if (failures) {
  console.error(`${failures} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
