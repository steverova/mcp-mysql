/**
 * Registro automático en OpenCode: añade mcp.mysql y permisos sin romper
 * el resto de la configuración, y es idempotente.
 *
 *   npm run test:opencode
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(RAIZ, "bin", "mysql-mcp.js");
const CONFIG = path.join(os.tmpdir(), "mcp-mysql-test", "opencode.json");

let fallos = 0;
const check = (nombre, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${nombre}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) fallos++;
};

const ejecutar = () =>
  spawnSync(process.execPath, [BIN, "opencode"], {
    encoding: "utf8",
    env: { ...process.env, MCP_MYSQL_OPENCODE_CONFIG: CONFIG },
  });

// Configuración previa con otras cosas que NO se deben perder.
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
fs.writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      plugins: ["https://github.com/steverova/kiro-provider.git"],
      mcp: {
        "aws-mcp": { type: "local", command: ["uvx", "mcp-proxy-for-aws@latest"] },
      },
      permission: { shell: { "*": "ask", "git *": "allow" } },
    },
    null,
    2,
  ),
);

const primera = ejecutar();
check("la primera ejecución termina bien", primera.status === 0, (primera.stderr || "").slice(0, 60));

const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
check("añade mcp.mysql", config.mcp?.mysql?.type === "local");
check("comando correcto", JSON.stringify(config.mcp.mysql.command) === JSON.stringify(["node", path.join(RAIZ, "src", "index.js").replace(/\\/g, "/")]), JSON.stringify(config.mcp.mysql.command));
check("activa el servidor", config.mcp.mysql.enabled === true);
check("conserva aws-mcp", Boolean(config.mcp["aws-mcp"]));
check("conserva plugins", Array.isArray(config.plugins) && config.plugins.length === 1);
check("conserva permisos previos", config.permission.shell?.["git *"] === "allow");
check("añade permiso confirm_write", config.permission.mysql_confirm_write === "ask");
check("añade permiso reset_credentials", config.permission.mysql_reset_credentials === "ask");

const copias = fs.readdirSync(path.dirname(CONFIG)).filter((f) => f.startsWith("opencode.json.bak-"));
check("deja copia de seguridad", copias.length >= 1, copias[0] || "");

const segunda = ejecutar();
check("la segunda ejecución es idempotente", segunda.status === 0 && segunda.stdout.includes("Ya estaba registrado"), segunda.stdout.trim().split("\n").pop());
check("no duplica la copia", fs.readdirSync(path.dirname(CONFIG)).filter((f) => f.startsWith("opencode.json.bak-")).length === copias.length);

// ---dry-run no debe escribir.
fs.rmSync(CONFIG, { force: true });
const dry = spawnSync(process.execPath, [BIN, "opencode", "--dry-run"], {
  encoding: "utf8",
  env: { ...process.env, MCP_MYSQL_OPENCODE_CONFIG: CONFIG },
});
check("--dry-run informa cambios", dry.status === 0 && dry.stdout.includes("Cambios que aplicaría"));
check("--dry-run no crea el archivo", !fs.existsSync(CONFIG));

fs.rmSync(CONFIG, { force: true });

console.log("");
if (fallos) {
  console.error(`${fallos} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
