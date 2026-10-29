/**
 * Registers the server in OpenCode without editing JSON by hand.
 *
 * Writes (or replaces) the `mcp.mysql` entry and the write permissions,
 * keeping the rest of the configuration and leaving a backup file.
 *
 *   mysql-mcp opencode            global config
 *   mysql-mcp opencode --project  ./opencode.json of the current project
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, isEntryPoint } from "./cli-util.js";
import { t } from "./i18n.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const ok = (text) => color("32", text);
const dim = (text) => color("90", text);
const mal = (text) => color("31", text);
const warning = (text) => color("33", text);

// Path of the global opencode.json.
export function globalConfigPath() {
  if (process.env.MCP_MYSQL_OPENCODE_CONFIG) return process.env.MCP_MYSQL_OPENCODE_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "opencode.json");
}

/**
 * The command OpenCode should use to launch the server:
 * as a compiled binary, the executable itself with "start";
 * on Node, node + src/index.js.
 */
export function serverCommand() {
  const executableName = path.basename(process.execPath).toLowerCase();
  const isRuntime = ["node", "node.exe", "bun", "bun.exe"].includes(executableName);
  const toSlashes = (filePath) => filePath.replace(/\\/g, "/");
  if (!isRuntime) return [toSlashes(process.execPath), "start"];
  return ["node", toSlashes(path.join(RAIZ, "src", "index.js"))];
}

function readConfig(file) {
  if (!fs.existsSync(file)) return { config: {}, existed: false };

  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  if (!text) return { config: {}, existed: true };

  try {
    return { config: JSON.parse(text), existed: true };
  } catch {
    throw new Error(t("opencode.invalidJson", { file }));
  }
}

/**
 * Applies the registration to a config object. Idempotent.
 * Returns what changed.
 */
export function applyRegistration(config, command) {
  const changes = [];

  config.mcp = config.mcp && typeof config.mcp === "object" ? config.mcp : {};
  const input = {
    type: "local",
    command: command,
    enabled: true,
    timeout: 15000,
  };

  const previous = JSON.stringify(config.mcp.mysql);
  if (previous !== JSON.stringify(input)) {
    config.mcp.mysql = input;
    changes.push(previous === undefined ? t("opencode.added") : t("opencode.updated"));
  }

  config.permission = config.permission && typeof config.permission === "object" ? config.permission : {};
  for (const key of ["mysql_confirm_write", "mysql_reset_credentials"]) {
    if (config.permission[key] !== "ask") {
      config.permission[key] = "ask";
      changes.push(t("opencode.permission", { key }));
    }
  }

  return changes;
}

export async function runOpenCode(args = process.argv.slice(2)) {
  const project = args.includes("--project") || args.includes("--local");
  const dryRun = args.includes("--dry-run");
  const file = project ? path.join(process.cwd(), "opencode.json") : globalConfigPath();

  const { config, existed } = readConfig(file);
  const changes = applyRegistration(config, serverCommand());

  console.log(dim(`${t("opencode.config")}: ${file}${existed ? "" : t("opencode.new")}`));
  console.log(dim(`${t("opencode.command")}: ${JSON.stringify(config.mcp.mysql.command)}`));

  if (!changes.length) {
    console.log(ok("\n" + t("opencode.already")));
    console.log(dim(t("opencode.restart")));
    return;
  }

  if (dryRun) {
    console.log(warning("\n" + t("opencode.changes")));
    for (const cambio of changes) console.log(`  · ${cambio}`);
    return;
  }

  if (existed) {
    const backupPath = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(file, backupPath);
    console.log(dim(`${t("opencode.backup")}: ${backupPath}`));
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  console.log(ok("\n" + t("opencode.registered")));
  for (const cambio of changes) console.log(`  · ${cambio}`);
  console.log(dim("\n" + t("opencode.finalRestart")));
}

if (isEntryPoint(import.meta.url)) {
  runCli(() => runOpenCode());
}
