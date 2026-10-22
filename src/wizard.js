#!/usr/bin/env node
/**
 * Asistente de terminal (TUI) para gestionar conexiones MySQL.
 * Multiplataforma: Windows, macOS y Linux. Solo necesita un terminal.
 *
 *   npm run login                 crear o editar una conexión
 *   npm run login -- --list       listar conexiones
 *   npm run login -- --use nombre activar una conexión
 *   npm run logout                borrar todas
 *   npm run logout -- nombre      borrar una
 */
import readline from "node:readline/promises";
import mysql from "mysql2/promise";
import {
  deleteStore,
  loadStore,
  removeConnection,
  setActiveConnection,
  storePath,
  upsertConnection,
  validarNombre,
} from "./store.js";

const color = (codigo, texto) =>
  process.stdout.isTTY ? `\x1b[${codigo}m${texto}\x1b[0m` : texto;
const titulo = (texto) => color("1;36", texto);
const ok = (texto) => color("32", texto);
const aviso = (texto) => color("33", texto);
const error = (texto) => color("31", texto);
const tenue = (texto) => color("90", texto);

const argumentos = process.argv.slice(2);
const bandera = (nombre) => argumentos.includes(nombre);
const valorDe = (nombre) => {
  const indice = argumentos.indexOf(nombre);
  return indice >= 0 ? argumentos[indice + 1] : undefined;
};

const store = loadStore();
const nombres = Object.keys(store.connections);

/** ------------------------------------------------------------------ */
/** Comandos no interactivos                                          */
/** ------------------------------------------------------------------ */

if (bandera("--status")) {
  if (!nombres.length) {
    console.log(tenue("Sin conexiones todavía.") + "  Crea una con: " + titulo("mysql-mcp add"));
    process.exit(0);
  }
  const activa = store.connections[store.active] || store.connections[nombres[0]];
  const base = activa.database || tenue("(sin base por defecto: se ven todas)");
  console.log(titulo("BD actual:"));
  console.log(`  conexión : ${store.active || nombres[0]}`);
  console.log(`  servidor : ${activa.user}@${activa.host}:${activa.port}`);
  console.log(`  base     : ${base}`);
  console.log(`  TLS      : ${activa.ssl ? "sí" : "no"}`);
  console.log(tenue(`  archivo  : ${storePath()}`));
  const otras = nombres.filter((n) => n !== store.active);
  if (otras.length) console.log(tenue(`  otras    : ${otras.join(", ")}  → mysql-mcp use <nombre>`));
  process.exit(0);
}

if (bandera("--list")) {
  if (!nombres.length) {
    console.log(tenue(`No hay conexiones guardadas (${storePath()}).`));
    process.exit(0);
  }
  console.log(titulo("Conexiones guardadas:"), tenue(storePath()));
  for (const nombre of nombres) {
    const c = store.connections[nombre];
    const marca = nombre === store.active ? ok("* ") : "  ";
    console.log(`${marca}${nombre.padEnd(18)} ${c.user}@${c.host}:${c.port}/${c.database || "(sin base)"}${c.ssl ? " [TLS]" : ""}`);
  }
  process.exit(0);
}

if (bandera("--use")) {
  const nombre = valorDe("--use");
  if (!nombre || !store.connections[nombre]) {
    console.error(error(`No existe la conexión "${nombre || ""}". Disponibles: ${nombres.join(", ") || "(ninguna)"}.`));
    process.exit(1);
  }
  setActiveConnection(nombre);
  console.log(ok(`Conexión activa: ${nombre}`));
  process.exit(0);
}

if (bandera("--delete") || argumentos[0] === "delete") {
  const nombre = valorDe("--delete") || argumentos.find((a) => !a.startsWith("-") && a !== "delete");

  if (bandera("--all") || bandera("-a")) {
    const borrado = deleteStore();
    console.log(borrado ? ok("Todas las conexiones borradas.") : tenue("No había conexiones guardadas."));
    process.exit(0);
  }

  if (!nombre) {
    console.error(error("Indica qué conexión borrar, o usa --all para borrar todas."));
    console.error(tenue("  mysql-mcp remove ventas"));
    console.error(tenue("  mysql-mcp remove --all"));
    process.exit(1);
  }

  const resultado = removeConnection(nombre);
  console.log(resultado.borrada ? ok(`Conexión "${nombre}" borrada.`) : aviso(`No existía "${nombre}".`));
  process.exit(resultado.borrada ? 0 : 1);
}

/** ------------------------------------------------------------------ */
/** Asistente interactivo                                             */
/** ------------------------------------------------------------------ */

