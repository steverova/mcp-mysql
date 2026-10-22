/**
 * Almacén de conexiones MySQL — multiplataforma, sin dependencias nativas.
 *
 *   Windows: %APPDATA%\mcp-mysql\connections.json
 *   macOS/Linux: $XDG_CONFIG_HOME/mcp-mysql/connections.json (o ~/.config/...)
 *
 * Formato:
 *   { version: 3, active: "local", connections: { local: {host,port,user,password,database,ssl} } }
 *
 * El archivo se crea con permisos de solo-usuario (0600 en POSIX, ACL en Windows).
 * Igual que ~/.aws/credentials o ~/.npmrc: es un secreto local protegido por el
 * sistema de archivos, no un cifrado real. Para máxima seguridad, usa variables de
 * entorno o un usuario MySQL con privilegios mínimos.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const FORMATO = 3;

export function storePath() {
  if (process.env.MCP_MYSQL_STORE) return process.env.MCP_MYSQL_STORE;

  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "mcp-mysql", "connections.json");
  }

  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "mcp-mysql", "connections.json");
}

export const hasStoredConnections = () => fs.existsSync(storePath());

const vacio = () => ({ version: FORMATO, active: "", connections: {} });

function normalizar(datos) {
  if (!datos || typeof datos !== "object") return vacio();

  // Compatibilidad: formatos antiguos con "profiles" o con credenciales sueltas.
  const origen = datos.connections || datos.profiles || null;
  if (!origen) {
    if (datos.user || datos.host) {
      return { version: FORMATO, active: "default", connections: { default: datos } };
    }
    return vacio();
  }

  const conexiones = {};
  for (const [nombre, credenciales] of Object.entries(origen)) {
    if (credenciales && typeof credenciales === "object") conexiones[nombre] = credenciales;
  }
  const activa =
    datos.active && conexiones[datos.active] ? datos.active : Object.keys(conexiones)[0] || "";

  return { version: FORMATO, active: activa, connections: conexiones };
}

function restringirPermisos(archivo) {
  try {
    if (process.platform === "win32") {
      const usuario = process.env.USERNAME || os.userInfo().username;
      spawnSync("icacls", [archivo, "/inheritance:r", "/grant:r", `${usuario}:F`], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      fs.chmodSync(archivo, 0o600);
    }
  } catch {
    // Best effort: si falla, el archivo sigue existiendo con los permisos por defecto.
  }
}

export function loadStore() {
  const archivo = storePath();
  if (!fs.existsSync(archivo)) return vacio();

  const contenido = fs.readFileSync(archivo, "utf8").trim();
  if (!contenido) return vacio();

  try {
    return normalizar(JSON.parse(contenido));
  } catch {
    throw new Error(
      `El archivo de conexiones está corrupto (${archivo}). Bórralo con \`npm run logout\` y vuelve a configurar.`,
    );
  }
}

export function saveStore(store) {
  const normalizado = normalizar(store);
  const archivo = storePath();

  fs.mkdirSync(path.dirname(archivo), { recursive: true, mode: 0o700 });
  fs.writeFileSync(archivo, JSON.stringify(normalizado, null, 2), { encoding: "utf8", mode: 0o600 });
  restringirPermisos(archivo);
  return normalizado;
}

export function upsertConnection(nombre, credenciales, { activar = true } = {}) {
  const store = loadStore();
  store.connections[nombre] = credenciales;
  if (activar || !store.active || !store.connections[store.active]) store.active = nombre;
  return saveStore(store);
}

export function removeConnection(nombre) {
  const store = loadStore();
  if (!store.connections[nombre]) return { borrada: false, store };

  delete store.connections[nombre];
  if (store.active === nombre) store.active = Object.keys(store.connections)[0] || "";
  return { borrada: true, store: saveStore(store) };
}

export function setActiveConnection(nombre) {
  const store = loadStore();
  if (!store.connections[nombre]) throw new Error(`No existe la conexión "${nombre}".`);
  store.active = nombre;
  return saveStore(store);
}

export function deleteStore() {
  try {
    fs.unlinkSync(storePath());
    return true;
  } catch {
    return false;
  }
}

export function validarNombre(nombre) {
  const limpio = String(nombre || "").trim();
  if (!limpio) return "El nombre de la conexión es obligatorio.";
  if (limpio.length > 40) return "El nombre no puede pasar de 40 caracteres.";
  if (!/^[\w .-]+$/.test(limpio)) {
    return "El nombre solo admite letras, números, espacio, punto y guion.";
  }
  return null;
}
