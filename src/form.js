#!/usr/bin/env node
/**
 * Opens the connection form without going through OpenCode.
 * Useful when the agent is unavailable or after a restart.
 *
 *   npm run form
 */
import { openForm } from "./webform.js";
import { loadStore, storePath } from "./store.js";
import { runCli, isEntryPoint } from "./cli-util.js";
import { t } from "./i18n.js";

export async function runForm() {
const store = loadStore();
const existingNames = Object.keys(store.connections);

let onSaved;
const wait = new Promise((resolve) => {
  onSaved = resolve;
});

console.log(`${t("form.file")}: ${storePath()}`);
if (existingNames.length) console.log(`${t("form.saved")}: ${existingNames.join(", ")}`);
console.log("");

const form = await openForm({
  connections: existingNames,
  prefill: { name: process.env.MCP_MYSQL_DEFAULT_NAME || store.active || "" },
  onDone: (result) => onSaved(result),
});

console.log(`${t("form.url")}: ${form.url}`);
if (!form.browserOpened) console.log(t("form.manual"));
console.log(t("form.waiting"));
console.log("");

const result = await wait;

if (result.ok) {
  const creds = result.credentials;
  console.log(t("form.savedAs", {
    name: result.name,
    user: creds.user,
    host: creds.host,
    port: creds.port,
    base: creds.database || t("common.noDatabase"),
  }));
  process.exit(0);
}

console.log(t("form.closed"));
process.exit(1);
}

if (isEntryPoint(import.meta.url)) {
  runCli(() => runForm());
}
