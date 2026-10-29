/**
 * Local web form test (cross-platform, no real browser).
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
process.env.MCP_MYSQL_LANG = "en";
process.env.MCP_MYSQL_FORM_URL_FILE = URLFILE;

fs.rmSync(STORE, { force: true });
fs.rmSync(URLFILE, { force: true });

const { openForm } = await import("../src/webform.js");
const { loadStore } = await import("../src/store.js");

let failures = 0;
const check = (name, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FAIL"} ${name}${detalle ? " -> " + detalle : ""}`);
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
check("test mode does not open a browser", form.browserOpened === false);
check("writes the URL file for scripts", fs.existsSync(URLFILE));

const base = `http://127.0.0.1:${form.port}`;
const token = new URL(form.url).searchParams.get("token");

const missingToken = await fetch(`${base}/`);
check("GET without token -> 403", missingToken.status === 403, String(missingToken.status));

const conToken = await fetch(form.url);
const html = await conToken.text();
check("the form is served with the token", conToken.status === 200 && html.includes("New MySQL connection"));

const postInvalido = await fetch(`${base}/save`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: "token=falso&name=x&host=h&port=3306&user=u",
});
check("POST with a foreign token -> 403", postInvalido.status === 403, String(postInvalido.status));

const missingUser = await fetch(`${base}/save`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token, name: "ventas", host: "db", port: "3306", user: "" }).toString(),
});
check("POST without user -> 400", missingUser.status === 400, String(missingUser.status));

const invalidName = await fetch(`${base}/save`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token, name: "mal;name", host: "db", port: "3306", user: "mcp" }).toString(),
});
check("POST with invalid name -> 400", invalidName.status === 400, String(invalidName.status));

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
check("valid POST -> 200 with confirmation", good.status === 200 && /Connection saved/.test(htmlOk));

const result = await Promise.race([
  alTerminar,
  new Promise((_, rechazar) => setTimeout(() => rechazar(new Error("timeout waiting onDone")), 5000)),
]);
check("onDone reports the connection", result.ok === true && result.name === "ventas");

const store = loadStore();
check("the connection was saved", store.connections.ventas?.user === "mcp", JSON.stringify(store.connections.ventas));
check("became active", store.active === "ventas", store.active);
check("saved TLS and database", store.connections.ventas.ssl === true && store.connections.ventas.database === "ventas");

fs.rmSync(STORE, { force: true });
fs.rmSync(URLFILE, { force: true });

console.log("");
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("All tests passed");
