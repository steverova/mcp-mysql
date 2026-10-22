#!/usr/bin/env node
/**
 * Global mcp-mysql CLI.
 *
 *   mysql-mcp list
 *   mysql-mcp add sales
 *   mysql-mcp use sales
 *   mysql-mcp remove old
 *
 * Everything runs in the same process (no `spawn`), so it works the same when
 * installed with `npm link` or compiled as a single binary.
 */
import "../src/compiled-entry.js";
import paquete from "../package.json" with { type: "json" };
import { runWizard } from "../src/wizard.js";
import { runDoctor } from "../src/doctor.js";
import { runForm } from "../src/form.js";
import { runOpenCode } from "../src/opencode.js";
import { t } from "../src/i18n.js";

const version = paquete.version;

const color = (codigo, texto) => (process.stdout.isTTY ? `\x1b[${codigo}m${texto}\x1b[0m` : texto);
const title = (texto) => color("1;36", texto);
const dim = (texto) => color("90", texto);
const mal = (texto) => color("31", texto);

const HELP = `
${title("mysql-mcp")} ${dim("v" + version)} — ${t("bin.tagline")}

${title(t("bin.usage"))}
${t("bin.help")}

${title(t("bin.examplesTitle"))}
${t("bin.examples")}

${title(t("bin.aliasesTitle"))}  ls = list · rm = remove · test = doctor · current = status
`;

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : "";
const remaining = command ? args.slice(1) : args;

const firstPositional = () => remaining.find((argumento) => !argumento.startsWith("-"));

switch (command) {
  case "":
  case "start":
  case "serve": {
    const { startServer } = await import("../src/index.js");
    await startServer();
    break;
  }

  case "list":
  case "ls":
    await runWizard(["--list"]);
    break;

  case "add":
  case "new":
  case "login": {
    const name = firstPositional();
    if (name) process.env.MCP_MYSQL_DEFAULT_NAME = name;
    if (remaining.includes("--tui") || remaining.includes("--terminal")) {
      await runWizard([]);
    } else {
      await runForm();
    }
    break;
  }

  case "status":
  case "current":
    await runWizard(["--status"]);
    break;

  case "form":
  case "ui":
    await runForm();
    break;

  case "use":
  case "switch": {
    const name = firstPositional();
    await runWizard(name ? ["--use", name] : ["--select"]);
    break;
  }

  case "remove":
  case "rm":
  case "delete":
  case "logout": {
    if (remaining.includes("--all") || remaining.includes("-a")) {
      await runWizard(["--delete", "--all"]);
      break;
    }
    const name = firstPositional();
    await runWizard(name ? ["--delete", name] : ["--remove-pick"]);
    break;
  }

  case "doctor":
  case "test":
  case "check":
    await runDoctor(remaining);
    break;

  case "opencode":
  case "install":
  case "register":
    await runOpenCode(remaining);
    break;

  case "path": {
    const { storePath, hasStoredConnections } = await import("../src/store.js");
    console.log(storePath());
    if (!hasStoredConnections()) console.log(dim(t("bin.pathMissing")));
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
    console.log(HELP);
    break;

  default:
    console.error(mal(t("bin.unknown", { command })));
    console.log(HELP);
    process.exit(1);
}
