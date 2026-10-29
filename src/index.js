#!/usr/bin/env node
/**
 * MCP server for MySQL with multiple connections.
 *
 *  - Connections: named profiles with one active.
 *  - Reads: free (SELECT/SHOW/DESCRIBE/EXPLAIN) inside a READ ONLY transaction.
 *  - Writes: in TWO steps. `propose_write` validates and describes the impact
 *    without executing and returns a single-use token. `confirm_write` runs only
 *    if the token is valid, has not expired and matches the statement and the
 *    connection.
 *
 * There is also a UI barrier: OpenCode's `ask` permission on confirm_write.
 *
 * The process speaks MCP over stdio: NEVER write to stdout (use console.error).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteStore,
  hasStoredConnections,
  loadStore,
  removeConnection,
  storePath,
  upsertConnection,
  validateName,
} from "./store.js";
import { openForm } from "./webform.js";
import { isEntryPoint } from "./cli-util.js";
import { t } from "./i18n.js";
import {
  maskLiterals,
  normalizeSql,
  quoteIdentifier,
  splitStatements,
  stripComments,
} from "./sqltext.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [
  path.join(ROOT, ".env"),
  path.join(process.cwd(), ".env"),
  path.join(path.dirname(process.execPath), ".env"),
]) {
  try {
    process.loadEnvFile(file);
    break;
  } catch {
    // Try the next candidate.
  }
}

const bool = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const CONFIG = {
  maxRows: Math.max(1, Number(process.env.MYSQL_MAX_ROWS || 200)),
  writeEnabled: bool(process.env.MYSQL_WRITE_ENABLED, true),
  confirmTtl: Math.max(10, Number(process.env.MYSQL_CONFIRM_TTL_SECONDS || 300)),
  connectTimeout: Math.max(1000, Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 10000)),
  maxScriptStatements: Math.max(1, Number(process.env.MYSQL_MAX_SCRIPT_STATEMENTS || 100)),
};

/** ------------------------------------------------------------------ */
/** Connections                                                        */
/** ------------------------------------------------------------------ */

/** name -> { host, port, user, password, database, ssl } */
let connections = new Map();
let activeName = "";
let confirmed = false;
let confirmedFor = "";
// Once this window picks a connection, it stops following the shared default.
let sessionChose = false;
let activeFormOpen = false;

/** name -> { key, pool } */
const pools = new Map();

const describeConnection = (c) =>
  `${c.user}@${c.host}:${Number(c.port) || 3306}/${c.database || t("common.noDatabase")}`;

function profileFromEnv() {
  if (!process.env.MYSQL_USER) return null;
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || undefined,
    ssl: bool(process.env.MYSQL_SSL, false),
  };
}

function reloadConnections() {
  const previousNames = new Set(connections.keys());
  const next = new Map();

  const desdeEnv = profileFromEnv();
  if (desdeEnv) next.set("env", desdeEnv);

  let savedStore = { active: "", connections: {} };
  try {
    savedStore = loadStore();
  } catch (error) {
    console.error("[mcp-mysql] could not read the store:", error.message);
  }

  for (const [name, creds] of Object.entries(savedStore.connections)) {
    // The environment profile cannot be overwritten from the store.
    if (!next.has(name)) next.set(name, creds);
  }

  connections = next;

  if (!sessionChose && savedStore.active && connections.has(savedStore.active)) activeName = savedStore.active;
  else if (!connections.has(activeName)) activeName = connections.has("env") ? "env" : [...connections.keys()][0] || "";

  for (const name of previousNames) {
    const creds = connections.get(name);
    const input = pools.get(name);
    if (!creds || (input && input.key !== JSON.stringify(creds))) {
      if (input) input.pool.end().catch(() => {});
      pools.delete(name);
    }
  }
}

function watchStore() {
  // The CLI writes the same file: external changes are reloaded without a restart.
  // Changes made by the MCP itself already update connections and confirmation.
  try {
    fs.watchFile(storePath(), { interval: 1000 }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs) return;
      reloadConnections();
      if (confirmedFor !== activeName) {
        confirmed = false;
        confirmedFor = "";
      }
      console.error(
        `[mcp-mysql] store reloaded externally -> active=${activeName || "-"} connections=${[...connections.keys()].join(",") || "(none)"}`,
      );
    });
  } catch (error) {
    console.error("[mcp-mysql] could not watch the store:", error.message);
  }
}

function resolveConnectionName(solicitado) {
  const name = (solicitado || "").trim() || activeName;
  if (name && connections.has(name)) return name;

  const available = [...connections.keys()].join(", ") || "(none)";
  if (solicitado) {
    throw new Error(t("mcp.conn.notFound", { name: solicitado, available: available }));
  }
  throw new Error(t("mcp.conn.none", { available: available }));
}

function getPool(solicitado) {
  const name = resolveConnectionName(solicitado);
  const creds = connections.get(name);
  const key = JSON.stringify(creds);

  const input = pools.get(name);
  if (input && input.key !== key) {
    input.pool.end().catch(() => {});
    pools.delete(name);
  }

  if (!pools.has(name)) {
    pools.set(name, {
      key,
      pool: mysql.createPool({
        host: creds.host,
        port: Number(creds.port) || 3306,
        user: creds.user,
        password: creds.password,
        database: creds.database || undefined,
        ssl: creds.ssl ? { rejectUnauthorized: false } : undefined,
        waitForConnections: true,
        connectionLimit: 4,
        maxIdle: 4,
        idleTimeout: 60000,
        connectTimeout: CONFIG.connectTimeout,
        multipleStatements: false,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        timezone: "Z",
      }),
    });
  }

  return pools.get(name).pool;
}

function closePool(name) {
  const input = pools.get(name);
  if (input) {
    input.pool.end().catch(() => {});
    pools.delete(name);
  }
}

let activeForm = null;

async function openConnectionForm({ prefill, name } = {}) {
  if (activeFormOpen) {
    return {
      open: false,
      message: t("mcp.form.open"),
      url: activeForm?.url || null,
    };
  }

  activeFormOpen = true;
  try {
    const form = await openForm({
      prefill: { ...(prefill || {}), ...(name ? { name } : {}) },
      connections: [...connections.keys()],
      onDone: (result) => {
        activeFormOpen = false;
        activeForm = null;
        if (result.ok) {
          activeName = result.name;
          confirmed = true;
          confirmedFor = result.name;
          reloadConnections();
          console.error(
            `[mcp-mysql] ${t("mcp.form.saved", { name: result.name, target: describeConnection(result.credentials) })}`,
          );
        } else if (result.expirado) {
          console.error(`[mcp-mysql] ${t("mcp.form.expired")}`);
        } else {
          console.error(`[mcp-mysql] ${t("mcp.form.closed")}`);
        }
      },
    });

    activeForm = form;
    console.error(`[mcp-mysql] ${t("mcp.form.at", { url: form.url })}`);
    return {
      open: true,
      url: form.url,
      browserOpened: form.browserOpened,
      message:
        t("mcp.form.message"),
    };
  } catch (caught) {
    activeFormOpen = false;
    throw caught;
  }
}

