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

let failures = 0;
const check = (name, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${name}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) failures++;
};

const run = () =>
  spawnSync(process.execPath, [BIN, "opencode"], {
    encoding: "utf8",
    env: { ...process.env, MCP_MYSQL_LANG: "es", MCP_MYSQL_OPENCODE_CONFIG: CONFIG },
  });

// Configuración previa con others cosas que NO se deben perder.
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

const firstRun = run();
check("la firstRun ejecución termina bien", firstRun.status === 0, (firstRun.stderr || "").slice(0, 60));

const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
check("añade mcp.mysql", config.mcp?.mysql?.type === "local");
check("comando correcto", JSON.stringify(config.mcp.mysql.command) === JSON.stringify(["node", path.join(RAIZ, "src", "index.js").replace(/\\/g, "/")]), JSON.stringify(config.mcp.mysql.command));
check("active el serverInfo", config.mcp.mysql.enabled === true);
check("conserva aws-mcp", Boolean(config.mcp["aws-mcp"]));
check("conserva plugins", Array.isArray(config.plugins) && config.plugins.length === 1);
check("conserva permisos previos", config.permission.shell?.["git *"] === "allow");
check("añade permiso confirm_write", config.permission.mysql_confirm_write === "ask");
check("añade permiso reset_credentials", config.permission.mysql_reset_credentials === "ask");

const backupFiles = fs.readdirSync(path.dirname(CONFIG)).filter((f) => f.startsWith("opencode.json.bak-"));
check("deja backupPath de seguridad", backupFiles.length >= 1, backupFiles[0] || "");

const secondRun = run();
check("la secondRun ejecución es idempotente", secondRun.status === 0 && secondRun.stdout.includes("Ya estaba registrado"), secondRun.stdout.trim().split("\n").pop());
check("no duplica la backupPath", fs.readdirSync(path.dirname(CONFIG)).filter((f) => f.startsWith("opencode.json.bak-")).length === backupFiles.length);

// ---dry-run no debe escribir.
fs.rmSync(CONFIG, { force: true });
const dry = spawnSync(process.execPath, [BIN, "opencode", "--dry-run"], {
  encoding: "utf8",
  env: { ...process.env, MCP_MYSQL_LANG: "es", MCP_MYSQL_OPENCODE_CONFIG: CONFIG },
});
check("--dry-run informa changes", dry.status === 0 && dry.stdout.includes("Cambios que aplicaría"));
check("--dry-run no crea el file", !fs.existsSync(CONFIG));

fs.rmSync(CONFIG, { force: true });

console.log("");
if (failures) {
  console.error(`${failures} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
