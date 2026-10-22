/**
 * Prueba el binario compilado: CLI y servidor MCP.
 *
 *   node test/binary.mjs dist/mysql-mcp-windows-x64.exe
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binario = path.resolve(RAIZ, process.argv[2] || "dist/mysql-mcp-windows-x64.exe");

let fallos = 0;
const check = (nombre, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${nombre}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) fallos++;
};

const ejecutar = (...args) => {
  const r = spawnSync(binario, args, { encoding: "utf8", timeout: 60000 });
  return { codigo: r.status, salida: `${r.stdout || ""}${r.stderr || ""}`.trim() };
};

const version = ejecutar("version");
check("el binario arranca", version.codigo === 0, version.salida.slice(0, 40));
check("informa su versión", /^\d+\.\d+\.\d+$/.test(version.salida), version.salida);

const ayuda = ejecutar("help");
check("ayuda integrada", ayuda.salida.includes("mysql-mcp") && ayuda.salida.includes("doctor"));

const rutas = ejecutar("path");
check("conoce el archivo de conexiones", rutas.salida.includes("connections.json"), rutas.salida.split("\n")[0]);

// Servidor MCP dentro del binario.
const transporte = new StdioClientTransport({
  command: binario,
  args: ["start"],
  env: { ...process.env, MYSQL_USER: "", MYSQL_PROMPT_ON_START: "false", MCP_MYSQL_NO_BROWSER: "1" },
});

const cliente = new Client({ name: "binary-test", version: "1.0.0" });
await cliente.connect(transporte);

const { tools } = await cliente.listTools();
check("expone las 12 herramientas", tools.length === 12, tools.map((t) => t.name).join(", ").slice(0, 80));

const info = await cliente.callTool({ name: "connection_info", arguments: {} });
const texto = (info.content || []).map((c) => c.text).join("\n");
check("responde connection_info", !info.isError && /"conexiones"|"disponibles"/.test(texto), texto.replace(/\s+/g, " ").slice(0, 80));

await cliente.close();

console.log("");
if (fallos) {
  console.error(`${fallos} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