function errorHint(error) {
  return (
    {
      ECONNREFUSED: t("mcp.hint.refused"),
      ETIMEDOUT: t("mcp.hint.timeout"),
      ENOTFOUND: t("mcp.hint.dns"),
      EHOSTUNREACH: t("mcp.hint.unreachable"),
      ER_ACCESS_DENIED_ERROR: t("mcp.hint.denied"),
      ER_BAD_DB_ERROR: t("mcp.hint.badDb"),
      ER_NOT_SUPPORTED_AUTH_MODE: t("mcp.hint.authMode"),
    }[error?.code] || t("mcp.hint.generic")
  );
}

/**
 * Session gate: until the user confirms the active database, no
 * data operation runs. That way the agent cannot start
 * querying "the one that was left selected" without warning which it is.
 */
function requireConfirmation(connection) {
  if (!connections.size) return;

  const target = connection ? resolveConnectionName(connection) : activeName;
  if (!target) return;
  if (confirmed && confirmedFor === target) return;

  const creds = connections.get(target);
  throw new UserError(
    t("mcp.gate.title", { name: target, target: describeConnection(creds) }) +
      "\n\n" +
      t("mcp.gate.body", { name: target }),
  );
}

// Activates a connection (and optionally its database), verifying access.
async function activateConnection(requestedName, database) {
  const finalName = resolveConnectionName(requestedName);
  const creds = { ...connections.get(finalName) };

  if (database !== undefined) {
    creds.database = database.trim() || undefined;
    if (finalName !== "env") {
      try {
        // Persists the connection edit, but not the active selection: each window is independent.
        upsertConnection(finalName, creds, { activate: false });
      } catch (caught) {
        console.error("[mcp-mysql] could not persist the database:", caught.message);
      }
    }
    connections.set(finalName, creds);
    closePool(finalName);
  }

  // The selection lives in this process only; the file keeps the default for new windows.
  activeName = finalName;
  sessionChose = true;

  const data = connections.get(finalName);
  const result = {
    active: finalName,
    currentDatabase: data.database || null,
    target: describeConnection(data),
  };

  try {
    await getPool(finalName).query("SELECT 1");
    return { ...result, connected: true };
  } catch (error) {
    return { ...result, connected: false, error: formatError(error), hint: errorHint(error) };
  }
}

/** ------------------------------------------------------------------ */
// Utilities
/** ------------------------------------------------------------------ */

class UserError extends Error {}

function formatError(error) {
  if (error instanceof UserError) return error.message;
  const code = error?.code ? error.code + ": " : "";
  return code + (error?.sqlMessage || error?.message || String(error));
}

function text(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function fail(message) {
  return { content: [{ type: "text", text: "ERROR: " + message }], isError: true };
}

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args || {});
    } catch (error) {
      console.error("[mcp-mysql]", error?.stack || error);
      return fail(formatError(error));
    }
  };
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `<buffer ${value.length} bytes>`;
  if (value instanceof Date) return value.toISOString();
  if (depth > 8) return "[...]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitize(item, depth + 1);
    return out;
  }
  return value;
}

const READ_FIRST = new Set(["select", "show", "describe", "desc", "explain"]);
const WRITE_FIRST = new Set([
  "insert",
  "update",
  "delete",
  "replace",
  "create",
  "alter",
  "drop",
  "truncate",
  "rename",
  "call",
]);

const SNEAKY_WRITE =
  /\b(into\s+(out|dump)file|for\s+update|lock\s+in\s+share\s+mode|\binsert\b|\bupdate\b|\bdelete\b|\breplace\b|\bcreate\b|\balter\b|\bdrop\b|\btruncate\b|\brename\b|\bgrant\b|\brevoke\b|\bcall\b|\bload\s+data\b)\b/i;

/**
 * Cabecera de una rutina almacenada (procedimiento, función, trigger o evento).
 * Admite `DEFINER = ...` y `OR REPLACE`, igual que el servidor.
 */
