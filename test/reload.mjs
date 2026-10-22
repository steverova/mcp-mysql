/**
 * El CLI y el MCP comparten el archivo de conexiones: un cambio hecho desde la
 * terminal debe verse en el servidor ya arrancado, sin reiniciar OpenCode.
 *
 *   npm run test:reload
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.join(os.tmpdir(), "mcp-mysql-test", "reload.json");
fs.rmSync(STORE, { force: true });
process.env.MCP_MYSQL_STORE = STORE;

const { upsertConnection, removeConnection } = await import("../src/store.js");

let fallos = 0;
const check = (nombre, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${nombre}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) fallos++;
};

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const transporte = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, "src", "index.js")],
  cwd: ROOT,
  stderr: "pipe",
  env: {
    ...process.env,
    MYSQL_USER: "",
    MYSQL_PROMPT_ON_START: "false",
    MCP_MYSQL_NO_BROWSER: "1",
    MCP_MYSQL_STORE: STORE,
  },
});

const cliente = new Client({ name: "reload-test", version: "1.0.0" });
await cliente.connect(transporte);

const llamar = async (name, args = {}) => {
  const r = await cliente.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), texto: (r.content || []).map((c) => c.text).join("\n") };
};

const antes = await llamar("list_connections");
check("arranca sin conexiones", /"total": 0/.test(antes.texto));

// El CLI crea una conexión mientras el servidor está vivo.
upsertConnection(
  "cli_local",
  { host: "127.0.0.1", port: 3306, user: "mcp", password: "x", database: "demo", ssl: false },
  { activar: true },
);
await esperar(1800);

const despues = await llamar("list_connections");
check("el MCP ve la conexión creada por el CLI", /cli_local/.test(despues.texto), despues.texto.replace(/\s+/g, " ").slice(0, 90));

const info = await llamar("connection_info");
check(
  "la conexión nueva exige confirmación de sesión",
  /"requiere_confirmacion": true/.test(info.texto) && /"activa": "cli_local"/.test(info.texto),
  info.texto.replace(/\s+/g, " ").slice(0, 100),
);

const bloqueado = await llamar("list_tables");
check("sin confirmar, la consulta sigue bloqueada", bloqueado.isError && /BD actual: cli_local/.test(bloqueado.texto));

// El CLI borra la conexión: el MCP debe volver a cero.
removeConnection("cli_local");
await esperar(1800);
const vacio = await llamar("list_connections");
check("el MCP ve el borrado hecho por el CLI", /"total": 0/.test(vacio.texto));

await cliente.close();
fs.rmSync(STORE, { force: true });

console.log("");
if (fallos) {
  console.error(`${fallos} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
