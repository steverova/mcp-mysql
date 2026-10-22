/**
 * Registro del servidor en OpenCode, sin editar JSON a mano.
 *
 * Escribe (o reemplaza) la entrada `mcp.mysql` y los permisos de escritura,
 * conservando el resto de la configuración y dejando una copia de seguridad.
 *
 *   mysql-mcp opencode            config global
 *   mysql-mcp opencode --project  ./opencode.json del proyecto
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrancar, esEntrada } from "./cli-util.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const color = (codigo, texto) => (process.stdout.isTTY ? `\x1b[${codigo}m${texto}\x1b[0m` : texto);
const ok = (texto) => color("32", texto);
const tenue = (texto) => color("90", texto);
const mal = (texto) => color("31", texto);
const aviso = (texto) => color("33", texto);

/** Ruta del opencode.json global. */
export function rutaGlobal() {
  if (process.env.MCP_MYSQL_OPENCODE_CONFIG) return process.env.MCP_MYSQL_OPENCODE_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "opencode.json");
}

/**
 * Comando con el que OpenCode debe lanzar el servidor:
 * si somos un binario compilado, el propio ejecutable con "start";
 * si corremos sobre Node, node + src/index.js.
 */
export function comandoServidor() {
  const ejecutable = path.basename(process.execPath).toLowerCase();
  const esRuntime = ["node", "node.exe", "bun", "bun.exe"].includes(ejecutable);
  const aBarras = (ruta) => ruta.replace(/\\/g, "/");
  if (!esRuntime) return [aBarras(process.execPath), "start"];
  return ["node", aBarras(path.join(RAIZ, "src", "index.js"))];
}

function leerConfig(archivo) {
  if (!fs.existsSync(archivo)) return { config: {}, existia: false };

  const texto = fs.readFileSync(archivo, "utf8").replace(/^\uFEFF/, "").trim();
  if (!texto) return { config: {}, existia: true };

  try {
    return { config: JSON.parse(texto), existia: true };
  } catch {
    throw new Error(
      `${archivo} tiene comentarios o no es JSON válido. Ábrelo y añade la entrada a mano, o usa --project con un archivo limpio.`,
    );
  }
}

/**
 * Aplica el registro sobre un objeto de configuración. Idempotente.
 * Devuelve qué cambió.
 */
export function aplicar(config, comando) {
  const cambios = [];

  config.mcp = config.mcp && typeof config.mcp === "object" ? config.mcp : {};
  const entrada = {
    type: "local",
    command: comando,
    enabled: true,
    timeout: 15000,
  };

  const anterior = JSON.stringify(config.mcp.mysql);
  if (anterior !== JSON.stringify(entrada)) {
    config.mcp.mysql = entrada;
    cambios.push(anterior === undefined ? "añadida la entrada mcp.mysql" : "actualizada la entrada mcp.mysql");
  }

  config.permission = config.permission && typeof config.permission === "object" ? config.permission : {};
  for (const clave of ["mysql_confirm_write", "mysql_reset_credentials"]) {
    if (config.permission[clave] !== "ask") {
      config.permission[clave] = "ask";
      cambios.push(`permiso ${clave} = ask`);
    }
  }

  return cambios;
}

export async function ejecutarOpenCode(argumentos = process.argv.slice(2)) {
  const proyecto = argumentos.includes("--project") || argumentos.includes("--local");
  const soloVer = argumentos.includes("--dry-run");
  const archivo = proyecto ? path.join(process.cwd(), "opencode.json") : rutaGlobal();

  const { config, existia } = leerConfig(archivo);
  const cambios = aplicar(config, comandoServidor());

  console.log(tenue(`Configuración: ${archivo}${existia ? "" : " (nueva)"}`));
  console.log(tenue(`Comando:       ${JSON.stringify(config.mcp.mysql.command)}`));

  if (!cambios.length) {
    console.log(ok("\nYa estaba registrado, sin cambios."));
    console.log(tenue("Reinicia OpenCode para que lo cargue."));
    return;
  }

  if (soloVer) {
    console.log(aviso("\nCambios que aplicaría (--dry-run):"));
    for (const cambio of cambios) console.log(`  · ${cambio}`);
    return;
  }

  if (existia) {
    const copia = `${archivo}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(archivo, copia);
    console.log(tenue(`Copia de seguridad: ${copia}`));
  }

  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  console.log(ok("\nRegistrado:"));
  for (const cambio of cambios) console.log(`  · ${cambio}`);
  console.log(tenue("\nReinicia OpenCode para que cargue el servidor."));
}

if (esEntrada(import.meta.url)) {
  arrancar(() => ejecutarOpenCode());
}
