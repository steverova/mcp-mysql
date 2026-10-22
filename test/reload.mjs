/**
 * El CLI y el MCP comparten el file de connections: un cambio hecho desde la
 * terminal debe verse en el serverInfo ya arrancado, sin reiniciar OpenCode.
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

let failures = 0;
const check = (name, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${name}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    MCP_MYSQL_LANG: "es",
    MCP_MYSQL_STORE: STORE,
  },
});

const cliente = new Client({ name: "reload-test", version: "1.0.0" });
await cliente.connect(transporte);

const callCli = async (name, args = {}) => {
  const r = await cliente.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), texto: (r.content || []).map((c) => c.text).join("\n") };
};

const before = await callCli("list_connections");
check("arranca sin connections", /"total": 0/.test(before.texto));

// El CLI crea una conexión mientras el serverInfo está vivo.
upsertConnection(
  "cli_local",
  { host: "127.0.0.1", port: 3306, user: "mcp", password: "x", database: "demo", ssl: false },
  { activar: true },
);
await sleep(1800);

const after = await callCli("list_connections");
check("el MCP ve la conexión creada por el CLI", /cli_local/.test(after.texto), after.texto.replace(/\s+/g, " ").slice(0, 90));

const info = await callCli("connection_info");
check(
  "la conexión nueva exige confirmación de sesión",
  /"requiresConfirmation": true/.test(info.texto) && /"active": "cli_local"/.test(info.texto),
  info.texto.replace(/\s+/g, " ").slice(0, 100),
);

const bloqueado = await callCli("list_tables");
check("sin confirmar, la consulta sigue bloqueada", bloqueado.isError && /BD actual: cli_local/.test(bloqueado.texto));

// El CLI borra la conexión: el MCP debe volver a cero.
removeConnection("cli_local");
await sleep(1800);
const vacio = await callCli("list_connections");
check("el MCP ve el borrado hecho por el CLI", /"total": 0/.test(vacio.texto));

await cliente.close();
fs.rmSync(STORE, { force: true });

console.log("");
if (failures) {
  console.error(`${failures} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
