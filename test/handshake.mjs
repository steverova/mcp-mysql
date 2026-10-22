/**
 * Prueba de humo del protocolo MCP (no necesita un MySQL vivo).
 * Verifica arranque por stdio, handshake, herramientas, multi-conexión y rutas de error.
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
    MCP_MYSQL_STORE: STORE,
  },
});

const cliente = new Client({ name: "smoke-test", version: "1.0.0" });
await cliente.connect(transporte);

let fallos = 0;
const check = (nombre, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${nombre}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) fallos++;
};

const { tools } = await cliente.listTools();
const nombres = tools.map((t) => t.name).sort();
const esperadas = [
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

check(`${esperadas.length} herramientas registradas`, nombres.length === esperadas.length, nombres.join(", "));
check("nombres esperados", esperadas.every((n) => nombres.includes(n)));

const llamar = async (name, args) => {
  try {
    const r = await cliente.callTool({ name, arguments: args });
    const txt = (r.content || []).map((c) => c.text).join("\n");
    return { isError: Boolean(r.isError), txt };
  } catch (error) {
    return { isError: true, txt: "EXCEPCION: " + error.message };
  }
};

// Clasificación SQL: rechaza escrituras en la vía de lectura.
const rechazo = await llamar("query_read", { sql: "DELETE FROM usuarios WHERE id = 1" });
check("query_read rechaza DELETE", rechazo.isError && /propose_write/.test(rechazo.txt), rechazo.txt.slice(0, 70));

const multi = await llamar("query_read", { sql: "SELECT 1; DROP TABLE x" });
check("bloquea múltiples sentencias", multi.isError && /UNA sentencia/.test(multi.txt), multi.txt.slice(0, 70));

const outfile = await llamar("query_read", { sql: "SELECT * FROM usuarios INTO OUTFILE '/tmp/x.txt'" });
check("bloquea INTO OUTFILE", outfile.isError && /escribir datos/.test(outfile.txt), outfile.txt.slice(0, 70));

const raro = await llamar("query_read", { sql: "CALL proc()" });
check("bloquea CALL", raro.isError && /no permitida/.test(raro.txt), raro.txt.slice(0, 70));

// Escritura: sin token no se ejecuta nada.
const sinToken = await llamar("confirm_write", {
  sql: "UPDATE usuarios SET nombre = 'x' WHERE id = 1",
  token: "00000000-0000-0000-0000-000000000000",
});
check(
  "confirm_write exige token de propose_write",
  sinToken.isError && /Token invalido|Token inválido/.test(sinToken.txt),
  sinToken.txt.slice(0, 70),
);

const propuestaMala = await llamar("propose_write", { sql: "SELECT 1" });
check("propose_write rechaza lecturas", propuestaMala.isError && /lectura/.test(propuestaMala.txt));

// Multi-conexión sin credenciales.
const info = await llamar("connection_info", {});
check(
  "connection_info informa que no hay conexiones",
  !info.isError && /"conectado": false/.test(info.txt) && /save_connection/.test(info.txt),
  info.txt.replace(/\s+/g, " ").slice(0, 80),
);

const lista = await llamar("list_connections", {});
check("list_connections arranca vacío", !lista.isError && /"total": 0/.test(lista.txt));

const usar = await llamar("use_connection", { nombre: "noexiste" });
check("use_connection valida el nombre", usar.isError && /No existe la conexión/.test(usar.txt), usar.txt.slice(0, 70));

const sinCreds = await llamar("list_tables", {});
check("list_tables explica cómo crear conexión", sinCreds.isError && /save_connection/.test(sinCreds.txt), sinCreds.txt.slice(0, 70));

await cliente.close();
fs.rmSync(STORE, { force: true });

console.log("");
if (fallos) {
  console.error(`${fallos} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
