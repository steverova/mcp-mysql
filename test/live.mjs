/**
 * Live integration test: introspection, views, routines and EXPLAIN.
 *
 * Needs a real MySQL. Two ways:
 *
 *   MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... npm run test:live
 *
 *   MCP_MYSQL_STORE=/path/to/connections.json [MCP_MYSQL_CONNECTION=name] npm run test:live
 *
 * It creates a view, a function and a procedure named mcp_live_* inside the
 * database and removes them at the end (also on failure). Nothing else is
 * touched, but run it against a development database, not production.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.MYSQL_USER && !process.env.MCP_MYSQL_STORE) {
  console.log("Skipped: set MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE or MCP_MYSQL_STORE.");
  process.exit(0);
}

const transporte = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, "src", "index.js")],
  cwd: ROOT,
  stderr: "pipe",
  env: {
    ...process.env,
    MYSQL_PROMPT_ON_START: "false",
    MCP_MYSQL_NO_BROWSER: "1",
    MCP_MYSQL_LANG: "en",
  },
});

const cliente = new Client({ name: "live-test", version: "1.0.0" });
await cliente.connect(transporte);

let failures = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "OK   " : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
  if (!condition) failures++;
};

const call = async (name, args = {}) => {
  try {
    const r = await cliente.callTool({ name, arguments: args });
    const txt = (r.content || []).map((c) => c.text).join("\n");
    return {
      isError: Boolean(r.isError),
      txt,
      json: () => {
        try {
          return JSON.parse(txt);
        } catch {
          return {};
        }
      },
    };
  } catch (error) {
    return { isError: true, txt: "EXCEPTION: " + error.message, json: () => ({}) };
  }
};

/** Crea un objeto con propose_write + confirm_write (dos pasos). */
const write = async (sql) => {
  const proposal = await call("propose_write", { sql, reason: "live test" });
  if (proposal.isError) return proposal;
  const token = proposal.json().token;
  return call("confirm_write", { sql, token });
};

const cleanup = [
  "DROP EVENT IF EXISTS mcp_live_ev",
  "DROP TRIGGER IF EXISTS mcp_live_trg",
  "DROP TABLE IF EXISTS mcp_live_mig",
  "DROP TABLE IF EXISTS mcp_live_t",
  "DROP VIEW IF EXISTS mcp_live_v",
  "DROP FUNCTION IF EXISTS mcp_live_fn",
  "DROP PROCEDURE IF EXISTS mcp_live_sp",
];