const ROUTINE_HEAD =
  /^create\s+(?:or\s+replace\s+)?(?:definer\s*=\s*(?:current_user(?:\(\))?|(?:`[^`]*`|'[^']*'|[\w$.-]+)@(?:`[^`]*`|'[^']*'|[\w$.-]+))\s+)?(procedure|function|trigger|event)\b/i;

/**
 * ¿Es UNA sola definición de rutina con cuerpo `BEGIN ... END`?
 *
 * El cuerpo necesita `;` internos, así que estas sentencias se eximen del
 * chequeo de "una sentencia por llamada". Se exige que:
 *  - empiece por `CREATE [DEFINER=...] PROCEDURE|FUNCTION|TRIGGER|EVENT`;
 *  - si tiene `BEGIN`, cierre con `END` (con etiqueta opcional) y **nada**
 *    más después: un `... END; DROP TABLE x` no pasa.
 *
 * Los literales se enmascaran antes de mirar palabras clave, así que un
 * `SET x = 'BEGIN'` o un `SELECT 'a;b'` no confunden al detector.
 *
 * La conexión usa `multipleStatements: false`, así que aunque se colara algo
 * detrás del `END`, el servidor rechaza el segundo statement.
 */
export function isRoutineDefinition(sql) {
  const cleaned = maskLiterals(stripComments(sql)).trim().replace(/;+\s*$/, "");
  const body = cleaned.replace(/;+\s*$/, "").trim();
  if (!ROUTINE_HEAD.test(body)) return false;

  if (!/\bbegin\b/i.test(body)) {
    // Cuerpo de una sola sentencia (`CREATE PROCEDURE p() SELECT 1`): no debe
    // tener `;` internos (si los tiene, es otra cosa).
    return !body.includes(";");
  }

  // Debe terminar en END (opcionalmente con la etiqueta del bloque).
  return /(?:^|[\s;])end\s*(?:[A-Za-z_]\w*)?$/i.test(body);
}

/**
 * Columnas de una tabla/vista que se pueden pedir con `SHOW CREATE ...`.
 * Se valida contra esta lista: el nombre de tipo nunca llega al SQL.
 */
const SHOW_CREATE = {
  table: "TABLE",
  view: "VIEW",
  procedure: "PROCEDURE",
  function: "FUNCTION",
  trigger: "TRIGGER",
  event: "EVENT",
};

/** "read" | "write", o lanza UserError. */
export function classify(rawSql) {
  if (typeof rawSql !== "string" || !rawSql.trim()) {
    throw new UserError(t("mcp.sql.empty"));
  }

  const cleaned = stripComments(rawSql).trim();
  if (!cleaned) throw new UserError(t("mcp.sql.empty"));

  // Las rutinas almacenadas llevan `;` dentro del cuerpo BEGIN...END.
  const routineHead = ROUTINE_HEAD.test(maskLiterals(cleaned));
  if (routineHead) {
    if (!isRoutineDefinition(cleaned)) throw new UserError(t("mcp.sql.routineUnclosed"));
    return "write";
  }

  // Los `;` de dentro de un literal no cuentan como sentencias.
  const statements = splitStatements(cleaned);
  if (statements.length > 1) throw new UserError(t("mcp.sql.oneStatement"));

  const single = statements[0] || "";
  const first = (single.match(/^[a-z]+/i)?.[0] || "").toLowerCase();
  const masked = maskLiterals(single);

  if (READ_FIRST.has(first)) {
    if (first !== "show" && first !== "describe" && first !== "desc" && SNEAKY_WRITE.test(masked)) {
      throw new UserError(
        t("mcp.sql.sneakyWrite"),
      );
    }
    return "read";
  }

  if (first === "with") {
    return /\b(insert|update|delete|replace)\b/i.test(masked) ? "write" : "read";
  }

  if (WRITE_FIRST.has(first)) return "write";

  throw new UserError(
    t("mcp.sql.notAllowed", { verbo: first || "?" }),
  );
}

const normalizar = (sql) => normalizeSql(sql);
const hashOf = (sql) => crypto.createHash("sha256").update(normalizar(sql)).digest("hex");
const isUpdateWithoutWhere = (sql) =>
  /^(update|delete)\b/i.test(normalizar(sql)) && !/\bwhere\b/i.test(normalizar(sql));

/** ------------------------------------------------------------------ */
// Confirmation tokens (single use, per connection)
/** ------------------------------------------------------------------ */

const pendingTokens = new Map();

function purgeTokens() {
  const now = Date.now();
  for (const [token, item] of pendingTokens) {
    if (item.expiraEn <= now) pendingTokens.delete(token);
  }
}

/** ------------------------------------------------------------------ */
// Execution
/** ------------------------------------------------------------------ */

async function runRead(sql, connection, limit) {
  const conn = await getPool(connection).getConnection();
  const startedAt = process.hrtime.bigint();
  try {
    await conn.query("START TRANSACTION READ ONLY");
    let result;
    try {
      const [rows, fields] = await conn.query(sql);
      result = { rows, fields };
    } finally {
      await conn.query("ROLLBACK").catch(() => {});
    }

    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
    const { rows, fields } = result;
    if (!Array.isArray(rows)) return { type: "result", durationMs, ...sanitize(rows) };

    const columns = (fields || []).map((field) => field.name);
    const truncated = rows.length > limit;
    const limitedRows = sanitize(rows.slice(0, limit));

    return {
      rows: limitedRows.length,
      columns,
      truncated,
      durationMs,
      ...(truncated
        ? { warning: t("mcp.rowsLimited", { limit }) }
        : {}),
      data: limitedRows,
    };
  } finally {
    conn.release();
  }
}

async function estimateImpact(sql, connection) {
  const type = (normalizar(sql).match(/^[a-z]+/i)?.[0] || "").toLowerCase();
  if (type === "call") {
    return { estimacion: t("mcp.estimate.notApplicable"), nota: t("mcp.estimate.call") };
  }
  if (!["update", "delete", "insert", "replace"].includes(type)) {
    return { estimacion: t("mcp.estimate.notApplicable"), nota: t("mcp.estimate.ddl") };
  }
  try {
    const [rows] = await getPool(connection).query("EXPLAIN " + normalizar(sql));
    if (!Array.isArray(rows)) return { estimacion: t("mcp.estimate.unknown") };
    const estimatedRows = rows.reduce((total, row) => total + Number(row.rows || 0), 0);
    return {
      estimacion: t("mcp.estimate.rows", { rows: estimatedRows }),
      acceso: rows.map((row) => `${row.table || "?"} [${row.type || "?"}]${row.key ? " key=" + row.key : ""}`),
    };
  } catch (error) {
    return { estimacion: t("mcp.estimate.unknown"), nota: formatError(error) };
  }
}

async function runWrite(sql, connection) {
  const conn = await getPool(connection).getConnection();
  try {
    const [result] = await conn.query(sql);
    if (Array.isArray(result)) {
      return { type: t("mcp.type.rows"), rows: sanitize(result.slice(0, CONFIG.maxRows)) };
    }
    return {
      affected: result?.affectedRows ?? null,
      changed: result?.changedRows ?? null,
      insertId: result?.insertId ?? null,
      warnings: result?.warningStatus ?? 0,
      info: result?.info || null,
    };
  } finally {
    conn.release();
  }
}

/** ------------------------------------------------------------------ */
// Introspection helpers (databases, views, routines, indexes, DDL)
/** ------------------------------------------------------------------ */

const SYSTEM_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

/** Escapa un término para usarlo dentro de un LIKE con parámetros. */
const likeTerm = (term) => `%${String(term).replace(/[\\%_]/g, (c) => "\\" + c)}%`;

/**
 * Lee las claves candidatas de una fila de `SHOW CREATE ...` y devuelve el DDL.
 * MySQL nombra la columna distinto en cada objeto ("Create Table", "Create View",
 * "SQL Original Statement"...), así que se busca en vez de fijarla.
 */
function pickDdl(row) {
  if (!row) return null;
  const key = Object.keys(row).find((name) => /^(create|sql original)/i.test(name));
  return key ? row[key] : null;
}

/** Convierte el resultado de un EXPLAIN en avisos legibles. */
function explainHints(rows) {
  if (!Array.isArray(rows)) return [];
  const hints = [];
  for (const row of rows) {
    const table = row.table ?? "?";
    const access = String(row.type ?? "").toLowerCase();
    const extra = String(row.Extra ?? "");
    const estimated = Number(row.rows ?? 0);

    if (access === "all") hints.push(t("mcp.explain.fullScan", { table }));
    else if (access === "index") hints.push(t("mcp.explain.indexScan", { table }));
    if (!row.key && ["all", "index", "range", "ref_or_null"].includes(access)) {
      hints.push(t("mcp.explain.noKey", { table }));
    }
    if (/using filesort/i.test(extra)) hints.push(t("mcp.explain.filesort", { table }));
    if (/using temporary/i.test(extra)) hints.push(t("mcp.explain.temporary", { table }));
    if (estimated > 10000) hints.push(t("mcp.explain.manyRows", { table, rows: estimated }));
    if (/using join buffer/i.test(extra)) hints.push(t("mcp.explain.joinBuffer", { table }));
  }
  return hints;
}

/** Esquema destino: el pedido o el de la conexión. */
function targetSchema(name, schema) {
  const target = schema || connections.get(name)?.database;
  if (!target) throw new UserError(t("mcp.noSchema"));
  return target;
}

/** SHOW CREATE de un objeto del esquema, con el tipo validado por lista blanca. */
async function readCreate(name, type, schema, objectName) {
  const keyword = SHOW_CREATE[type];
  if (!keyword) throw new UserError(t("mcp.showCreate.badType", { types: Object.keys(SHOW_CREATE).join(", ") }));

  const [rows] = await getPool(name).query(
    `SHOW CREATE ${keyword} ${quoteIdentifier(schema)}.${quoteIdentifier(objectName)}`,
  );
  const ddl = pickDdl(rows?.[0]);
  if (!ddl) throw new UserError(t("mcp.showCreate.missing", { type, name: objectName, schema }));
  return ddl;
}

/** Códigos en los que el "hint" de conexión aporta algo. */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ER_ACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR",
  "ER_NOT_SUPPORTED_AUTH_MODE",
]);

