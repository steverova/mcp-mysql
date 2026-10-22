/**
 * MySQL connection store - cross-platform, no native dependencies.
 *
 *   Windows: %APPDATA%\mcp-mysql\connections.json
 *   macOS/Linux: $XDG_CONFIG_HOME/mcp-mysql/connections.json (or ~/.config/...)
 *
 * Format:
 *   { version: 3, active: "local", connections: { local: {host,port,user,password,database,ssl} } }
 *
 * The file is created with user-only permissions (0600 on POSIX, ACL on Windows).
 * Like ~/.aws/credentials or ~/.npmrc: a local secret protected by the file
 * system, not real encryption. For maximum safety use environment variables or a
 * MySQL user with minimal privileges.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { t } from "./i18n.js";

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

function normalizar(data) {
  if (!data || typeof data !== "object") return vacio();

  // Compatibility: old formats with "profiles" or with loose credentials.
  const origin = data.connections || data.profiles || null;
  if (!origin) {
    if (data.user || data.host) {
      return { version: FORMATO, active: "default", connections: { default: data } };
    }
    return vacio();
  }

  const connections = {};
  for (const [name, creds] of Object.entries(origin)) {
    if (creds && typeof creds === "object") connections[name] = creds;
  }
  const active =
    data.active && connections[data.active] ? data.active : Object.keys(connections)[0] || "";

  return { version: FORMATO, active: active, connections: connections };
}

function restrictPermissions(file) {
  try {
    if (process.platform === "win32") {
      const user = process.env.USERNAME || os.userInfo().username;
      spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      fs.chmodSync(file, 0o600);
    }
  } catch {
    // Best effort: if it fails, the file still exists with default permissions.
  }
}

export function loadStore() {
  const file = storePath();
  if (!fs.existsSync(file)) return vacio();

  const contenido = fs.readFileSync(file, "utf8").trim();
  if (!contenido) return vacio();

  try {
    return normalizar(JSON.parse(contenido));
  } catch {
    throw new Error(t("store.corrupt", { file }));
  }
}

export function saveStore(store) {
  const normalizado = normalizar(store);
  const file = storePath();

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(normalizado, null, 2), { encoding: "utf8", mode: 0o600 });
  restrictPermissions(file);
  return normalizado;
}

export function upsertConnection(name, creds, { activate = true } = {}) {
  const store = loadStore();
  store.connections[name] = creds;
  if (activate || !store.active || !store.connections[store.active]) store.active = name;
  return saveStore(store);
}

export function removeConnection(name) {
  const store = loadStore();
  if (!store.connections[name]) return { deleted: false, store };

  delete store.connections[name];
  if (store.active === name) store.active = Object.keys(store.connections)[0] || "";
  return { deleted: true, store: saveStore(store) };
}

export function setActiveConnection(name) {
  const store = loadStore();
  if (!store.connections[name]) throw new Error(`No exists la conexión "${name}".`);
  store.active = name;
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

export function validateName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return t("store.nameRequired");
  if (trimmed.length > 40) return t("store.nameTooLong");
  if (!/^[\w .-]+$/.test(trimmed)) {
    return t("store.nameInvalid");
  }
  return null;
}