try {
  // Puerta de sesión: sin confirmar no se lee nada.
  const gated = await call("list_tables", {});
  check("session gate blocks before confirmation", gated.isError && /confirmed for this session/.test(gated.txt));

  const confirmed = await call("confirm_connection", {});
  check("confirm_connection opens the session", !confirmed.isError && confirmed.json().confirmed === true);

  // Inspección.
  const databases = (await call("list_databases")).json();
  check("list_databases returns schemas", databases.total > 0, `${databases.total} databases`);
  check("list_databases flags system schemas", (databases.databases || []).some((d) => d.system === true));

  const found = (await call("search_schema", { term: "client" })).json();
  check("search_schema finds tables by name", Array.isArray(found.tables) && found.tables.length > 0, found.tables?.[0]?.name);

  const foundColumn = (await call("search_schema", { term: "creado" })).json();
  check(
    "search_schema finds columns by name",
    Array.isArray(foundColumn.columns) && foundColumn.columns.length > 0,
    foundColumn.columns?.[0]?.name,
  );

  const tables = (await call("list_tables")).json();
  check("list_tables returns tables", Array.isArray(tables.tables) && tables.tables.length > 0, `${tables.total} objects`);
  const views = (await call("list_tables", { type: "view" })).json();
  check("list_tables filters views", Array.isArray(views.tables), `${views.total} views`);

  // Vistas: se crean por el canal de escritura y se leen como cualquier tabla.
  const view = await write(
    "CREATE OR REPLACE VIEW mcp_live_v AS SELECT id, nombre FROM clientes WHERE id IS NOT NULL",
  );
  check("CREATE VIEW runs through propose/confirm", !view.isError, view.txt.slice(0, 70));

  const viewList = (await call("list_tables", { type: "view" })).json();
  check("the new view is listed as a view", (viewList.tables || []).some((t) => t.dbTable === "mcp_live_v"));

  const viewDdl = await call("show_create", { type: "view", name: "mcp_live_v" });
  check("show_create returns the view DDL", !viewDdl.isError && /CREATE.*VIEW/i.test(viewDdl.json().ddl || ""));

  const viewRead = await call("query_read", { sql: "SELECT COUNT(*) AS n FROM mcp_live_v" });
  check("the view is queryable", !viewRead.isError && Array.isArray(viewRead.json().data));

  // Funciones y procedimientos.
  const fn = await write("CREATE FUNCTION mcp_live_fn(p INT) RETURNS INT DETERMINISTIC BEGIN RETURN p * 2; END");
  check("CREATE FUNCTION with BEGIN...END works", !fn.isError, fn.txt.slice(0, 70));

  const fnCall = await call("query_read", { sql: "SELECT mcp_live_fn(21) AS r" });
  check("the function can be used in SELECT", fnCall.json().data?.[0]?.r === 42, String(fnCall.json().data?.[0]?.r));

  const sp = await write("CREATE PROCEDURE mcp_live_sp(IN p INT) BEGIN SELECT mcp_live_fn(p) AS doble; END");
  check("CREATE PROCEDURE with BEGIN...END works", !sp.isError, sp.txt.slice(0, 70));

  const routines = (await call("list_routines", { type: "all" })).json();
  check("list_routines lists procedures", (routines.routines || []).some((r) => r.name === "mcp_live_sp" && r.kind === "PROCEDURE"));
  check("list_routines lists functions", (routines.routines || []).some((r) => r.name === "mcp_live_fn" && r.kind === "FUNCTION"));

  const spDdl = await call("show_create", { type: "procedure", name: "mcp_live_sp" });
  check("show_create returns the procedure DDL", !spDdl.isError && /CREATE.*PROCEDURE/i.test(spDdl.json().ddl || ""));

  // Triggers y eventos: DDL y exports (con una tabla propia del test).
  const table = await write("CREATE TABLE mcp_live_t (id INT PRIMARY KEY, v INT NULL)");
  check("CREATE TABLE works", !table.isError, table.txt.slice(0, 70));

  const trigger = await write(
    "CREATE TRIGGER mcp_live_trg BEFORE INSERT ON mcp_live_t FOR EACH ROW SET NEW.v = 7",
  );
  check("CREATE TRIGGER works", !trigger.isError, trigger.txt.slice(0, 70));

  const triggerDdl = await call("show_create", { type: "trigger", name: "mcp_live_trg" });
  check(
    "show_create returns the trigger DDL",
    !triggerDdl.isError && /TRIGGER/i.test(triggerDdl.json().ddl || ""),
    triggerDdl.txt.slice(0, 70),
  );

  const event = await write(
    "CREATE EVENT mcp_live_ev ON SCHEDULE EVERY 1 DAY DO SET @mcp_live = 1",
  );
  check("CREATE EVENT works", !event.isError, event.txt.slice(0, 70));

  const eventDdl = await call("show_create", { type: "event", name: "mcp_live_ev" });
  check(
    "show_create returns the event DDL",
    !eventDdl.isError && /EVENT/i.test(eventDdl.json().ddl || ""),
    eventDdl.txt.slice(0, 70),
  );

  const triggerInsert = await write("INSERT INTO mcp_live_t (id) VALUES (1)");
  check("the trigger fired on insert", !triggerInsert.isError);
  const triggerValue = await call("query_read", { sql: "SELECT v FROM mcp_live_t WHERE id = 1" });
  check("the trigger did its job", Number(triggerValue.json().data?.[0]?.v) === 7, String(triggerValue.json().data?.[0]?.v));

  const routineList = (await call("list_routines", { type: "trigger" })).json();
  check(
    "list_routines filters triggers",
    (routineList.triggers || []).some((t) => t.name === "mcp_live_trg") && !routineList.routines,
  );

  const eventList = (await call("list_routines", { type: "event" })).json();
  check("list_routines lists events", (eventList.events || []).some((e) => e.name === "mcp_live_ev"));

  // CALL: ahora es escritura y pasa por el token.
  const callRead = await call("query_read", { sql: "CALL mcp_live_sp(4)" });
  check("CALL is rejected on the read channel", callRead.isError && /read-only/.test(callRead.txt));

  const callProposal = await call("propose_write", { sql: "CALL mcp_live_sp(4)" });
  check(
    "CALL is proposed as a write with a warning",
    !callProposal.isError && (callProposal.json().warnings || []).some((w) => /CALL/.test(w)),
    callProposal.txt.slice(0, 70),
  );
  const callDone = await call("confirm_write", {
    sql: "CALL mcp_live_sp(4)",
    token: callProposal.json().token,
  });
  check("CALL executes after confirmation", !callDone.isError, callDone.txt.slice(0, 70));

  // EXPLAIN.
  const plan = await call("explain_query", { sql: "SELECT * FROM clientes WHERE id = 1" });
  check("explain_query returns a plan", !plan.isError && Array.isArray(plan.json().data) && plan.json().data.length > 0);
  check("explain_query returns hints as an array", Array.isArray(plan.json().hints));

  const jsonPlan = await call("explain_query", { sql: "SELECT * FROM clientes", format: "json" });
  check("explain_query supports JSON format", !jsonPlan.isError && jsonPlan.json().mode === "explain:json");

  const analyzed = await call("explain_query", { sql: "SELECT * FROM clientes", analyze: true });
  check("explain_query supports ANALYZE", !analyzed.isError && analyzed.json().mode === "analyze");

  const badExplain = await call("explain_query", { sql: "DELETE FROM clientes WHERE id = 1" });
  check("explain_query rejects writes", badExplain.isError && /read statements/.test(badExplain.txt));

  // Exportación del esquema.
  const dump = (await call("export_schema")).json();
  check("export_schema produces DDL", /CREATE TABLE/i.test(dump.ddl || ""), `${dump.objects?.tables} tables`);
  check("export_schema includes views", /CREATE.*VIEW/i.test(dump.ddl || ""));
  check("export_schema includes routines with DELIMITER", /DELIMITER ;;/.test(dump.ddl || ""));
  check("export_schema counts views", dump.objects?.views >= 1, String(dump.objects?.views));

  // Migraciones: varios statements con una sola confirmación.
  const script = [
    "CREATE TABLE mcp_live_mig (id INT PRIMARY KEY, v VARCHAR(20) NULL)",
    "INSERT INTO mcp_live_mig (id, v) VALUES (1, 'a;b')",
    "ALTER TABLE mcp_live_mig ADD COLUMN n INT NULL",
    "UPDATE mcp_live_mig SET n = 2 WHERE id = 1",
  ].join(";\n");

  const scriptProposal = await call("propose_script", { script, reason: "live test migration" });
  check(
    "propose_script splits the script into statements",
    !scriptProposal.isError && scriptProposal.json().statements === 4,
    String(scriptProposal.json().statements),
  );
  check(
    "propose_script warns that DDL cannot be rolled back",
    (scriptProposal.json().warnings || []).some((w) => /cannot be undone/.test(w)),
  );
  check(
    "propose_script keeps a semicolon inside a literal",
    (scriptProposal.json().plan || []).some((p) => p.statement.includes("'a;b'")),
  );

  const scriptDone = await call("confirm_script", {
    script,
    token: scriptProposal.json().token,
  });
  check(
    "confirm_script runs every statement",
    !scriptDone.isError && scriptDone.json().executed === 4 && scriptDone.json().failedAt === null,
    `${scriptDone.json().executed}/${scriptDone.json().statements}`,
  );

  const migration = await call("query_read", { sql: "SELECT v, n FROM mcp_live_mig WHERE id = 1" });
  check(
    "the migration had the expected effect",
    migration.json().data?.[0]?.v === "a;b" && Number(migration.json().data?.[0]?.n) === 2,
    JSON.stringify(migration.json().data?.[0]),
  );

  const scriptReuse = await call("confirm_script", { script, token: scriptProposal.json().token });
  check("a script token is single-use", scriptReuse.isError && /token/.test(scriptReuse.txt));

  const readOnlyScript = await call("propose_script", { script: "CREATE TABLE mcp_live_x (a INT); SELECT 1" });
  check(
    "propose_script rejects reads inside the script",
    readOnlyScript.isError && /read, not a write/.test(readOnlyScript.txt),
    readOnlyScript.txt.slice(0, 70),
  );

  const dangerousScript = await call("propose_script", { script: "DELETE FROM mcp_live_mig" });
  check(
    "propose_script flags a full-table statement",
    dangerousScript.json().warnings?.some((w) => /without WHERE|WHOLE table/.test(w)),
  );
  const dangerousConfirm = await call("confirm_script", {
    script: "DELETE FROM mcp_live_mig",
    token: dangerousScript.json().token,
  });
  check(
    "confirm_script requires allow_full_table",
    dangerousConfirm.isError && /allow_full_table/.test(dangerousConfirm.txt),
  );

  // validate_sql: comprobar sin ejecutar.
  const validRead = await call("validate_sql", { sql: "SELECT * FROM clientes WHERE id = 1" });
  check(
    "validate_sql accepts a valid SELECT and returns a plan",
    !validRead.isError && validRead.json().valid === true && Array.isArray(validRead.json().plan) && validRead.json().plan.length > 0,
  );
  check(
    "validate_sql reports how to run it",
    validRead.json().executableWith === "query_read",
    validRead.json().executableWith,
  );

  const invalidRead = await call("validate_sql", { sql: "SELECT * FROM tabla_que_no_existe_123" });
  check(
    "validate_sql catches a missing table",
    !invalidRead.isError && invalidRead.json().valid === false && /doesn't exist|no existe/i.test(invalidRead.json().error || ""),
    invalidRead.json().error?.slice(0, 60),
  );

  const badSyntax = await call("validate_sql", { sql: "SELECT FROM WHERE" });
  check(
    "validate_sql catches a syntax error",
    !badSyntax.isError && badSyntax.json().valid === false,
    badSyntax.json().error?.slice(0, 60),
  );

  const validWrite = await call("validate_sql", { sql: "UPDATE clientes SET nombre = 'x' WHERE id = 1" });
  check(
    "validate_sql accepts a write without running it",
    !validWrite.isError && validWrite.json().valid === true && /NOT changed anything/.test(validWrite.json().warning || ""),
    validWrite.json().warning?.slice(0, 40),
  );
  const untouched = await call("query_read", { sql: "SELECT COUNT(*) AS n FROM clientes WHERE nombre = 'x'" });
  check("the validated UPDATE did not run", Number(untouched.json().data?.[0]?.n) === 0);

  const validDdl = await call("validate_sql", { sql: "CREATE TABLE mcp_live_never (a INT)" });
  check("validate_sql accepts DDL without creating it", validDdl.json().valid === true);
  const notCreated = await call("list_tables");
  check(
    "the validated DDL did not create anything",
    !(notCreated.json().tables || []).some((t) => t.dbTable === "mcp_live_never"),
  );

  const routine = await call("validate_sql", {
    sql: "CREATE PROCEDURE mcp_live_never_sp() BEGIN SELECT 1; END",
  });
  check(
    "validate_sql says routines cannot be prepared",
    routine.json().valid === null && routine.json().serverCheck === false,
    routine.json().note?.slice(0, 50),
  );

  const forbidden = await call("validate_sql", { sql: "SET NAMES utf8mb4" });
  check("validate_sql rejects statements outside the allow-list", forbidden.isError, forbidden.txt.slice(0, 60));

  // Errores claros.
  const missing = await call("show_create", { type: "table", name: "no_existe_123" });
  check("show_create explains a missing object", missing.isError, missing.txt.slice(0, 70));

  const badType = await call("show_create", { type: "database", name: "x" });
  check("show_create validates the object type", badType.isError);
} finally {
  for (const sql of cleanup) {
    const proposal = await call("propose_write", { sql, reason: "live test cleanup" });
    if (!proposal.isError) {
      await call("confirm_write", { sql, token: proposal.json().token });
    }
  }
  const left = await call("list_tables", {});
  if (!left.isError && (left.json().tables || []).some((t) => String(t.dbTable).startsWith("mcp_live_"))) {
    console.log("WARN leftovers:", left.json().tables.map((t) => t.dbTable).join(", "));
    failures++;
  } else {
    console.log("OK   cleanup left nothing behind");
  }

  await cliente.close();
  console.log("");
  if (failures) {
    console.error(`${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("All live tests passed");
}
