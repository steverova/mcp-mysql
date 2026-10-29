#!/usr/bin/env node
/**
 * Terminal wizard (TUI) to manage MySQL connections.
 * Cross-platform: Windows, macOS and Linux. Only needs a terminal.
 *
 *   npm run login                 create or edit a connection
 *   npm run login -- --list       list connections
 *   npm run login -- --use name   activate a connection
 *   npm run logout                delete all
 *   npm run logout -- name        delete one
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
  validateName,
} from "./store.js";
import { runCli, isEntryPoint } from "./cli-util.js";
import { t } from "./i18n.js";

export async function runWizard(args = process.argv.slice(2)) {
const color = (code, text) =>
  process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
const title = (text) => color("1;36", text);
const ok = (text) => color("32", text);
const warning = (text) => color("33", text);
const error = (text) => color("31", text);
const dim = (text) => color("90", text);

const hasFlag = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const store = loadStore();
const names = Object.keys(store.connections);
const available = () => names.join(", ") || t("common.none");
const noDatabase = () => t("common.noDatabase");

/** ------------------------------------------------------------------ */
// Non-interactive commands
/** ------------------------------------------------------------------ */

if (hasFlag("--status")) {
  if (!names.length) {
    console.log(dim(t("wizard.list.empty", { file: storePath() })) + "  " + t("wizard.createWith") + " " + title("mysql-mcp add"));
    process.exit(0);
  }
  const active = store.connections[store.active] || store.connections[names[0]];
  const base = active.database || dim(t("wizard.status.noDefaultDb"));
  console.log(title(t("wizard.status.title")));
  console.log(`  ${t("wizard.status.connection")} : ${store.active || names[0]}`);
  console.log(`  ${t("wizard.status.server")}     : ${active.user}@${active.host}:${active.port}`);
  console.log(`  ${t("wizard.status.database")}   : ${base}`);
  console.log(`  TLS          : ${active.ssl ? t("common.yes") : t("common.no")}`);
  console.log(dim(`  ${t("wizard.status.file")}      : ${storePath()}`));
  const others = names.filter((n) => n !== store.active);
  if (others.length) console.log(dim(`  ${t("wizard.status.others")}     : ${others.join(", ")}  → mysql-mcp use <name>`));
  process.exit(0);
}

if (hasFlag("--list")) {
  if (!names.length) {
    console.log(dim(t("wizard.list.empty", { file: storePath() })));
    process.exit(0);
  }
  console.log(title(t("wizard.list.title")), dim(storePath()));
  for (const name of names) {
    const c = store.connections[name];
    const marker = name === store.active ? ok("* ") : "  ";
    console.log(`${marker}${name.padEnd(18)} ${c.user}@${c.host}:${c.port}/${c.database || noDatabase()}${c.ssl ? " [TLS]" : ""}`);
  }
  process.exit(0);
}

if (hasFlag("--use")) {
  const name = valueOf("--use");
  if (!name || !store.connections[name]) {
    console.error(error(t("wizard.use.notFound", { name: name || "", available: available() })));
    process.exit(1);
  }
  setActiveConnection(name);
  console.log(ok(t("wizard.use.active", { name })));
  process.exit(0);
}

if (hasFlag("--delete") || args[0] === "delete") {
  const name = valueOf("--delete") || args.find((a) => !a.startsWith("-") && a !== "delete");

  if (hasFlag("--all") || hasFlag("-a")) {
    const borrado = deleteStore();
    console.log(borrado ? ok(t("wizard.delete.allDone")) : dim(t("wizard.delete.noneSaved")));
    process.exit(0);
  }

  if (!name) {
    console.error(error(t("wizard.delete.which")));
    console.error(dim("  mysql-mcp remove ventas"));
    console.error(dim("  mysql-mcp remove --all"));
    process.exit(1);
  }

  const result = removeConnection(name);
  console.log(result.deleted ? ok(t("wizard.delete.done", { name })) : warning(t("wizard.delete.missing", { name })));
  process.exit(result.deleted ? 0 : 1);
}

/** ------------------------------------------------------------------ */
// Interactive wizard
/** ------------------------------------------------------------------ */

