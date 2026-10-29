/**
 * Tests the compiled binary: CLI and MCP server.
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

let failures = 0;
const check = (name, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FAIL"} ${name}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) failures++;
};

const run = (...args) => {
  const r = spawnSync(binario, args, { encoding: "utf8", timeout: 60000 });
  return { code: r.status, output: `${r.stdout || ""}${r.stderr || ""}`.trim() };
};

const version = run("version");
check("the binary starts", version.code === 0, version.output.slice(0, 40));
check("reports its version", /^\d+\.\d+\.\d+$/.test(version.output), version.output);

const help = run("help");
check("built-in help", help.output.includes("mysql-mcp") && help.output.includes("doctor"));

const paths = run("path");
check("knows the connections file", paths.output.includes("connections.json"), paths.output.split("\n")[0]);

// MCP server inside the binary.
const transporte = new StdioClientTransport({
  command: binario,
  args: ["start"],
  env: { ...process.env, MCP_MYSQL_LANG: "en", MYSQL_USER: "", MYSQL_PROMPT_ON_START: "false", MCP_MYSQL_NO_BROWSER: "1" },
});

const cliente = new Client({ name: "binary-test", version: "1.0.0" });
await cliente.connect(transporte);

const { tools } = await cliente.listTools();
check("exposes the 12 tools", tools.length === 12, tools.map((t) => t.name).join(", ").slice(0, 80));

const info = await cliente.callTool({ name: "connection_info", arguments: {} });
const text = (info.content || []).map((c) => c.text).join("\n");
check("responds to connection_info", !info.isError && /"connections"|"available"/.test(text), text.replace(/\s+/g, " ").slice(0, 80));

await cliente.close();

console.log("");
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("All tests passed");
