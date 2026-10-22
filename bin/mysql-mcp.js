#!/usr/bin/env node
/**
 * CLI global de mcp-mysql.
 *
 *   mysql-mcp list
 *   mysql-mcp add ventas
 *   mysql-mcp use ventas
 *   mysql-mcp remove vieja
 *
 * Todo se ejecuta en el mismo proceso (sin `spawn`), para que funcione igual
 * instalado con `npm link` o compilado como binario único.
 */
import "../src/compiled-entry.js";
import paquete from "../package.json" with { type: "json" };
import { ejecutarWizard } from "../src/wizard.js";
import { ejecutarDoctor } from "../src/doctor.js";
import { ejecutarFormulario } from "../src/form.js";

const version = paquete.version;

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
const comando = argumentos[0] && !argumentos[0].startsWith("-") ? argumentos[0] : "";
const resto = comando ? argumentos.slice(1) : argumentos;

const primerNombre = () => resto.find((argumento) => !argumento.startsWith("-"));

const faltanArgumentos = (texto) => {
  console.error(mal(texto));
  console.error(tenue("Prueba: mysql-mcp help"));
  process.exit(1);
};

switch (comando) {
  case "":
  case "start":
  case "serve": {
    const { iniciarServidor } = await import("../src/index.js");
    await iniciarServidor();
    break;
  }

  case "list":
  case "ls":
    await ejecutarWizard(["--list"]);
    break;

  case "add":
  case "new":
  case "login": {
    const nombre = primerNombre();
    if (nombre) process.env.MCP_MYSQL_DEFAULT_NAME = nombre;
    if (resto.includes("--tui") || resto.includes("--terminal")) {
      await ejecutarWizard([]);
    } else {
      await ejecutarFormulario();
    }
    break;
  }

  case "status":
  case "current":
    await ejecutarWizard(["--status"]);
    break;

  case "form":
  case "ui":
    await ejecutarFormulario();
    break;

  case "use":
  case "switch": {
    const nombre = primerNombre();
    await ejecutarWizard(nombre ? ["--use", nombre] : ["--select"]);
    break;
  }

  case "remove":
  case "rm":
  case "delete":
  case "logout": {
    if (resto.includes("--all") || resto.includes("-a")) {
      await ejecutarWizard(["--delete", "--all"]);
      break;
    }
    const nombre = primerNombre();
    await ejecutarWizard(nombre ? ["--delete", nombre] : ["--remove-pick"]);
    break;
  }

  case "doctor":
  case "test":
  case "check":
    await ejecutarDoctor(resto);
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
