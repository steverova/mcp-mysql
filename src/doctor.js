#!/usr/bin/env node
/**
 * MySQL connection diagnostics. Cross-platform, read-only.
 *
 *   npm run doctor                 test the active connection
 *   npm run doctor -- --name sales
 *   npm run doctor -- --all        test all of them
 */
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore, storePath } from "./store.js";
import { runCli, isEntryPoint } from "./cli-util.js";
import { t } from "./i18n.js";

export async function runDoctor(args = process.argv.slice(2)) {
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let envFile = null;
for (const candidato of [
  path.join(ROOT, ".env"),
  path.join(process.cwd(), ".env"),
  path.join(path.dirname(process.execPath), ".env"),
]) {
  try {
    process.loadEnvFile(candidato);
    envFile = candidato;
    break;
  } catch {
    // Try the next candidate.
  }
}

if (!envFile) console.log(t("doctor.noEnv"));

const bool = (value, porDefecto) =>
  value === undefined ? porDefecto : /^(1|true|yes|on)$/i.test(String(value));

const pedirTodas = args.includes("--all");
const nameIndex = args.indexOf("--name");
const requestedName = nameIndex >= 0 ? args[nameIndex + 1] : undefined;

const connections = new Map();

if (process.env.MYSQL_USER) {
  connections.set("env", {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || undefined,
    ssl: bool(process.env.MYSQL_SSL, false),
  });
}

let store = { active: "", connections: {} };
try {
  store = loadStore();
} catch (error) {
  console.error(error.message);
}
for (const [name, creds] of Object.entries(store.connections)) {
  if (!connections.has(name)) connections.set(name, creds);
}

console.log(`${t("doctor.file")} : ${storePath()}`);
console.log(`${t("doctor.writes")}: ${bool(process.env.MYSQL_WRITE_ENABLED, true) ? t("doctor.writesOn") : t("doctor.writesOff")}`);
console.log("");

if (!connections.size) {
  console.error(t("doctor.noConnections"));
  process.exit(1);
}

const names = pedirTodas
  ? [...connections.keys()]
  : [requestedName || store.active || [...connections.keys()][0]];

let failures = 0;

for (const name of names) {
  const creds = connections.get(name);
  if (!creds) {
    console.error(t("doctor.missing", { name }));
    failures++;
    continue;
  }

  const activeMarker = name === store.active ? t("doctor.active") : "";
  console.log(`── ${name}${activeMarker} · ${creds.user}@${creds.host}:${creds.port}/${creds.database || t("common.noDatabase")}`);

  let connection;
  try {
    connection = await mysql.createConnection({
      host: creds.host,
      port: Number(creds.port) || 3306,
      user: creds.user,
      password: creds.password,
      database: creds.database || undefined,
      ssl: creds.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10000,
      multipleStatements: false,
    });
  } catch (error) {
    console.error(`   ${t("doctor.fail")}: ${error.code || ""} ${error.sqlMessage || error.message}`);
    if (error.code === "ECONNREFUSED") console.error(`     -> ${t("doctor.hint.refused")}`);
    if (error.code === "ER_ACCESS_DENIED_ERROR") console.error(`     -> ${t("doctor.hint.denied")}`);
    if (error.code === "ER_BAD_DB_ERROR") console.error(`     -> ${t("doctor.hint.badDb")}`);
    if (error.code === "ETIMEDOUT") console.error(`     -> ${t("doctor.hint.timeout")}`);
    if (error.code === "ENOTFOUND") console.error(`     -> ${t("doctor.hint.dns")}`);
    failures++;
    continue;
  }

  try {
    const [[info]] = await connection.query(
      "SELECT VERSION() AS version, DATABASE() AS currentDatabase, CURRENT_USER() AS dbUser",
    );
    const [tables] = await connection.query(
      `SELECT table_schema AS dbSchema, COUNT(*) AS total
         FROM information_schema.tables
        WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
          AND (? IS NULL OR table_schema = ?)
        GROUP BY table_schema ORDER BY dbSchema`,
      [creds.database || null, creds.database || null],
    );

    console.log("   " + t("doctor.ok", {
      version: info.version,
      user: info.dbUser,
      base: info.currentDatabase || t("doctor.noBase"),
    }));
    if (tables.length) {
      for (const row of tables) {
        console.log("       " + t("doctor.tables", { schema: row.dbSchema, total: row.total }));
      }
    }

    await connection.query("START TRANSACTION READ ONLY");
    await connection.query("SELECT 1");
    await connection.query("ROLLBACK");

    const [permisos] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
    const grantsText = permisos.map((row) => Object.values(row).join(" ")).join("\n");
    const canWrite = /ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP/i.test(grantsText);
    console.log(`   ${t("doctor.privileges")}: ${canWrite ? t("doctor.canWrite") : t("doctor.readOnly")}`);
  } catch (error) {
    console.error(`   ${t("doctor.fail")}: ${error.code || ""} ${error.sqlMessage || error.message}`);
    failures++;
  } finally {
    await connection.end();
  }
}

console.log("");
if (failures) {
  console.error(t("doctor.summaryFail", { total: failures }));
  process.exit(1);
}
console.log(t("doctor.summaryOk"));
}

if (isEntryPoint(import.meta.url)) {
  runCli(() => runDoctor());
}
