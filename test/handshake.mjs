/**
 * Prueba de humo del protocolo MCP (no necesita un MySQL vivo).
 * Verifica arranque por stdio, handshake, herramientas, multi-conexión y paths de error.
 *
 *   npm test
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.join(os.tmpdir(), "mcp-mysql-test", "handshake.json");
fs.rmSync(STORE, { force: true });

const transporte = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, "src", "index.js")],
  cwd: ROOT,
  stderr: "pipe",
  env: {
    ...process.env,
    MYSQL_USER: "",
    MYSQL_PASSWORD: "",
    MYSQL_PROMPT_ON_START: "false",
    MCP_MYSQL_NO_BROWSER: "1",
    MCP_MYSQL_LANG: "es",
    MCP_MYSQL_STORE: STORE,
  },
});

const cliente = new Client({ name: "smoke-test", version: "1.0.0" });
await cliente.connect(transporte);

let failures = 0;
const check = (name, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${name}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) failures++;
};

const { tools } = await cliente.listTools();
const names = tools.map((t) => t.name).sort();
const expected = [
  "confirm_connection",
  "confirm_write",
  "connection_info",
  "describe_table",
  "list_connections",
  "list_tables",
  "propose_write",
  "query_read",
  "remove_connection",
  "reset_credentials",
  "save_connection",
  "use_connection",
];

check(`${expected.length} herramientas registradas`, names.length === expected.length, names.join(", "));
check("names esperados", expected.every((n) => names.includes(n)));

const callCli = async (name, args) => {
  try {
    const r = await cliente.callTool({ name, arguments: args });
    const txt = (r.content || []).map((c) => c.text).join("\n");
    return { isError: Boolean(r.isError), txt };
  } catch (error) {
    return { isError: true, txt: "EXCEPCION: " + error.message };
  }
};

// Clasificación SQL: rechaza escrituras en la vía de lectura.
const rejection = await callCli("query_read", { sql: "DELETE FROM usuarios WHERE id = 1" });
check("query_read rechaza DELETE", rejection.isError && /propose_write/.test(rejection.txt), rejection.txt.slice(0, 70));

const multi = await callCli("query_read", { sql: "SELECT 1; DROP TABLE x" });
check("bloquea múltiples sentencias", multi.isError && /UNA sentencia/.test(multi.txt), multi.txt.slice(0, 70));

const outfile = await callCli("query_read", { sql: "SELECT * FROM usuarios INTO OUTFILE '/tmp/x.txt'" });
check("bloquea INTO OUTFILE", outfile.isError && /escribir datos/.test(outfile.txt), outfile.txt.slice(0, 70));

const odd = await callCli("query_read", { sql: "CALL proc()" });
check("bloquea CALL", odd.isError && /no permitida/.test(odd.txt), odd.txt.slice(0, 70));

// Escritura: sin token no se ejecuta nada.
const sinToken = await callCli("confirm_write", {
  sql: "UPDATE usuarios SET name = 'x' WHERE id = 1",
  token: "00000000-0000-0000-0000-000000000000",
});
check(
  "confirm_write exige token de propose_write",
  sinToken.isError && /Token invalido|Token inválido/.test(sinToken.txt),
  sinToken.txt.slice(0, 70),
);

const badProposal = await callCli("propose_write", { sql: "SELECT 1" });
check("propose_write rechaza lecturas", badProposal.isError && /lectura/.test(badProposal.txt));

// Multi-conexión sin creds.
const info = await callCli("connection_info", {});
check(
  "connection_info informa que no hay connections",
  !info.isError && /"connected": false/.test(info.txt) && /save_connection/.test(info.txt),
  info.txt.replace(/\s+/g, " ").slice(0, 80),
);

const lista = await callCli("list_connections", {});
check("list_connections arranca vacío", !lista.isError && /"total": 0/.test(lista.txt));

const useIt = await callCli("use_connection", { name: "noexiste" });
check("use_connection valida el name", useIt.isError && /No existe la conexión/.test(useIt.txt), useIt.txt.slice(0, 70));

const sinCreds = await callCli("list_tables", {});
check("list_tables explica cómo crear conexión", sinCreds.isError && /save_connection/.test(sinCreds.txt), sinCreds.txt.slice(0, 70));

await cliente.close();
fs.rmSync(STORE, { force: true });

console.log("");
if (failures) {
  console.error(`${failures} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