if (!process.stdin.isTTY) {
  console.error(
    error("No hay terminal interactiva.") +
      "\nUsa el formulario web (herramienta save_connection desde OpenCode) o define MYSQL_USER/MYSQL_PASSWORD.",
  );
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function preguntar(texto, porDefecto = "") {
  const sufijo = porDefecto !== "" ? tenue(` [${porDefecto}]`) : "";
  const respuesta = (await rl.question(`${texto}${sufijo}: `)).trim();
  return respuesta || porDefecto;
}

async function preguntarSecreto(texto) {
  rl.pause();
  process.stdout.write(`${texto}: `);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    let valor = "";

    const limpiar = () => {
      stdin.removeListener("data", alEscribir);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      rl.resume();
    };

    const alEscribir = (buffer) => {
      for (const caracter of buffer.toString("utf8")) {
        if (caracter === "\r" || caracter === "\n") {
          limpiar();
          process.stdout.write("\n");
          resolve(valor);
          return;
        }
        if (caracter === "\u0003") {
          limpiar();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (caracter === "\u007f" || caracter === "\b") {
          if (valor) {
            valor = valor.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (caracter >= " ") {
          valor += caracter;
          process.stdout.write("*");
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", alEscribir);
  });
}

async function preguntarSi(texto, porDefecto = true) {
  const respuesta = (await preguntar(`${texto} (s/n)`, porDefecto ? "s" : "n")).toLowerCase();
  return respuesta.startsWith("s") || respuesta.startsWith("y");
}

async function elegir(mensaje, accion) {
  if (!nombres.length) {
    console.log(tenue("No hay conexiones guardadas.") + "  Crea una con: " + titulo("mysql-mcp add"));
    rl.close();
    process.exit(0);
  }

  console.log("");
  console.log(titulo("Conexiones:"));
  nombres.forEach((nombre, indice) => {
    const c = store.connections[nombre];
    const marca = nombre === store.active ? ok("*") : " ";
    console.log(
      `  ${marca} ${String(indice + 1).padStart(2)}. ${nombre.padEnd(18)} ${tenue(
        `${c.user}@${c.host}:${c.port}/${c.database || "(sin base)"}`,
      )}`,
    );
  });
  console.log("");

  const entrada = (await preguntar(mensaje)).trim();
  if (!entrada) {
    rl.close();
    process.exit(0);
  }

  const numero = Number(entrada);
  const elegido =
    Number.isInteger(numero) && numero >= 1 && numero <= nombres.length ? nombres[numero - 1] : entrada;

  if (!store.connections[elegido]) {
    console.error(error(`No existe la conexión "${elegido}".`));
    rl.close();
    process.exit(1);
  }

  await accion(elegido);
  rl.close();
  process.exit(0);
}

if (bandera("--select")) {
  await elegir("Número o nombre a activar", async (nombre) => {
    setActiveConnection(nombre);
    const c = loadStore().connections[nombre];
    console.log("");
    console.log(ok(`BD actual: ${nombre}`));
    console.log(`  ${c.user}@${c.host}:${c.port}/${c.database || "(sin base)"}`);
    console.log(tenue("OpenCode lo reconocerá y te pedirá confirmación al empezar a consultar."));
  });
}

if (bandera("--remove-pick")) {
  await elegir("Número o nombre a borrar", async (nombre) => {
    removeConnection(nombre);
    console.log("");
    console.log(ok(`Conexión "${nombre}" borrada.`));
    const resto = Object.keys(loadStore().connections);
    console.log(tenue(resto.length ? `Quedan: ${resto.join(", ")}` : "No queda ninguna conexión."));
  });
}

console.log("");
console.log(titulo("  Conexiones MySQL") + tenue("  ·  asistente de terminal"));
console.log(tenue(`  archivo: ${storePath()}`));
console.log("");

if (nombres.length) {
  console.log("Guardadas:");
  for (const nombre of nombres) {
    const c = store.connections[nombre];
    console.log(`  ${nombre === store.active ? ok("*") : " "} ${nombre.padEnd(18)} ${tenue(`${c.user}@${c.host}:${c.port}/${c.database || "(sin base)"}`)}`);
  }
  console.log("");
}

const actual = store.active && store.connections[store.active] ? store.connections[store.active] : null;

const nombre = await preguntar(
  "Nombre de la conexión",
  process.env.MCP_MYSQL_DEFAULT_NAME || store.active || nombres[0] || "local",
);
const problema = validarNombre(nombre);
if (problema) {
  console.error(error(problema));
  rl.close();
  process.exit(1);
}

const existente = store.connections[nombre] || actual || {};
const host = await preguntar("Host", existente.host || "127.0.0.1");
const puertoTexto = await preguntar("Puerto", String(existente.port || 3306));
const puerto = Number(puertoTexto);
if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
  console.error(error("Puerto no válido."));
  rl.close();
  process.exit(1);
}

const usuario = await preguntar("Usuario", existente.user || "");
if (!usuario) {
  console.error(error("El usuario es obligatorio."));
  rl.close();
  process.exit(1);
}

const contrasena = await preguntarSecreto("Contraseña (no se muestra)");
const baseDatos = await preguntar("Base de datos (opcional)", existente.database || "");
const ssl = await preguntarSi("¿Usar TLS/SSL?", Boolean(existente.ssl));

const credenciales = {
  host,
  port: puerto,
  user: usuario,
  password: contrasena,
  database: baseDatos || undefined,
  ssl,
};

console.log("");
if (await preguntarSi("¿Probar la conexión ahora?", true)) {
  try {
    const conexion = await mysql.createConnection({
      host,
      port: puerto,
      user: usuario,
      password: contrasena,
      database: baseDatos || undefined,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10000,
      multipleStatements: false,
    });
    const [[info]] = await conexion.query(
      "SELECT VERSION() AS version, DATABASE() AS base, CURRENT_USER() AS usuario",
    );
    await conexion.end();
    console.log(ok(`  Conecta correctamente: MySQL ${info.version}, usuario ${info.usuario}, base ${info.base || "(ninguna)"}`));
  } catch (excepcion) {
    console.log(error(`  No conecta: ${excepcion.code || ""} ${excepcion.sqlMessage || excepcion.message}`));
    if (!(await preguntarSi("¿Guardar de todas formas?", false))) {
      rl.close();
      process.exit(1);
    }
  }
}

upsertConnection(nombre, credenciales, { activar: true });
setActiveConnection(nombre);

console.log("");
console.log(ok(`Conexión "${nombre}" guardada y activa.`));
console.log(tenue(`  ${usuario}@${host}:${puerto}/${baseDatos || "(sin base)"}${ssl ? " [TLS]" : ""}`));
console.log(tenue("  Reinicia OpenCode o usa use_connection para aplicarla en la sesión actual."));

rl.close();