/**
 * Valida una sentencia SIN ejecutarla: `SET @var` + `PREPARE` + `DEALLOCATE`.
 *
 * PREPARE resuelve sintaxis, tablas, columnas y permisos; no modifica datos.
 * Todo va en la misma conexión del pool porque PREPARE es de sesión.
 * Las rutinas (CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT) no son "preparables"
 * y devuelven ER_UNSUPPORTED_PS: eso no es un error de la sentencia.
 */
async function prepareOnly(sql, connection) {
  const conn = await getPool(connection).getConnection();
  let prepared = false;
  try {
    await conn.query("SET @mcp_validate_sql = ?", [sql]);
    await conn.query("PREPARE mcp_validate_stmt FROM @mcp_validate_sql");
    prepared = true;
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || null,
      error: formatError(error),
      hint: NETWORK_CODES.has(error?.code) ? errorHint(error) : null,
    };
  } finally {
    if (prepared) await conn.query("DEALLOCATE PREPARE mcp_validate_stmt").catch(() => {});
    await conn.query("SET @mcp_validate_sql = NULL").catch(() => {});
    conn.release();
  }
}

/**
 * EXPLAIN sin ejecutar y sin `READ ONLY`: MySQL rechaza `EXPLAIN UPDATE/DELETE`
 * dentro de una transacción de solo lectura (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION).
 * EXPLAIN no modifica datos, así que aquí no hace falta transacción.
 */
async function explainOnly(sql, connection, limit = 200) {
  const [rows, fields] = await getPool(connection).query("EXPLAIN " + sql);
  return {
    columns: (fields || []).map((field) => field.name),
    data: Array.isArray(rows) ? sanitize(rows.slice(0, limit)) : [],
  };
}

