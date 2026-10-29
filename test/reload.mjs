/**
 * The CLI and the MCP share the connections file: a change made from the
 * terminal must show up in the already-running server, without restarting OpenCode.
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
  console.log(`${condicion ? "OK   " : "FAIL"} ${name}${detalle ? " -> " + detalle : ""}`);
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
    MCP_MYSQL_LANG: "en",
    MCP_MYSQL_STORE: STORE,
  },
});

const cliente = new Client({ name: "reload-test", version: "1.0.0" });
await cliente.connect(transporte);

const callCli = async (name, args = {}) => {
  const r = await cliente.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: (r.content || []).map((c) => c.text).join("\n") };
};

const before = await callCli("list_connections");
check("starts with no connections", /"total": 0/.test(before.text));

// The CLI creates a connection while the server is running.
upsertConnection(
  "cli_local",
  { host: "127.0.0.1", port: 3306, user: "mcp", password: "x", database: "demo", ssl: false },
  { activar: true },
);
await sleep(1800);

const after = await callCli("list_connections");
check("the MCP sees the CLI-created connection", /cli_local/.test(after.text), after.text.replace(/\s+/g, " ").slice(0, 90));

const info = await callCli("connection_info");
check(
  "the new connection requires session confirmation",
  /"requiresConfirmation": true/.test(info.text) && /"active": "cli_local"/.test(info.text),
  info.text.replace(/\s+/g, " ").slice(0, 100),
);

const bloqueado = await callCli("list_tables");
check("without confirmation, queries stay blocked", bloqueado.isError && /Current DB: cli_local/.test(bloqueado.text));

// The window confirms its choice: from now on it must not follow the file value.
await callCli("confirm_connection", {});
upsertConnection(
  "cli_other",
  { host: "127.0.0.1", port: 3306, user: "mcp", password: "x", database: "otra", ssl: false },
  { activate: true },
);
await sleep(1800);

const aislada = await callCli("connection_info");
check(
  "cambiar el default desde el CLI no secuestra la ventana",
  /"active": "cli_local"/.test(aislada.text) && /"confirmedInSession": true/.test(aislada.text),
  aislada.text.replace(/\s+/g, " ").slice(0, 110),
);

// The CLI deletes the connection: the MCP must go back to zero.
removeConnection("cli_local");
removeConnection("cli_other");
await sleep(1800);
const empty = await callCli("list_connections");
check("the MCP sees the CLI deletion", /"total": 0/.test(empty.text));

await cliente.close();
fs.rmSync(STORE, { force: true });

console.log("");
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("All tests passed");
