/**
 * Prueba del almacén multiplataforma: perfiles, activa, borrado y validación.
 *
 *   npm run test:store
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(os.tmpdir(), "mcp-mysql-test", "store.json");
process.env.MCP_MYSQL_STORE = STORE;
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
  validarNombre,
} = await import("../src/store.js");

let fallos = 0;
const check = (nombre, condicion, detalle = "") => {
  console.log(`${condicion ? "OK   " : "FALLO"} ${nombre}${detalle ? " -> " + detalle : ""}`);
  if (!condicion) fallos++;
};

check("empieza vacío", loadStore().connections && Object.keys(loadStore().connections).length === 0);
check("hasStoredConnections falso", !hasStoredConnections());
check("storePath respeta la variable", storePath() === STORE);

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
check("dos conexiones guardadas", Object.keys(store.connections).length === 2, Object.keys(store.connections).join(", "));
check("la última queda activa", store.active === "ventas", store.active);
check("base de datos guardada", store.connections.ventas.database === "ventas");

setActiveConnection("local");
check("se puede cambiar la activa", loadStore().active === "local");

const permisos = fs.statSync(STORE).mode & 0o777;
check(
  "permisos restringidos",
  process.platform === "win32" ? true : (permisos & 0o077) === 0,
  process.platform === "win32" ? "ACL (no comprobable aquí)" : permisos.toString(8),
);

const borrado = removeConnection("local");
check("borrar conexión", borrado.borrada && !loadStore().connections.local);
check("la activa pasa a otra", loadStore().active === "ventas", loadStore().active);

// Compatibilidad con el formato antiguo (credenciales sueltas).
fs.mkdirSync(path.dirname(STORE), { recursive: true });
fs.writeFileSync(
  STORE,
  JSON.stringify({ host: "viejo.local", port: 3306, user: "legacy", password: "x", database: "vieja" }),
);
const migrado = loadStore();
check(
  "migra el formato antiguo a la conexión 'default'",
  migrado.connections.default && migrado.connections.default.user === "legacy" && migrado.active === "default",
);

// Archivo corrupto: mensaje claro.
fs.writeFileSync(STORE, "{ esto no es json");
let mensajeCorrupto = "";
try {
  loadStore();
} catch (error) {
  mensajeCorrupto = error.message;
}
check("detecta archivo corrupto", /corrupto/.test(mensajeCorrupto), mensajeCorrupto.slice(0, 60));

// Validación de nombres.
check("rechaza nombre vacío", validarNombre("") !== null);
check("rechaza caracteres raros", validarNombre("mi;drop") !== null);
check("acepta nombre normal", validarNombre("prod-ventas 2") === null);

deleteStore();
check("borrar todo", !hasStoredConnections());

console.log("");
if (fallos) {
  console.error(`${fallos} prueba(s) fallidas`);
  process.exit(1);
}
console.log("Todas las pruebas pasaron");
