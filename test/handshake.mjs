/**
 * MCP protocol smoke test (no live MySQL needed).
 * Checks stdio startup, handshake, tools, multi-connection and error paths.
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
    MCP_MYSQL_LANG: "en",
    MCP_MYSQL_STORE: STORE,
  },
});

const cliente = new Client({ name: "smoke-test", version: "1.0.0" });
await cliente.connect(transporte);

let failures = 0;
const check = (name, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FAIL"} ${name}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) failures++;
};

const { tools } = await cliente.listTools();
const names = tools.map((t) => t.name).sort();
const expected = [
  "confirm_connection",
  "confirm_script",
  "confirm_write",
  "connection_info",
  "describe_table",
  "explain_query",
  "export_schema",
  "list_connections",
  "list_databases",
  "list_routines",
  "list_tables",
  "propose_script",
  "propose_write",
  "query_read",
  "remove_connection",
  "reset_credentials",
  "save_connection",
  "search_schema",
  "show_create",
  "use_connection",
  "validate_sql",
];

check(`${expected.length} herramientas registradas`, names.length === expected.length, names.join(", "));
check("names expected", expected.every((n) => names.includes(n)));

const callCli = async (name, args) => {
  try {
    const r = await cliente.callTool({ name, arguments: args });
    const txt = (r.content || []).map((c) => c.text).join("\n");
    return { isError: Boolean(r.isError), txt };
  } catch (error) {
    return { isError: true, txt: "EXCEPTION: " + error.message };
  }
};

// SQL classification: rejects writes on the read path.
const rejection = await callCli("query_read", { sql: "DELETE FROM users WHERE id = 1" });
check("query_read rejects DELETE", rejection.isError && /propose_write/.test(rejection.txt), rejection.txt.slice(0, 70));

const multi = await callCli("query_read", { sql: "SELECT 1; DROP TABLE x" });
check("blocks multiple statements", multi.isError && /Only ONE statement/.test(multi.txt), multi.txt.slice(0, 70));

const outfile = await callCli("query_read", { sql: "SELECT * FROM users INTO OUTFILE '/tmp/x.txt'" });
check("blocks INTO OUTFILE", outfile.isError && /looks like it writes data/.test(outfile.txt), outfile.txt.slice(0, 70));

const odd = await callCli("query_read", { sql: "CALL proc()" });
check("CALL is a write, not a read", odd.isError && /read-only/.test(odd.txt), odd.txt.slice(0, 70));

const callProposal = await callCli("propose_write", { sql: "CALL proc()" });
check(
  "CALL is no longer rejected as a statement",
  !/not allowed/i.test(callProposal.txt),
  callProposal.txt.replace(/\s+/g, " ").slice(0, 70),
);

const literalSemicolon = await callCli("query_read", { sql: "SELECT 'a;b' AS texto" });
check(
  "a semicolon inside a literal is not a second statement",
  !literalSemicolon.isError || !/Only ONE statement/.test(literalSemicolon.txt),
  literalSemicolon.txt.slice(0, 80),
);

// Writes: nothing runs without a token.
const missingToken = await callCli("confirm_write", {
  sql: "UPDATE users SET name = 'x' WHERE id = 1",
  token: "00000000-0000-0000-0000-000000000000",
});
check(
  "confirm_write requires a propose_write token",
  missingToken.isError && /Invalid, already used or expired token/.test(missingToken.txt),
  missingToken.txt.slice(0, 70),
);

const badProposal = await callCli("propose_write", { sql: "SELECT 1" });
check("propose_write rejects reads", badProposal.isError && /is a read/.test(badProposal.txt));

// Multi-connection without credentials.
const info = await callCli("connection_info", {});
check(
  "connection_info reports no connections",
  !info.isError && /"connected": false/.test(info.txt) && /save_connection/.test(info.txt),
  info.txt.replace(/\s+/g, " ").slice(0, 80),
);

const list = await callCli("list_connections", {});
check("list_connections starts empty", !list.isError && /"total": 0/.test(list.txt));

const useIt = await callCli("use_connection", { name: "noexiste" });
check("use_connection validates the name", useIt.isError && /does not exist/.test(useIt.txt), useIt.txt.slice(0, 70));

const missingCreds = await callCli("list_tables", {});
check("list_tables explains how to create a connection", missingCreds.isError && /save_connection/.test(missingCreds.txt), missingCreds.txt.slice(0, 70));

await cliente.close();
fs.rmSync(STORE, { force: true });

console.log("");
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("All tests passed");
