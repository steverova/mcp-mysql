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

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)--[^\n]*/g, "$1 ")
    .replace(/(^|\s)#[^\n]*/g, "$1 ");
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
]);

const SNEAKY_WRITE =
  /\b(into\s+(out|dump)file|for\s+update|lock\s+in\s+share\s+mode|\binsert\b|\bupdate\b|\bdelete\b|\breplace\b|\bcreate\b|\balter\b|\bdrop\b|\btruncate\b|\brename\b|\bgrant\b|\brevoke\b|\bcall\b|\bload\s+data\b)\b/i;

/** "read" | "write", o lanza UserError. */
function classify(rawSql) {
  if (typeof rawSql !== "string" || !rawSql.trim()) {
    throw new UserError(t("mcp.sql.empty"));
  }
  const cleaned = stripComments(rawSql).trim().replace(/;+\s*$/, "");
  if (!cleaned) throw new UserError(t("mcp.sql.empty"));
  if (cleaned.includes(";")) {
    throw new UserError(t("mcp.sql.oneStatement"));
  }

  const first = (cleaned.match(/^[a-z]+/i)?.[0] || "").toLowerCase();

  if (READ_FIRST.has(first)) {
    if (first !== "show" && first !== "describe" && first !== "desc" && SNEAKY_WRITE.test(cleaned)) {
      throw new UserError(
        t("mcp.sql.sneakyWrite"),
      );
    }
    return "read";
  }

  if (first === "with") {
    return /\b(insert|update|delete|replace)\b/i.test(cleaned) ? "write" : "read";
  }

  if (WRITE_FIRST.has(first)) return "write";

  throw new UserError(
    t("mcp.sql.notAllowed", { verbo: first || "?" }),
  );
}

const normalizar = (sql) => stripComments(sql).trim().replace(/;+\s*$/, "").replace(/\s+/g, " ");
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
  try {
    await conn.query("START TRANSACTION READ ONLY");
    let result;
    try {
      const [rows, fields] = await conn.query(sql);
      result = { rows, fields };
    } finally {
      await conn.query("ROLLBACK").catch(() => {});
    }

    const { rows, fields } = result;
    if (!Array.isArray(rows)) return { type: "result", ...sanitize(rows) };

    const columns = (fields || []).map((field) => field.name);
    const truncated = rows.length > limit;
    const limitedRows = sanitize(rows.slice(0, limit));

    return {
      rows: limitedRows.length,
      columns,
      truncated,
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
// Server
/** ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "mysql", version: "2.0.0" },
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
      connection: z.string().optional().describe(t("mcp.param.connection")),
    },
  },
  wrap(async ({ schema, connection }) => {
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