if (!process.stdin.isTTY) {
  console.error(error(t("wizard.noTty")) + "\n" + t("wizard.noTtyHint"));
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(text, defaultValue = "") {
  const suffix = defaultValue !== "" ? dim(` [${defaultValue}]`) : "";
  const answer = (await rl.question(`${text}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askSecret(text) {
  rl.pause();
  process.stdout.write(`${text}: `);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";

    const cleanup = () => {
      stdin.removeListener("data", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      rl.resume();
    };

    const onKey = (buffer) => {
      for (const caracter of buffer.toString("utf8")) {
        if (caracter === "\r" || caracter === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (caracter === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (caracter === "\u007f" || caracter === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (caracter >= " ") {
          value += caracter;
          process.stdout.write("*");
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
  });
}

async function askYesNo(text, defaultValue = true) {
  const yes = t("common.yes").charAt(0);
  const no = t("common.no").charAt(0);
  const answer = (await ask(text, defaultValue ? yes : no)).toLowerCase();
  return answer.startsWith(si) || answer.startsWith("y") || answer.startsWith("s");
}

async function elegir(message, action) {
  if (!names.length) {
    console.log(dim(t("wizard.list.empty", { file: storePath() })) + "  " + t("wizard.createWith") + " " + title("mysql-mcp add"));
    rl.close();
    process.exit(0);
  }

  console.log("");
  console.log(title(t("wizard.pick.title")));
  names.forEach((name, index) => {
    const c = store.connections[name];
    const marker = name === store.active ? ok("*") : " ";
    console.log(
      `  ${marker} ${String(index + 1).padStart(2)}. ${name.padEnd(18)} ${dim(
        `${c.user}@${c.host}:${c.port}/${c.database || noDatabase()}`,
      )}`,
    );
  });
  console.log("");

  const input = (await ask(message)).trim();
  if (!input) {
    rl.close();
    process.exit(0);
  }

  const number = Number(input);
  const chosen =
    Number.isInteger(number) && number >= 1 && number <= names.length ? names[number - 1] : input;

  if (!store.connections[chosen]) {
    console.error(error(t("wizard.use.notFound", { name: chosen, available: available() })));
    rl.close();
    process.exit(1);
  }

  await action(chosen);
  rl.close();
  process.exit(0);
}

if (hasFlag("--select")) {
  await elegir(t("wizard.pick.activate"), async (name) => {
    setActiveConnection(name);
    const c = loadStore().connections[name];
    console.log("");
    console.log(ok(t("wizard.status.title") + " " + name));
    console.log(`  ${c.user}@${c.host}:${c.port}/${c.database || noDatabase()}`);
    console.log(dim(t("wizard.pick.confirmHint")));
  });
}

if (hasFlag("--remove-pick")) {
  await elegir(t("wizard.pick.delete"), async (name) => {
    removeConnection(name);
    console.log("");
    console.log(ok(t("wizard.delete.done", { name })));
    const remaining = Object.keys(loadStore().connections);
    console.log(dim(remaining.length ? t("wizard.pick.remaining", { available: remaining.join(", ") }) : t("wizard.pick.noLeft")));
  });
}

console.log("");
console.log(title("  " + t("wizard.banner.title")) + dim("  ·  " + t("wizard.banner.sub")));
console.log(dim(`  ${t("wizard.banner.file")}: ${storePath()}`));
console.log("");

if (names.length) {
  console.log(t("wizard.savedTitle"));
  for (const name of names) {
    const c = store.connections[name];
    console.log(`  ${name === store.active ? ok("*") : " "} ${name.padEnd(18)} ${dim(`${c.user}@${c.host}:${c.port}/${c.database || noDatabase()}`)}`);
  }
  console.log("");
}

const current = store.active && store.connections[store.active] ? store.connections[store.active] : null;

const name = await ask(
  t("wizard.field.name"),
  process.env.MCP_MYSQL_DEFAULT_NAME || store.active || names[0] || "local",
);
const problem = validateName(name);
if (problem) {
  console.error(error(problem));
  rl.close();
  process.exit(1);
}

const existing = store.connections[name] || current || {};
const host = await ask(t("wizard.field.host"), existing.host || "127.0.0.1");
const portText = await ask(t("wizard.field.port"), String(existing.port || 3306));
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(error(t("wizard.invalidPort")));
  rl.close();
  process.exit(1);
}

const user = await ask(t("wizard.field.user"), existing.user || "");
if (!user) {
  console.error(error(t("wizard.userRequired")));
  rl.close();
  process.exit(1);
}

const password = await askSecret(t("wizard.field.password"));
const database = await ask(t("wizard.field.database"), existing.database || "");
const ssl = await askYesNo(t("wizard.field.ssl"), Boolean(existing.ssl));

const creds = {
  host,
  port: port,
  user: user,
  password: password,
  database: database || undefined,
  ssl,
};

console.log("");
if (await askYesNo(t("wizard.testNow"), true)) {
  try {
    const connection = await mysql.createConnection({
      host,
      port: port,
      user: user,
      password: password,
      database: database || undefined,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10000,
      multipleStatements: false,
    });
    const [[info]] = await connection.query(
      "SELECT VERSION() AS version, DATABASE() AS base, CURRENT_USER() AS user",
    );
    await connection.end();
    console.log(ok("  " + t("wizard.connected", {
      version: info.version,
      user: info.user,
      base: info.base || t("common.none"),
    })));
  } catch (caught) {
    console.log(error("  " + t("wizard.cannotConnect", { error: `${caught.code || ""} ${caught.sqlMessage || caught.message}` })));
    if (!(await askYesNo(t("wizard.saveAnyway"), false))) {
      rl.close();
      process.exit(1);
    }
  }
}

upsertConnection(name, creds, { activate: true });
setActiveConnection(name);

console.log("");
console.log(ok(t("wizard.saved", { name })));
console.log(dim(`  ${user}@${host}:${port}/${database || noDatabase()}${ssl ? " [TLS]" : ""}`));
console.log(dim("  " + t("wizard.applyHint")));

rl.close();
}

if (isEntryPoint(import.meta.url)) {
  runCli(() => runWizard());
}
