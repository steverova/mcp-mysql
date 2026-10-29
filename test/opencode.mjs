/**
 * Automatic OpenCode registration: adds mcp.mysql and permissions without breaking
 * the rest of the configuration; it is idempotent.
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
  console.log(`${condicion ? "OK   " : "FAIL"} ${name}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) failures++;
};

const run = () =>
  spawnSync(process.execPath, [BIN, "opencode"], {
    encoding: "utf8",
    env: { ...process.env, MCP_MYSQL_LANG: "en", MCP_MYSQL_OPENCODE_CONFIG: CONFIG },
  });

// Previous config with other things that must NOT be lost.
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
check("first run succeeds", firstRun.status === 0, (firstRun.stderr || "").slice(0, 60));

const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
check("adds mcp.mysql", config.mcp?.mysql?.type === "local");
check("command is correct", JSON.stringify(config.mcp.mysql.command) === JSON.stringify(["node", path.join(RAIZ, "src", "index.js").replace(/\\/g, "/")]), JSON.stringify(config.mcp.mysql.command));
check("registers the server in OpenCode", config.mcp.mysql.enabled === true);
check("keeps aws-mcp", Boolean(config.mcp["aws-mcp"]));
check("keeps plugins", Array.isArray(config.plugins) && config.plugins.length === 1);
check("keeps previous permissions", config.permission.shell?.["git *"] === "allow");
check("adds confirm_write permission", config.permission.mysql_confirm_write === "ask");
check("adds reset_credentials permission", config.permission.mysql_reset_credentials === "ask");

const backupFiles = fs.readdirSync(path.dirname(CONFIG)).filter((f) => f.startsWith("opencode.json.bak-"));
check("leaves a backup file", backupFiles.length >= 1, backupFiles[0] || "");

const secondRun = run();
check("second run is idempotent", secondRun.status === 0 && secondRun.stdout.includes("Already registered"), secondRun.stdout.trim().split("\n").pop());
check("does not duplicate the backup", fs.readdirSync(path.dirname(CONFIG)).filter((f) => f.startsWith("opencode.json.bak-")).length === backupFiles.length);

// --dry-run must not write.
fs.rmSync(CONFIG, { force: true });
const dry = spawnSync(process.execPath, [BIN, "opencode", "--dry-run"], {
  encoding: "utf8",
  env: { ...process.env, MCP_MYSQL_LANG: "en", MCP_MYSQL_OPENCODE_CONFIG: CONFIG },
});
check("--dry-run reports changes", dry.status === 0 && dry.stdout.includes("Changes it would apply"));
check("--dry-run does not create the file", !fs.existsSync(CONFIG));

fs.rmSync(CONFIG, { force: true });

console.log("");
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("All tests passed");
