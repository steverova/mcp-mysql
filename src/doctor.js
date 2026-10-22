#!/usr/bin/env node
/**
 * Diagnóstico de conexiones MySQL. Multiplataforma, solo lectura.
 *
 *   npm run doctor                 prueba la conexión activa
 *   npm run doctor -- --name ventas
 *   npm run doctor -- --all        prueba todas
 */
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore, storePath } from "./store.js";
import { arrancar, esEntrada } from "./cli-util.js";

export async function ejecutarDoctor(argumentos = process.argv.slice(2)) {
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let archivoEnv = null;
for (const candidato of [
  path.join(ROOT, ".env"),
  path.join(process.cwd(), ".env"),
  path.join(path.dirname(process.execPath), ".env"),
]) {
  try {
    process.loadEnvFile(candidato);
    archivoEnv = candidato;
    break;
  } catch {
    // Se prueba el siguiente candidato.
  }
}

if (!archivoEnv) console.log("(sin .env: usando variables de entorno del proceso)");

const bool = (valor, porDefecto) =>
  valor === undefined ? porDefecto : /^(1|true|yes|on)$/i.test(String(valor));

const pedirTodas = argumentos.includes("--all");
const indiceNombre = argumentos.indexOf("--name");
const nombrePedido = indiceNombre >= 0 ? argumentos[indiceNombre + 1] : undefined;

const conexiones = new Map();

// Perfil desde variables de entorno
if (process.env.MYSQL_USER) {
  conexiones.set("env", {
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
  console.error(`No se pudo leer el almacén: ${error.message}`);
}
for (const [nombre, credenciales] of Object.entries(store.connections)) {
  if (!conexiones.has(nombre)) conexiones.set(nombre, credenciales);
}

console.log(`Archivo : ${storePath()}`);
console.log(`Escritura: ${bool(process.env.MYSQL_WRITE_ENABLED, true) ? "habilitada (con confirmación)" : "deshabilitada"}`);
console.log("");

if (!conexiones.size) {
  console.error("FALLO: no hay conexiones. Ejecuta `npm run login` o define MYSQL_USER en .env.");
  process.exit(1);
}

const nombres = pedirTodas
  ? [...conexiones.keys()]
  : [nombrePedido || store.active || [...conexiones.keys()][0]];

let fallos = 0;

for (const nombre of nombres) {
  const credenciales = conexiones.get(nombre);
  if (!credenciales) {
    console.error(`FALLO: no existe la conexión "${nombre}".`);
    fallos++;
    continue;
  }

  const marcaActiva = nombre === store.active ? " (activa)" : "";
  console.log(`── ${nombre}${marcaActiva} · ${credenciales.user}@${credenciales.host}:${credenciales.port}/${credenciales.database || "(sin base)"}`);

  let conexion;
  try {
    conexion = await mysql.createConnection({
      host: credenciales.host,
      port: Number(credenciales.port) || 3306,
      user: credenciales.user,
      password: credenciales.password,
      database: credenciales.database || undefined,
      ssl: credenciales.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10000,
      multipleStatements: false,
    });
  } catch (error) {
    console.error(`   FALLO: ${error.code || ""} ${error.sqlMessage || error.message}`);
    if (error.code === "ECONNREFUSED") console.error("     -> no hay nada escuchando en esa IP/puerto.");
    if (error.code === "ER_ACCESS_DENIED_ERROR") console.error("     -> usuario o contraseña incorrectos.");
    if (error.code === "ER_BAD_DB_ERROR") console.error("     -> la base de datos no existe.");
    if (error.code === "ETIMEDOUT") console.error("     -> timeout: firewall, red o VPN.");
    if (error.code === "ENOTFOUND") console.error("     -> el host no resuelve por DNS.");
    fallos++;
    continue;
  }

  try {
    const [[info]] = await conexion.query(
      "SELECT VERSION() AS version, DATABASE() AS base, CURRENT_USER() AS usuario",
    );
    const [tablas] = await conexion.query(
      `SELECT table_schema AS esquema, COUNT(*) AS total
         FROM information_schema.tables
        WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
          AND (? IS NULL OR table_schema = ?)
        GROUP BY table_schema ORDER BY esquema`,
      [credenciales.database || null, credenciales.database || null],
    );

    console.log(`   OK  MySQL ${info.version} · usuario ${info.usuario} · base ${info.base || "(ninguna)"}`);
    if (tablas.length) {
      for (const fila of tablas) console.log(`       ${fila.esquema}: ${fila.total} tablas`);
    }

    await conexion.query("START TRANSACTION READ ONLY");
    await conexion.query("SELECT 1");
    await conexion.query("ROLLBACK");

    const [permisos] = await conexion.query("SHOW GRANTS FOR CURRENT_USER()");
    const plano = permisos.map((fila) => Object.values(fila).join(" ")).join("\n");
    const puedeEscribir = /ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP/i.test(plano);
    console.log(`   Permisos: ${puedeEscribir ? "puede escribir" : "solo lectura (las escrituras fallarán)"}`);
  } catch (error) {
    console.error(`   FALLO: ${error.code || ""} ${error.sqlMessage || error.message}`);
    fallos++;
  } finally {
    await conexion.end();
  }
}

console.log("");
if (fallos) {
  console.error(`${fallos} conexión(es) con problemas`);
  process.exit(1);
}
console.log("Todas las conexiones probadas correctamente");
}

if (esEntrada(import.meta.url)) {
  arrancar(() => ejecutarDoctor());
}
