#!/usr/bin/env node
/**
 * CLI global de mcp-mysql.
 *
 *   mysql-mcp list
 *   mysql-mcp add ventas
 *   mysql-mcp use ventas
 *   mysql-mcp remove vieja
 *
 * Los subcomandos interactivos se delegan a los módulos de src/ con stdio
 * heredado, para que la TUI y el enmascarado de contraseña funcionen igual
 * en Windows, macOS y Linux.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8")).version;

const color = (codigo, texto) => (process.stdout.isTTY ? `\x1b[${codigo}m${texto}\x1b[0m` : texto);
const titulo = (texto) => color("1;36", texto);
const tenue = (texto) => color("90", texto);
const mal = (texto) => color("31", texto);

const AYUDA = `
${titulo("mysql-mcp")} ${tenue("v" + version)} — conexiones MySQL para OpenCode

${titulo("Uso")}
  mysql-mcp                     arranca el servidor MCP (stdio, lo usa OpenCode)
  mysql-mcp status              muestra la BD seleccionada ahora mismo
  mysql-mcp list                lista todas las conexiones
  mysql-mcp add [nombre]        crea o edita una conexión (abre el navegador)
  mysql-mcp add --tui           igual, pero con el asistente de terminal
  mysql-mcp form                abre el formulario sin más
  mysql-mcp use [nombre]        activa una conexión (sin nombre: selector)
  mysql-mcp remove [nombre]     elimina una (sin nombre: selector)
  mysql-mcp remove --all        elimina todas
  mysql-mcp doctor [--all]      prueba las conexiones
  mysql-mcp path                dónde se guardan las conexiones
  mysql-mcp help                esta ayuda

${titulo("Ejemplos")}
  mysql-mcp add ventas
  mysql-mcp status
  mysql-mcp use ventas
  mysql-mcp doctor --all
  mysql-mcp remove produccion

${titulo("Atajos")}  ls = list · rm = remove · test = doctor · current = status
`;

const argumentos = process.argv.slice(2);
let comando = argumentos[0] && !argumentos[0].startsWith("-") ? argumentos[0] : "";
const resto = comando ? argumentos.slice(1) : argumentos;

const ejecutar = (modulo, extras = [], entorno = {}) => {
  const resultado = spawnSync(process.execPath, [path.join(RAIZ, "src", modulo), ...extras], {
    stdio: "inherit",
    env: { ...process.env, ...entorno },
  });
  if (resultado.error) {
    console.error(mal(`No se pudo ejecutar ${modulo}: ${resultado.error.message}`));
    process.exit(1);
  }
  process.exit(resultado.status ?? 1);
};

const faltanArgumentos = (texto) => {
  console.error(mal(texto));
  console.error(tenue("Prueba: mysql-mcp help"));
  process.exit(1);
};

switch (comando) {
  case "":
  case "start":
  case "serve":
    ejecutar("index.js");
    break;

  case "list":
  case "ls":
    ejecutar("wizard.js", ["--list"]);
    break;

  case "add":
  case "new":
  case "login": {
    const nombre = resto.find((argumento) => !argumento.startsWith("-"));
    const entorno = nombre ? { MCP_MYSQL_DEFAULT_NAME: nombre } : {};
    if (resto.includes("--tui") || resto.includes("--terminal")) {
      ejecutar("wizard.js", [], entorno);
    }
    ejecutar("form.js", [], entorno);
    break;
  }

  case "status":
  case "current":
    ejecutar("wizard.js", ["--status"]);
    break;

  case "form":
  case "ui":
    ejecutar("form.js");
    break;

  case "use":
  case "switch": {
    const nombre = resto.find((argumento) => !argumento.startsWith("-"));
    ejecutar("wizard.js", nombre ? ["--use", nombre] : ["--select"]);
    break;
  }

  case "remove":
  case "rm":
  case "delete":
  case "logout": {
    if (resto.includes("--all") || resto.includes("-a")) {
      ejecutar("wizard.js", ["--delete", "--all"]);
      break;
    }
    const nombre = resto.find((argumento) => !argumento.startsWith("-"));
    ejecutar("wizard.js", nombre ? ["--delete", nombre] : ["--remove-pick"]);
    break;
  }

  case "doctor":
  case "test":
  case "check":
    ejecutar("doctor.js", resto);
    break;

  case "path": {
    const { storePath, hasStoredConnections } = await import("../src/store.js");
    console.log(storePath());
    if (!hasStoredConnections()) console.log(tenue("(todavía no existe: crea una con `mysql-mcp add`)"));
    break;
  }

  case "version":
  case "--version":
  case "-v":
    console.log(version);
    break;

  case "help":
  case "--help":
  case "-h":
    console.log(AYUDA);
    break;

  default:
    console.error(mal(`Comando desconocido: ${comando}`));
    console.log(AYUDA);
    process.exit(1);
}