/** ------------------------------------------------------------------ */
// Server
/** ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "mysql", version: "2.5.0" },
  {
    instructions: t("mcp.instructions"),
  },
);

server.registerTool(
  "connection_info",
  {
    title: t("mcp.tool.connection_info.title"),
    description:
      t("mcp.tool.connection_info.description"),
    inputSchema: {
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ connection }) => {
    const status = {
      active: activeName || null,
      currentDatabase: activeName && connections.has(activeName) ? connections.get(activeName).database || null : null,
      confirmedInSession: confirmed,
      requiresConfirmation: connections.size > 0 && !confirmed,
      available: [...connections.keys()],
      storeInfo: {
        file: storePath(),
        exists: hasStoredConnections(),
        formOpen: activeFormOpen,
        formUrl: activeForm?.url || null,
      },
      limits: {
        maxRows: CONFIG.maxRows,
        writeEnabled: CONFIG.writeEnabled,
        tokenTtlSeconds: CONFIG.confirmTtl,
      },
    };

    if (!connections.size) {
      return text({
        connected: false,
        ...status,
        help: t("mcp.noConnectionsHelp"),
      });
    }

    let name;
    try {
      name = resolveConnectionName(connection);
    } catch (error) {
      return text({ connected: false, ...status, error: error.message });
    }

    const creds = connections.get(name);
    const target = describeConnection(creds);

    try {
      const [rows] = await getPool(name).query(
        "SELECT VERSION() AS version, DATABASE() AS currentDatabase, CURRENT_USER() AS dbUser, @@hostname AS host, @@port AS port",
      );
      return text({
        connected: true,
        connection: name,
        target,
        serverInfo: sanitize(rows[0]) || {},
        ...status,
      });
    } catch (error) {
      return text({
        connected: false,
        connection: name,
        target,
        error: formatError(error),
        hint: errorHint(error),
        ...status,
      });
    }
  }),
);

server.registerTool(
  "list_connections",
  {
    title: t("mcp.tool.list_connections.title"),
    description: t("mcp.tool.list_connections.description"),
    inputSchema: {},
  },
  wrap(async () => {
    const available = [...connections.entries()].map(([name, creds]) => ({
      name,
      target: describeConnection(creds),
      database: creds.database || null,
      ssl: Boolean(creds.ssl),
      active: name === activeName,
      origin: name === "env" ? t("mcp.origin.env") : t("mcp.origin.store"),
    }));

    return text({
      total: available.length,
      active: activeName || null,
      connections: available,
      ...(available.length === 0 ? { nextStep: t("mcp.noConnectionsHelp") } : {}),
    });
  }),
);

server.registerTool(
  "save_connection",
  {
    title: t("mcp.tool.save_connection.title"),
    description:
      t("mcp.tool.save_connection.description"),
    inputSchema: {
      name: z.string().optional().describe(t("mcp.param.saveName")),
      host: z.string().optional().describe(t("mcp.param.hostSave")),
      port: z.number().int().optional().describe(t("mcp.param.portSave")),
      user: z.string().optional().describe(t("mcp.param.userSave")),
      database: z.string().optional().describe(t("mcp.param.databaseSave")),
      ssl: z.boolean().optional().describe(t("mcp.param.sslSave")),
    },
  },
  wrap(async ({ name, host, port, user, database, ssl }) => {
    if (name) {
      const problem = validateName(name);
      if (problem) throw new UserError(problem);
    }

    const prefill = {};
    if (host !== undefined) prefill.host = host;
    if (port !== undefined) prefill.port = port;
    if (user !== undefined) prefill.user = user;
    if (database !== undefined) prefill.database = database;
    if (ssl !== undefined) prefill.ssl = ssl;

    const result = await openConnectionForm({ prefill, name });
    return text({
      ...result,
      savedIn: storePath(),
      nota: t("mcp.saveHint"),
    });
  }),
);

server.registerTool(
  "use_connection",
  {
    title: t("mcp.tool.use_connection.title"),
    description:
      t("mcp.tool.use_connection.description"),
    inputSchema: {
      name: z.string().describe(t("mcp.param.useName")),
      database: z.string().optional().describe(t("mcp.param.databaseUse")),
    },
  },
  wrap(async ({ name, database }) => {
    const result = await activateConnection(name, database);
    confirmed = true;
    confirmedFor = result.active;
    return text({
      ...result,
      message: result.connected
        ? t("mcp.activeVerified", { name: result.active })
        : t("mcp.activeNoConn", { name: result.active }),
    });
  }),
);

server.registerTool(
  "confirm_connection",
  {
    title: t("mcp.tool.confirm_connection.title"),
    description:
      t("mcp.tool.confirm_connection.description"),
    inputSchema: {
      connection: z.string().optional().describe(t("mcp.param.connection")),
      database: z.string().optional().describe(t("mcp.param.databaseUse")),
    },
  },
  wrap(async ({ connection, database }) => {
    if (!connections.size) {
      throw new UserError(
        t("mcp.noConnections"),
      );
    }

    const result = await activateConnection(connection, database);
    confirmed = true;
    confirmedFor = result.active;

    return text({
      confirmed: true,
      ...result,
      message: result.connected
        ? t("mcp.confirmed", { name: result.active, base: result.currentDatabase || t("common.noDatabase") })
        : t("mcp.confirmedNoConn", { name: result.active }),
    });
  }),
);

server.registerTool(
  "remove_connection",
  {
    title: t("mcp.tool.remove_connection.title"),
    description:
      t("mcp.tool.remove_connection.description"),
    inputSchema: {
      name: z.string().describe(t("mcp.param.removeName")),
    },
  },
  wrap(async ({ name }) => {
    if (name === "env") {
      throw new UserError(
        t("mcp.envCannotRemove"),
      );
    }
    const existed = connections.has(name);
    if (!existed) {
      throw new UserError(t("mcp.removeMissing", { name, available: [...connections.keys()].join(", ") || t("common.none") }));
    }

    closePool(name);
    removeConnection(name);
    connections.delete(name);
    if (!connections.has(activeName)) activeName = connections.has("env") ? "env" : [...connections.keys()][0] || "";
    confirmed = false;
    confirmedFor = "";

    return text({
      deleted: name,
      active: activeName || null,
      remaining: [...connections.keys()],
      ...(connections.size ? { nota: t("mcp.removeNote") } : {}),
    });
  }),
);

server.registerTool(
  "reset_credentials",
  {
    title: t("mcp.tool.reset_credentials.title"),
    description: t("mcp.tool.reset_credentials.description"),
    inputSchema: {},
  },
  wrap(async () => {
    for (const name of [...pools.keys()]) closePool(name);
    const borrado = deleteStore();
    reloadConnections();
    confirmed = false;
    confirmedFor = "";

    return text({
      fileDeleted: borrado,
      file: storePath(),
      active: activeName || null,
      remaining: [...connections.keys()],
      nextStep: connections.size
        ? t("mcp.resetEnvLeft")
        : t("mcp.resetEmpty"),
    });
  }),
);

server.registerTool(
  "list_tables",
  {
    title: t("mcp.tool.list_tables.title"),
    description:
      t("mcp.tool.list_tables.description"),
    inputSchema: {
      schema: z.string().optional().describe(t("mcp.param.schema")),
      type: z.enum(["all", "table", "view"]).optional().describe(t("mcp.param.tableType")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ schema, type, connection }) => {
    requireConfirmation(connection);
    const { name, creds } = (() => {
      const n = resolveConnectionName(connection);
      return { name: n, creds: connections.get(n) };
    })();

    const target = schema || creds.database;
    const params = [];
    let filter = "";
    if (target) {
      filter = " AND table_schema = ?";
      params.push(target);
    }
    if (type === "table") filter += " AND table_type = 'BASE TABLE'";
    else if (type === "view") filter += " AND table_type = 'VIEW'";

    const [rows] = await getPool(name).query(
      `SELECT table_schema AS dbSchema, table_name AS dbTable, table_type AS dbType,
              engine AS engine, table_rows AS approxRows
         FROM information_schema.tables
        WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')${filter}
        ORDER BY table_schema, table_name`,
      params,
    );
    return text({
      connection: name,
      total: rows.length,
      schema: target || t("mcp.allSchemas"),
      type: type || "all",
      tables: sanitize(rows),
    });
  }),
);

server.registerTool(
  "describe_table",
  {
    title: t("mcp.tool.describe_table.title"),
    description: t("mcp.tool.describe_table.description"),
    inputSchema: {
      table: z.string().describe(t("mcp.param.table")),
      schema: z.string().optional().describe(t("mcp.param.schema")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ table, schema, connection }) => {
    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const target = schema || connections.get(name).database;
    if (!target) {
      throw new UserError(t("mcp.noSchema"));
    }

    const [columns] = await getPool(name).query(
      `SELECT column_name AS dbColumn, column_type AS dbType, is_nullable AS nullable,
              column_default AS defaultValue, column_key AS dbKey, extra AS extra
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`,
      [target, table],
    );
    if (!columns.length) throw new UserError(t("mcp.tableMissing", { schema: target, table: table }));

    const [indexes] = await getPool(name).query(
      `SELECT index_name AS dbIndex, non_unique AS notUnique, seq_in_index AS position,
              column_name AS dbColumn, index_type AS dbType
         FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = ?
        ORDER BY index_name, seq_in_index`,
      [target, table],
    );

    const [foreignKeys] = await getPool(name).query(
      `SELECT constraint_name AS dbConstraint, column_name AS dbColumn,
              referenced_table_schema AS referencedSchema,
              referenced_table_name AS referencedTable,
              referenced_column_name AS referencedColumn
         FROM information_schema.key_column_usage
        WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL
        ORDER BY constraint_name`,
      [target, table],
    );

    return text({
      connection: name,
      table: `${target}.${table}`,
      columns: sanitize(columns),
      indexes: sanitize(indexes),
      foreignKeys: sanitize(foreignKeys),
    });
  }),
);

server.registerTool(
  "list_databases",
  {
    title: t("mcp.tool.list_databases.title"),
    description: t("mcp.tool.list_databases.description"),
    inputSchema: {
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ connection }) => {
    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const [rows] = await getPool(name).query(
      `SELECT schema_name AS dbName, default_character_set_name AS charSet,
              default_collation_name AS collation
         FROM information_schema.schemata
        ORDER BY schema_name`,
    );
    return text({
      connection: name,
      total: rows.length,
      current: connections.get(name)?.database || null,
      databases: sanitize(rows).map((row) => ({ ...row, system: SYSTEM_SCHEMAS.has(row.dbName) })),
    });
  }),
);

server.registerTool(
  "search_schema",
  {
    title: t("mcp.tool.search_schema.title"),
    description: t("mcp.tool.search_schema.description"),
    inputSchema: {
      term: z.string().min(1).describe(t("mcp.param.term")),
      schema: z.string().optional().describe(t("mcp.param.schema")),
      limit: z.number().int().positive().max(500).optional().describe(t("mcp.param.limit")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ term, schema, limit, connection }) => {
    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const pattern = likeTerm(term);
    const max = limit || 50;
    const filter = schema ? " AND table_schema = ?" : "";
    const args = schema ? [pattern, schema] : [pattern];
    const pool = getPool(name);

    const [tables] = await pool.query(
      `SELECT table_schema AS dbSchema, table_name AS name, table_type AS kind
         FROM information_schema.tables
        WHERE table_name LIKE ?${filter}
        ORDER BY table_schema, table_name
        LIMIT ${max}`,
      args,
    );

    const [columns] = await pool.query(
      `SELECT table_schema AS dbSchema, table_name AS dbTable, column_name AS name, column_type AS dbType
         FROM information_schema.columns
        WHERE column_name LIKE ?${filter}
        ORDER BY table_schema, table_name, ordinal_position
        LIMIT ${max}`,
      args,
    );

    const routineFilter = schema ? " AND routine_schema = ?" : "";
    const [routines] = await pool.query(
      `SELECT routine_schema AS dbSchema, routine_name AS name, routine_type AS kind
         FROM information_schema.routines
        WHERE routine_name LIKE ?${routineFilter}
        ORDER BY routine_schema, routine_name
        LIMIT ${max}`,
      args,
    );

    const triggerFilter = schema ? " AND trigger_schema = ?" : "";
    const [triggers] = await pool.query(
      `SELECT trigger_schema AS dbSchema, trigger_name AS name, event_object_table AS dbTable,
              action_timing AS timing, event_manipulation AS eventName
         FROM information_schema.triggers
        WHERE trigger_name LIKE ?${triggerFilter}
        ORDER BY trigger_schema, trigger_name
        LIMIT ${max}`,
      args,
    );

    return text({
      connection: name,
      term,
      schema: schema || t("mcp.allSchemas"),
      total: tables.length + columns.length + routines.length + triggers.length,
      tables: sanitize(tables),
      columns: sanitize(columns),
      routines: sanitize(routines),
      triggers: sanitize(triggers),
    });
  }),
);

server.registerTool(
  "list_routines",
  {
    title: t("mcp.tool.list_routines.title"),
    description: t("mcp.tool.list_routines.description"),
    inputSchema: {
      type: z
        .enum(["all", "procedure", "function", "trigger", "event"])
        .optional()
        .describe(t("mcp.param.routineType")),
      schema: z.string().optional().describe(t("mcp.param.schema")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ type, schema, connection }) => {
    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const kind = type || "all";
    const pool = getPool(name);
    const model = schema || connections.get(name)?.database || undefined;
    const result = { connection: name, type: kind, schema: model || t("mcp.allSchemas") };

    if (kind === "all" || kind === "procedure" || kind === "function") {
      const filter = model ? " AND routine_schema = ?" : "";
      const args = model ? [model] : [];
      const typeFilter =
        kind === "procedure" ? " AND routine_type = 'PROCEDURE'" : kind === "function" ? " AND routine_type = 'FUNCTION'" : "";
      const [rows] = await pool.query(
        `SELECT routine_schema AS dbSchema, routine_name AS name, routine_type AS kind,
                definer, created, last_altered AS lastAltered, security_type AS securityType,
                is_deterministic AS isDeterministic, sql_data_access AS dataAccess,
                routine_comment AS routineComment
           FROM information_schema.routines
          WHERE routine_schema NOT IN ('mysql','information_schema','performance_schema','sys')${filter}${typeFilter}
          ORDER BY routine_schema, routine_type, routine_name`,
        args,
      );
      result.routines = sanitize(rows);
      result.routinesTotal = rows.length;
    }

    if (kind === "all" || kind === "trigger") {
      const filter = model ? " AND trigger_schema = ?" : "";
      const args = model ? [model] : [];
      const [rows] = await pool.query(
        `SELECT trigger_schema AS dbSchema, trigger_name AS name, event_object_table AS dbTable,
                action_timing AS timing, event_manipulation AS eventName, definer, created
           FROM information_schema.triggers
          WHERE trigger_schema NOT IN ('mysql','information_schema','performance_schema','sys')${filter}
          ORDER BY trigger_schema, trigger_name`,
        args,
      );
      result.triggers = sanitize(rows);
      result.triggersTotal = rows.length;
    }

    if (kind === "all" || kind === "event") {
      const filter = model ? " AND event_schema = ?" : "";
      const args = model ? [model] : [];
      const [rows] = await pool.query(
        `SELECT event_schema AS dbSchema, event_name AS name, status, event_type AS kind,
                interval_value AS everyValue, interval_field AS everyField, definer,
                last_executed AS lastExecuted
           FROM information_schema.events
          WHERE event_schema NOT IN ('mysql','information_schema','performance_schema','sys')${filter}
          ORDER BY event_schema, event_name`,
        args,
      );
      result.events = sanitize(rows);
      result.eventsTotal = rows.length;
    }

    return text(result);
  }),
);

server.registerTool(
  "show_create",
  {
    title: t("mcp.tool.show_create.title"),
    description: t("mcp.tool.show_create.description"),
    inputSchema: {
      type: z
        .enum(["table", "view", "procedure", "function", "trigger", "event"])
        .describe(t("mcp.param.objectType")),
      name: z.string().min(1).describe(t("mcp.param.objectName")),
      schema: z.string().optional().describe(t("mcp.param.schema")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ type, name: objectName, schema, connection }) => {
    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const target = targetSchema(name, schema);
    const ddl = await readCreate(name, type, target, objectName);
    return text({
      connection: name,
      [`${type}`]: `${target}.${objectName}`,
      ddl,
      runnable: /begin/i.test(ddl) ? t("mcp.showCreate.runnableNote") : t("mcp.showCreate.directNote"),
    });
  }),
);

server.registerTool(
  "export_schema",
  {
    title: t("mcp.tool.export_schema.title"),
    description: t("mcp.tool.export_schema.description"),
    inputSchema: {
      schema: z.string().optional().describe(t("mcp.param.schema")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ schema, connection }) => {
    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const target = targetSchema(name, schema);
    const pool = getPool(name);
    const MAX_OBJECTS = 500;

    const [tables] = await pool.query(
      `SELECT table_name AS name, table_type AS kind
         FROM information_schema.tables
        WHERE table_schema = ?
        ORDER BY table_type, table_name`,
      [target],
    );
    const [routines] = await pool.query(
      `SELECT routine_name AS name, routine_type AS kind
         FROM information_schema.routines
        WHERE routine_schema = ?
        ORDER BY routine_type, routine_name`,
      [target],
    );
    const [triggers] = await pool.query(
      `SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema = ? ORDER BY trigger_name`,
      [target],
    );
    const [events] = await pool.query(
      `SELECT event_name AS name FROM information_schema.events WHERE event_schema = ? ORDER BY event_name`,
      [target],
    );

    const objects =
      tables.length + routines.length + triggers.length + events.length;
    const truncated = objects > MAX_OBJECTS;
    const sliced = {
      tables: tables.slice(0, MAX_OBJECTS),
      routines: routines.slice(0, MAX_OBJECTS),
      triggers: triggers.slice(0, MAX_OBJECTS),
      events: events.slice(0, MAX_OBJECTS),
    };

    const parts = [`-- ${target}`, `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(target)};`, `USE ${quoteIdentifier(target)};`, ""];

    for (const item of sliced.tables) {
      const ddl = await readCreate(name, item.kind === "VIEW" ? "view" : "table", target, item.name);
      parts.push(`DROP ${item.kind === "VIEW" ? "VIEW" : "TABLE"} IF EXISTS ${quoteIdentifier(item.name)};`, `${ddl};`, "");
    }

    for (const item of sliced.routines) {
      const ddl = await readCreate(name, item.kind === "FUNCTION" ? "function" : "procedure", target, item.name);
      parts.push("DELIMITER ;;", `${ddl};;`, "DELIMITER ;", "");
    }
    for (const item of sliced.triggers) {
      const ddl = await readCreate(name, "trigger", target, item.name);
      parts.push("DELIMITER ;;", `${ddl};;`, "DELIMITER ;", "");
    }
    for (const item of sliced.events) {
      const ddl = await readCreate(name, "event", target, item.name);
      parts.push("DELIMITER ;;", `${ddl};;`, "DELIMITER ;", "");
    }

    return text({
      connection: name,
      schema: target,
      objects: {
        tables: sliced.tables.filter((item) => item.kind !== "VIEW").length,
        views: sliced.tables.filter((item) => item.kind === "VIEW").length,
        routines: sliced.routines.length,
        triggers: sliced.triggers.length,
        events: sliced.events.length,
      },
      truncated,
      ...(truncated ? { warning: t("mcp.exportSchema.truncated", { max: MAX_OBJECTS }) } : {}),
      ddl: parts.join("\n"),
    });
  }),
);

server.registerTool(
  "explain_query",
  {
    title: t("mcp.tool.explain_query.title"),
    description: t("mcp.tool.explain_query.description"),
    inputSchema: {
      sql: z.string().describe(t("mcp.param.sqlRead")),
      analyze: z.boolean().optional().describe(t("mcp.param.analyze")),
      format: z.enum(["traditional", "json", "tree"]).optional().describe(t("mcp.param.explainFormat")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ sql, analyze, format, connection }) => {
    if (classify(sql) !== "read") {
      throw new UserError(t("mcp.explain.readOnly"));
    }
    if (analyze && !/^select\b/i.test(normalizar(sql))) {
      throw new UserError(t("mcp.explain.analyzeSelect"));
    }
    requireConfirmation(connection);
    const name = resolveConnectionName(connection);

    const statement = normalizar(sql);
    const prefix = analyze
      ? "EXPLAIN ANALYZE "
      : format === "json"
        ? "EXPLAIN FORMAT=JSON "
        : format === "tree"
          ? "EXPLAIN FORMAT=TREE "
          : "EXPLAIN ";

    const result = await runRead(prefix + statement, name, 500);
    return text({
      connection: name,
      statement,
      mode: analyze ? "analyze" : `explain${format && format !== "traditional" ? ":" + format : ""}`,
      hints: explainHints(result.data),
      ...result,
    });
  }),
);

server.registerTool(
  "propose_script",
  {
    title: t("mcp.tool.propose_script.title"),
    description: t("mcp.tool.propose_script.description"),
    inputSchema: {
      script: z.string().describe(t("mcp.param.script")),
      reason: z.string().optional().describe(t("mcp.param.reason")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ script, reason, connection }) => {
    if (!CONFIG.writeEnabled) throw new UserError(t("mcp.writeDisabled"));

    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const statements = splitStatements(script);
    if (!statements.length) throw new UserError(t("mcp.script.empty"));
    if (statements.length > CONFIG.maxScriptStatements) {
      throw new UserError(t("mcp.script.tooMany", { max: CONFIG.maxScriptStatements, total: statements.length }));
    }

    const plan = statements.map((statement, index) => {
      const kind = classify(statement); // lanza con el error de clasificación
      if (kind !== "write") {
        throw new UserError(
          t("mcp.script.notWrite", { index: index + 1, statement: normalizar(statement).slice(0, 120) }),
        );
      }
      return {
        index: index + 1,
        statement: normalizar(statement),
        fullTable: isUpdateWithoutWhere(statement),
        destructive: /^(drop|truncate)\b/i.test(normalizar(statement)),
        call: /^call\b/i.test(normalizar(statement)),
      };
    });

    purgeTokens();
    const token = crypto.randomUUID();
    pendingTokens.set(token, {
      hash: hashOf(script),
      statement: plan.map((item) => item.statement).join(";\n"),
      connection: name,
      reason: reason || null,
      statements: plan.length,
      fullTable: plan.some((item) => item.fullTable),
      expiraEn: Date.now() + CONFIG.confirmTtl * 1000,
    });

    const warnings = [t("mcp.script.noRollback")];
    if (plan.some((item) => item.fullTable)) warnings.push(t("mcp.warn.fullTable"));
    if (plan.some((item) => item.destructive)) warnings.push(t("mcp.warn.destructive"));
    if (plan.some((item) => item.call)) warnings.push(t("mcp.warn.call"));

    return text({
      status: t("mcp.state.pending"),
      connection: name,
      target: describeConnection(connections.get(name)),
      statements: plan.length,
      plan,
      reason: reason || null,
      warnings,
      token,
      validForSeconds: CONFIG.confirmTtl,
      nextStep: t("mcp.script.nextShow"),
    });
  }),
);

server.registerTool(
  "confirm_script",
  {
    title: t("mcp.tool.confirm_script.title"),
    description: t("mcp.tool.confirm_script.description"),
    inputSchema: {
      script: z.string().describe(t("mcp.param.scriptConfirm")),
      token: z.string().describe(t("mcp.param.token")),
      allow_full_table: z.boolean().optional().describe(t("mcp.param.allowFullTable")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ script, token, allow_full_table, connection }) => {
    if (!CONFIG.writeEnabled) throw new UserError(t("mcp.writeDisabled"));

    purgeTokens();
    const pendingToken = pendingTokens.get(token);
    if (!pendingToken) throw new UserError(t("mcp.tokenInvalid"));
    if (pendingToken.hash !== hashOf(script)) throw new UserError(t("mcp.statementMismatch"));
    if (connection && connection !== pendingToken.connection) {
      throw new UserError(
        t("mcp.connectionMismatch", { propuesta: pendingToken.connection, pedida: connection }),
      );
    }
    if (pendingToken.fullTable && allow_full_table !== true) {
      throw new UserError(t("mcp.fullTable"));
    }

    pendingTokens.delete(token);
    const statements = splitStatements(script);
    const results = [];
    let failedAt = null;

    for (const [index, statement] of statements.entries()) {
      try {
        const result = await runWrite(statement, pendingToken.connection);
        results.push({ index: index + 1, statement: normalizar(statement), ok: true, result });
      } catch (error) {
        const message = formatError(error);
        results.push({ index: index + 1, statement: normalizar(statement), ok: false, error: message });
        failedAt = index + 1;
        break;
      }
    }

    return text({
      status: failedAt ? t("mcp.script.failedStatus") : t("mcp.state.executed"),
      connection: pendingToken.connection,
      target: describeConnection(connections.get(pendingToken.connection) || {}),
      statements: statements.length,
      executed: results.filter((item) => item.ok).length,
      failedAt,
      results,
      token_consumido: true,
    });
  }),
);

server.registerTool(
  "validate_sql",
  {
    title: t("mcp.tool.validate_sql.title"),
    description: t("mcp.tool.validate_sql.description"),
    inputSchema: {
      sql: z.string().describe(t("mcp.param.sqlValidate")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ sql, connection }) => {
    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const kind = classify(sql); // lanza si la sentencia no está permitida
    const statement = normalizar(sql);
    const base = {
      connection: name,
      kind,
      statement,
      executableWith: kind === "read" ? "query_read" : "propose_write",
    };

    const check = await prepareOnly(statement, name);

    if (!check.ok) {
      if (check.code === "ER_UNSUPPORTED_PS") {
        return text({ ...base, valid: null, serverCheck: false, note: t("mcp.validate.notPreparable") });
      }
      return text({
        ...base,
        valid: false,
        serverCheck: true,
        error: check.error,
        ...(check.hint ? { hint: check.hint } : {}),
      });
    }

    const answer = { ...base, valid: true, serverCheck: true };

    if (/^(select|with|update|delete|insert|replace)\b/i.test(statement)) {
      // El plan no ejecuta nada: solo describe cómo lo haría el optimizador.
      const plan = await explainOnly(statement, name, 200);
      answer.hints = explainHints(plan.data);
      answer.plan = plan.data;
      answer.planColumns = plan.columns;
      answer.note = t("mcp.validate.ok");
    } else {
      answer.note = t("mcp.validate.ddlNote");
    }

    if (kind === "write") answer.warning = t("mcp.validate.writeNotRun");
    return text(answer);
  }),
);

server.registerTool(
  "query_read",
  {
    title: t("mcp.tool.query_read.title"),
    description:
      t("mcp.tool.query_read.description"),
    inputSchema: {
      sql: z.string().describe(t("mcp.param.sqlRead")),
      max_rows: z.number().int().positive().optional().describe(t("mcp.param.maxRows", { max: CONFIG.maxRows })),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ sql, max_rows, connection }) => {
    if (classify(sql) !== "read") {
      throw new UserError(
        t("mcp.readOnlyChannel"),
      );
    }
    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const limit = Math.min(max_rows || CONFIG.maxRows, 5000);
    const result = await runRead(sql, name, limit);
    return text({ connection: name, ...result });
  }),
);

server.registerTool(
  "propose_write",
  {
    title: t("mcp.tool.propose_write.title"),
    description:
      t("mcp.tool.propose_write.description"),
    inputSchema: {
      sql: z.string().describe(t("mcp.param.sqlWrite")),
      reason: z.string().optional().describe(t("mcp.param.reason")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ sql, reason, connection }) => {
    if (classify(sql) !== "write") {
      throw new UserError(t("mcp.writeIsRead"));
    }
    if (!CONFIG.writeEnabled) {
      throw new UserError(t("mcp.writeDisabled"));
    }

    requireConfirmation(connection);
    const name = resolveConnectionName(connection);
    const statement = normalizar(sql);
    const impact = await estimateImpact(statement, name);

    purgeTokens();
    const token = crypto.randomUUID();
    pendingTokens.set(token, {
      hash: hashOf(statement),
      statement,
      connection: name,
      reason: reason || null,
      expiraEn: Date.now() + CONFIG.confirmTtl * 1000,
    });

    const warnings = [];
    if (isUpdateWithoutWhere(statement)) {
      warnings.push(
        t("mcp.warn.fullTable"),
      );
    }
    if (/^(drop|truncate)\b/i.test(statement)) {
      warnings.push(t("mcp.warn.destructive"));
    }
    if (/^call\b/i.test(statement)) {
      warnings.push(t("mcp.warn.call"));
    }

    return text({
      status: t("mcp.state.pending"),
      connection: name,
      target: describeConnection(connections.get(name)),
      statement,
      reason: reason || null,
      impact,
      warnings,
      token,
      validForSeconds: CONFIG.confirmTtl,
      nextStep:
        t("mcp.nextShow"),
    });
  }),
);

server.registerTool(
  "confirm_write",
  {
    title: t("mcp.tool.confirm_write.title"),
    description:
      t("mcp.tool.confirm_write.description"),
    inputSchema: {
      sql: z.string().describe(t("mcp.param.sqlConfirm")),
      token: z.string().describe(t("mcp.param.token")),
      allow_full_table: z
        .boolean()
        .optional()
        .describe(t("mcp.param.allowFullTable")),
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ sql, token, allow_full_table, connection }) => {
    if (!CONFIG.writeEnabled) {
      throw new UserError(t("mcp.writeDisabled"));
    }
    if (classify(sql) !== "write") throw new UserError(t("mcp.writeIsWrite"));

    purgeTokens();
    const pendingToken = pendingTokens.get(token);
    if (!pendingToken) {
      throw new UserError(
        t("mcp.tokenInvalid"),
      );
    }
    if (pendingToken.hash !== hashOf(sql)) {
      throw new UserError(t("mcp.statementMismatch"));
    }
    if (connection && connection !== pendingToken.connection) {
      throw new UserError(
        t("mcp.connectionMismatch", { propuesta: pendingToken.connection, pedida: connection }),
      );
    }
    if (isUpdateWithoutWhere(sql) && allow_full_table !== true) {
      throw new UserError(
        t("mcp.fullTable"),
      );
    }

    pendingTokens.delete(token);
    const result = await runWrite(sql, pendingToken.connection);
    return text({
      status: t("mcp.state.executed"),
      connection: pendingToken.connection,
      target: describeConnection(connections.get(pendingToken.connection) || {}),
      statement: normalizar(sql),
      result,
      token_consumido: true,
    });
  }),
);

/** ------------------------------------------------------------------ */

export async function startServer() {
  reloadConnections();
  watchStore();

  const transporte = new StdioServerTransport();
  await server.connect(transporte);
  console.error(
    `[mcp-mysql] ready -> connections=${[...connections.keys()].join(",") || "(none)"} active=${activeName || "-"} writes=${CONFIG.writeEnabled ? "on" : "off"}`,
  );

  if (!connections.size && bool(process.env.MYSQL_PROMPT_ON_START, true)) {
    const result = await openConnectionForm();
    console.error("[mcp-mysql] no connections:", result.url || result.message);
  }
}

if (isEntryPoint(import.meta.url)) {
  await startServer();
}
