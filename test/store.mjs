/**
 * Cross-platform store test: connections, active, deletion and validation.
 *
 *   npm run test:store
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(os.tmpdir(), "mcp-mysql-test", "store.json");
process.env.MCP_MYSQL_STORE = STORE;
process.env.MCP_MYSQL_LANG = "en";
fs.rmSync(STORE, { force: true });

const {
  deleteStore,
  hasStoredConnections,
  loadStore,
  removeConnection,
  saveStore,
  setActiveConnection,
  storePath,
  upsertConnection,
  validateName,
} = await import("../src/store.js");

let failures = 0;
const check = (name, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FAIL"} ${name}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) failures++;
};

check("starts empty", loadStore().connections && Object.keys(loadStore().connections).length === 0);
check("hasStoredConnections is false", !hasStoredConnections());
check("storePath honors the variable", storePath() === STORE);

upsertConnection("local", {
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "uno",
  database: undefined,
  ssl: false,
});

upsertConnection("ventas", {
  host: "db.interna",
  port: 3307,
  user: "mcp",
  password: "dos",
  database: "ventas",
  ssl: true,
});

const store = loadStore();
check("two connections saved", Object.keys(store.connections).length === 2, Object.keys(store.connections).join(", "));
check("the last one becomes active", store.active === "ventas", store.active);
check("database saved", store.connections.ventas.database === "ventas");

setActiveConnection("local");
check("the active one can be changed", loadStore().active === "local");

const permisos = fs.statSync(STORE).mode & 0o777;
check(
  "permisos restringidos",
  process.platform === "win32" ? true : (permisos & 0o077) === 0,
  process.platform === "win32" ? "ACL (not checkable here)" : permisos.toString(8),
);

const borrado = removeConnection("local");
check("deletes a connection", borrado.deleted && !loadStore().connections.local);
check("the active one moves to another", loadStore().active === "ventas", loadStore().active);

// Compatibility with the old format (loose credentials).
fs.mkdirSync(path.dirname(STORE), { recursive: true });
fs.writeFileSync(
  STORE,
  JSON.stringify({ host: "viejo.local", port: 3306, user: "legacy", password: "x", database: "vieja" }),
);
const migrado = loadStore();
check(
  "migrates the old format to the 'default' connection",
  migrado.connections.default && migrado.connections.default.user === "legacy" && migrado.active === "default",
);

// Archivo corrupto: message claro.
fs.writeFileSync(STORE, "{ esto no es json");
let corruptMessage = "";
try {
  loadStore();
} catch (error) {
  corruptMessage = error.message;
}
check("detects a corrupt file", /corrupt/.test(corruptMessage), corruptMessage.slice(0, 60));

// Name validation.
check("rejects an empty name", validateName("") !== null);
check("rejects odd characters", validateName("mi;drop") !== null);
check("accepts a normal name", validateName("prod-ventas 2") === null);

deleteStore();
check("deletes everything", !hasStoredConnections());

console.log("");
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("All tests passed");
