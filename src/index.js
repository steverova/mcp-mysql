#!/usr/bin/env node
/**
 * MCP server para MySQL con múltiples conexiones.
 *
 *  - Conexiones: perfiles con nombre, guardados cifrados con DPAPI, con una activa.
 *  - Lectura: libre (SELECT/SHOW/DESCRIBE/EXPLAIN) dentro de una transacción READ ONLY.
 *  - Escritura: en DOS pasos. `propose_write` valida y describe el impacto sin ejecutar
 *    y devuelve un token de un solo uso. `confirm_write` ejecuta solo si el token es
 *    válido, no ha expirado, coincide con la sentencia y con la conexión.
 *
 * También hay una barrera de interfaz: el permiso `ask` de OpenCode sobre confirm_write.
 *
 * El proceso habla MCP por stdio: NUNCA escribir en stdout (usar console.error).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteStore,
  hasStoredConnections,
  loadStore,
  removeConnection,
  setActiveConnection,
  storePath,
  upsertConnection,
  validarNombre,
} from "./store.js";
import { abrirFormulario } from "./webform.js";
import { esEntrada } from "./cli-util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const archivo of [
  path.join(ROOT, ".env"),
  path.join(process.cwd(), ".env"),
  path.join(path.dirname(process.execPath), ".env"),
]) {
  try {
    process.loadEnvFile(archivo);
    break;
  } catch {
    // Se prueba el siguiente candidato.
  }
}

const bool = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on|si|sí)$/i.test(String(value).trim());
};

const CONFIG = {
  maxRows: Math.max(1, Number(process.env.MYSQL_MAX_ROWS || 200)),
  writeEnabled: bool(process.env.MYSQL_WRITE_ENABLED, true),
  confirmTtl: Math.max(10, Number(process.env.MYSQL_CONFIRM_TTL_SECONDS || 300)),
  connectTimeout: Math.max(1000, Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 10000)),
};

/** ------------------------------------------------------------------ */
/** Conexiones (perfiles)                                              */
/** ------------------------------------------------------------------ */

/** nombre -> { host, port, user, password, database, ssl } */
let perfiles = new Map();
let activo = "";
let confirmada = false;
let confirmadaPara = "";
let formularioAbierto = false;

/** nombre -> { clave, pool } */
const pools = new Map();

const descripcionPerfil = (c) =>
  `${c.user}@${c.host}:${Number(c.port) || 3306}/${c.database || "(sin base)"}`;

function perfilDesdeEnv() {
  if (!process.env.MYSQL_USER) return null;
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || undefined,
    ssl: bool(process.env.MYSQL_SSL, false),
  };
}

function recargarPerfiles() {
  const anteriores = new Set(perfiles.keys());
  const siguiente = new Map();

  const desdeEnv = perfilDesdeEnv();
  if (desdeEnv) siguiente.set("env", desdeEnv);

  let guardados = { active: "", connections: {} };
  try {
    guardados = loadStore();
  } catch (error) {
    console.error("[mcp-mysql] no se pudo leer el almacén:", error.message);
  }

  for (const [nombre, credenciales] of Object.entries(guardados.connections)) {
    // El perfil de entorno no se puede sobrescribir desde el almacén.
    if (!siguiente.has(nombre)) siguiente.set(nombre, credenciales);
  }

  perfiles = siguiente;

  if (guardados.active && perfiles.has(guardados.active)) activo = guardados.active;
  else if (!perfiles.has(activo)) activo = perfiles.has("env") ? "env" : [...perfiles.keys()][0] || "";

  for (const nombre of anteriores) {
    const credenciales = perfiles.get(nombre);
    const entrada = pools.get(nombre);
    if (!credenciales || (entrada && entrada.clave !== JSON.stringify(credenciales))) {
      if (entrada) entrada.pool.end().catch(() => {});
      pools.delete(nombre);
    }
  }
}

function vigilarAlmacen() {
  // El CLI escribe el mismo archivo: si cambia por fuera, se recarga sin reiniciar.
  // Los cambios hechos por el propio MCP ya actualizan perfiles y confirmación.
  try {
    fs.watchFile(storePath(), { interval: 1000 }, (actual, anterior) => {
      if (actual.mtimeMs === anterior.mtimeMs) return;
      recargarPerfiles();
      if (confirmadaPara !== activo) {
        confirmada = false;
        confirmadaPara = "";
      }
      console.error(
        `[mcp-mysql] almacén recargado desde fuera -> activa=${activo || "-"} conexiones=${[...perfiles.keys()].join(",") || "(ninguna)"}`,
      );
    });
  } catch (error) {
    console.error("[mcp-mysql] no se pudo vigilar el almacén:", error.message);
  }
}

function resolverNombre(solicitado) {
  const nombre = (solicitado || "").trim() || activo;
  if (nombre && perfiles.has(nombre)) return nombre;

  const disponibles = [...perfiles.keys()].join(", ") || "(ninguno)";
  if (solicitado) {
    throw new Error(`No existe la conexión "${solicitado}". Disponibles: ${disponibles}.`);
  }
  throw new Error(
    `No hay conexiones configuradas. Usa save_connection para crear una. Disponibles: ${disponibles}.`,
  );
}

function getPool(solicitado) {
  const nombre = resolverNombre(solicitado);
  const credenciales = perfiles.get(nombre);
  const clave = JSON.stringify(credenciales);

  const entrada = pools.get(nombre);
  if (entrada && entrada.clave !== clave) {
    entrada.pool.end().catch(() => {});
    pools.delete(nombre);
  }

  if (!pools.has(nombre)) {
    pools.set(nombre, {
      clave,
      pool: mysql.createPool({
        host: credenciales.host,
        port: Number(credenciales.port) || 3306,
        user: credenciales.user,
        password: credenciales.password,
        database: credenciales.database || undefined,
        ssl: credenciales.ssl ? { rejectUnauthorized: false } : undefined,
        waitForConnections: true,
        connectionLimit: 4,
        maxIdle: 4,
        idleTimeout: 60000,
        connectTimeout: CONFIG.connectTimeout,
        multipleStatements: false,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        timezone: "Z",
      }),
    });
  }

  return pools.get(nombre).pool;
}

function cerrarPool(nombre) {
  const entrada = pools.get(nombre);
  if (entrada) {
    entrada.pool.end().catch(() => {});
    pools.delete(nombre);
  }
}

let formularioActivo = null;

async function abrirDialogoCredenciales({ prefill, nombre } = {}) {
  if (formularioAbierto) {
    return {
      abierto: false,
      mensaje: "Ya hay un formulario de conexiones abierto. Termínalo y reintenta.",
      url: formularioActivo?.url || null,
    };
  }

  formularioAbierto = true;
  try {
    const formulario = await abrirFormulario({
      prefill: { ...(prefill || {}), ...(nombre ? { nombre } : {}) },
      conexiones: [...perfiles.keys()],
      onDone: (resultado) => {
        formularioAbierto = false;
        formularioActivo = null;
        if (resultado.ok) {
          activo = resultado.nombre;
          confirmada = true;
          confirmadaPara = resultado.nombre;
          recargarPerfiles();
          console.error(
            `[mcp-mysql] conexión "${resultado.nombre}" guardada -> ${descripcionPerfil(resultado.credentials)}`,
          );
        } else if (resultado.expirado) {
          console.error("[mcp-mysql] formulario de conexiones expirado");
        } else {
          console.error("[mcp-mysql] formulario cerrado sin guardar");
        }
      },
    });

    formularioActivo = formulario;
    console.error(`[mcp-mysql] formulario de conexiones en ${formulario.url}`);
    return {
      abierto: true,
      url: formulario.url,
      navegador_abierto: formulario.navegador_abierto,
      mensaje:
        "Se abrió el formulario de conexiones en el navegador. Al pulsar Guardar queda activa al instante; después reintenta la herramienta.",
    };
  } catch (excepcion) {
    formularioAbierto = false;
    throw excepcion;
  }
}

function pistaDeError(error) {
  return (
    {
      ECONNREFUSED: "El servidor MySQL no escucha en esa IP/puerto. ¿Está arrancado el servicio?",
      ETIMEDOUT: "Timeout: revisa firewall, red o VPN.",
      ENOTFOUND: "El host no resuelve por DNS.",
      EHOSTUNREACH: "Host inalcanzable desde esta máquina.",
      ER_ACCESS_DENIED_ERROR: "Usuario o contraseña rechazados. Revisa la conexión con save_connection.",
      ER_BAD_DB_ERROR: "La base de datos indicada no existe.",
      ER_NOT_SUPPORTED_AUTH_MODE: "Método de autenticación no soportado por el cliente (mira mysql_native_password).",
    }[error?.code] || "Revisa los datos de conexión."
  );
}

/**
 * Puerta de sesión: hasta que el usuario confirme la base de datos activa, no
 * se ejecuta ninguna operación sobre datos. Así el agente no puede empezar a
 * consultar "la que quedó seleccionada" sin avisar de cuál es.
 */
function exigirConfirmacion(conexion) {
  if (!perfiles.size) return;

  const objetivo = conexion ? resolverNombre(conexion) : activo;
  if (!objetivo) return;
  if (confirmada && confirmadaPara === objetivo) return;

  const credenciales = perfiles.get(objetivo);
  throw new UserError(
    `BD actual: ${objetivo} → ${credenciales.user}@${credenciales.host}:${credenciales.port}/${credenciales.database || "(sin base)"}\n\n` +
      "Todavía no se ha confirmado en esta sesión. Muestra este mensaje al usuario y pregúntale:\n" +
      `  «BD actual: ${objetivo}. ¿Deseas seguir con esta?»\n\n` +
      "Si dice que sí: llama a confirm_connection.\n" +
      'Si prefiere otra: use_connection({nombre:"..."}) o confirm_connection({conexion:"..."}).',
  );
}

/** Activa una conexión (y opcionalmente su base de datos), verificando el acceso. */
async function activarConexion(nombreSolicitado, database) {
  const nombreFinal = resolverNombre(nombreSolicitado);
  const credenciales = { ...perfiles.get(nombreFinal) };

  if (database !== undefined) {
    credenciales.database = database.trim() || undefined;
    if (nombreFinal !== "env") {
      try {
        upsertConnection(nombreFinal, credenciales, { activar: true });
      } catch (excepcion) {
        console.error("[mcp-mysql] no se pudo persistir la base de datos:", excepcion.message);
      }
    }
    perfiles.set(nombreFinal, credenciales);
    cerrarPool(nombreFinal);
  }

  activo = nombreFinal;
  if (nombreFinal !== "env") {
    try {
      setActiveConnection(nombreFinal);
    } catch {
      // Si el almacén falla, seguimos con el cambio en memoria.
    }
  }

  const datos = perfiles.get(nombreFinal);
  const resultado = {
    activa: nombreFinal,
    bd_actual: datos.database || null,
    destino: descripcionPerfil(datos),
  };

  try {
    await getPool(nombreFinal).query("SELECT 1");
    return { ...resultado, conectado: true };
  } catch (error) {
    return { ...resultado, conectado: false, error: formatError(error), pista: pistaDeError(error) };
  }
}

/** ------------------------------------------------------------------ */
/** Utilidades                                                         */
/** ------------------------------------------------------------------ */

class UserError extends Error {}

function formatError(error) {
  if (error instanceof UserError) return error.message;
  const code = error?.code ? error.code + ": " : "";
  return code + (error?.sqlMessage || error?.message || String(error));
}

function text(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function fail(message) {
  return { content: [{ type: "text", text: "ERROR: " + message }], isError: true };
}

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args || {});
    } catch (error) {
      console.error("[mcp-mysql]", error?.stack || error);
      return fail(formatError(error));
    }
  };
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `<buffer ${value.length} bytes>`;
  if (value instanceof Date) return value.toISOString();
  if (depth > 8) return "[...]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitize(item, depth + 1);
    return out;
  }
  return value;
}

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)--[^\n]*/g, "$1 ")
    .replace(/(^|\s)#[^\n]*/g, "$1 ");
}

const READ_FIRST = new Set(["select", "show", "describe", "desc", "explain"]);
const WRITE_FIRST = new Set([
  "insert",
  "update",
  "delete",
  "replace",
  "create",
  "alter",
  "drop",
  "truncate",
  "rename",
]);

const SNEAKY_WRITE =
  /\b(into\s+(out|dump)file|for\s+update|lock\s+in\s+share\s+mode|\binsert\b|\bupdate\b|\bdelete\b|\breplace\b|\bcreate\b|\balter\b|\bdrop\b|\btruncate\b|\brename\b|\bgrant\b|\brevoke\b|\bcall\b|\bload\s+data\b)\b/i;

/** "read" | "write", o lanza UserError. */
function classify(rawSql) {
  if (typeof rawSql !== "string" || !rawSql.trim()) {
    throw new UserError("La sentencia SQL está vacía.");
  }
  const cleaned = stripComments(rawSql).trim().replace(/;+\s*$/, "");
  if (!cleaned) throw new UserError("La sentencia SQL está vacía.");
  if (cleaned.includes(";")) {
    throw new UserError("Solo se permite UNA sentencia por llamada (sin punto y coma interno).");
  }

  const first = (cleaned.match(/^[a-z]+/i)?.[0] || "").toLowerCase();

  if (READ_FIRST.has(first)) {
    if (first !== "show" && first !== "describe" && first !== "desc" && SNEAKY_WRITE.test(cleaned)) {
      throw new UserError(
        "Esa sentencia parece escribir datos (INTO OUTFILE, FOR UPDATE, subconsulta de escritura...). Usa propose_write.",
      );
    }
    return "read";
  }

  if (first === "with") {
    return /\b(insert|update|delete|replace)\b/i.test(cleaned) ? "write" : "read";
  }

  if (WRITE_FIRST.has(first)) return "write";

  throw new UserError(
    `Sentencia no permitida ("${first || "?"}"). Solo SELECT/SHOW/DESCRIBE/EXPLAIN para lectura y INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP/TRUNCATE/RENAME para escritura.`,
  );
}

const normalizar = (sql) => stripComments(sql).trim().replace(/;+\s*$/, "").replace(/\s+/g, " ");
const hashDe = (sql) => crypto.createHash("sha256").update(normalizar(sql)).digest("hex");
const esUpdateSinWhere = (sql) =>
  /^(update|delete)\b/i.test(normalizar(sql)) && !/\bwhere\b/i.test(normalizar(sql));

/** ------------------------------------------------------------------ */
/** Tokens de confirmación (un solo uso, por conexión)                 */
/** ------------------------------------------------------------------ */

const pendientes = new Map();

function limpiarTokens() {
  const ahora = Date.now();
  for (const [token, item] of pendientes) {
    if (item.expiraEn <= ahora) pendientes.delete(token);
  }
}

/** ------------------------------------------------------------------ */
/** Ejecución                                                          */
/** ------------------------------------------------------------------ */

async function ejecutarLectura(sql, conexion, limite) {
  const conn = await getPool(conexion).getConnection();
  try {
    await conn.query("START TRANSACTION READ ONLY");
    let resultado;
    try {
      const [rows, fields] = await conn.query(sql);
      resultado = { rows, fields };
    } finally {
      await conn.query("ROLLBACK").catch(() => {});
    }

    const { rows, fields } = resultado;
    if (!Array.isArray(rows)) return { tipo: "resultado", ...sanitize(rows) };

    const columnas = (fields || []).map((field) => field.name);
    const truncado = rows.length > limite;
    const filas = sanitize(rows.slice(0, limite));

    return {
      filas: filas.length,
      columnas,
      truncado,
      ...(truncado
        ? { aviso: `Resultado limitado a ${limite} filas. Afina el WHERE o usa LIMIT/OFFSET.` }
        : {}),
      datos: filas,
    };
  } finally {
    conn.release();
  }
}

async function estimarImpacto(sql, conexion) {
  const tipo = (normalizar(sql).match(/^[a-z]+/i)?.[0] || "").toLowerCase();
  if (!["update", "delete", "insert", "replace"].includes(tipo)) {
    return { estimacion: "no aplica", nota: "DDL: no se puede estimar el número de filas afectadas." };
  }
  try {
    const [rows] = await getPool(conexion).query("EXPLAIN " + normalizar(sql));
    if (!Array.isArray(rows)) return { estimacion: "desconocida" };
    const filasEstimadas = rows.reduce((total, row) => total + Number(row.rows || 0), 0);
    return {
      estimacion: "~" + filasEstimadas + " filas (según EXPLAIN)",
      acceso: rows.map((row) => `${row.table || "?"} [${row.type || "?"}]${row.key ? " key=" + row.key : ""}`),
    };
  } catch (error) {
    return { estimacion: "desconocida", nota: formatError(error) };
  }
}

async function ejecutarEscritura(sql, conexion) {
  const conn = await getPool(conexion).getConnection();
  try {
    const [result] = await conn.query(sql);
    if (Array.isArray(result)) {
      return { tipo: "filas devueltas", filas: sanitize(result.slice(0, CONFIG.maxRows)) };
    }
    return {
      afectadas: result?.affectedRows ?? null,
      cambiadas: result?.changedRows ?? null,
      insertId: result?.insertId ?? null,
      avisos: result?.warningStatus ?? 0,
      info: result?.info || null,
    };
  } finally {
    conn.release();
  }
}

/** ------------------------------------------------------------------ */
/** Servidor                                                           */
/** ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "mysql", version: "2.0.0" },
  {
    instructions: [
      "Servidor MySQL multi-conexión: lectura directa y escritura confirmada.",
      "",
      "CONEXIONES: cada conexión tiene un nombre. `list_connections` muestra las disponibles y cuál está activa.",
      "`use_connection` cambia la activa. Si el usuario dice «conéctate a ventas», llama a use_connection con ese nombre.",
      "Cualquier herramienta acepta el parámetro `conexion` para apuntar a otra sin cambiar la activa.",
      "Si no hay ninguna conexión, llama a `save_connection` (abre el formulario en el navegador).",
      "Nunca pidas ni escribas contraseñas en el chat.",
      "",
      "CONFIRMACIÓN DE SESIÓN (obligatoria):",
      "La primera operación sobre datos fallará y devolverá «BD actual: X. ¿Deseas seguir con esta?».",
      "Eso NO es un error: es la puerta de sesión. Muestra ese mensaje al usuario tal cual, pregúntale si desea",
      "seguir con esa base y, según su respuesta, llama a confirm_connection (o use_connection para cambiar).",
      "No rodees esta puerta: no intentes otra conexión para evitarla ni la marques como confirmada sin preguntar.",
      "",
      "LECTURA: usa query_read. Solo SELECT/SHOW/DESCRIBE/EXPLAIN, en transacción READ ONLY.",
      "",
      "ESCRITURA (obligatorio, dos pasos):",
      "1) propose_write: valida, estima impacto y devuelve un token. NO modifica nada.",
      "2) Muestra la sentencia y el impacto al usuario y pide confirmación explícita.",
      "3) Solo entonces, confirm_write con la MISMA sentencia, el token y la misma conexión.",
      "El token es de un solo uso, caduca y está atado a la conexión.",
      "Para UPDATE/DELETE sin WHERE hace falta allow_full_table=true.",
    ].join("\n"),
  },
);

server.registerTool(
  "connection_info",
  {
    title: "Estado de la conexión",
    description:
      "Muestra la conexión activa (o la indicada), si conecta, versión del servidor y límites. Útil para verificar antes de trabajar.",
    inputSchema: {
      conexion: z.string().optional().describe("Nombre de la conexión. Por defecto, la activa."),
    },
  },
  wrap(async ({ conexion }) => {
    const estado = {
      activa: activo || null,
      bd_actual: activo && perfiles.has(activo) ? perfiles.get(activo).database || null : null,
      confirmada_en_sesion: confirmada,
      requiere_confirmacion: perfiles.size > 0 && !confirmada,
      disponibles: [...perfiles.keys()],
      almacen: {
        archivo: storePath(),
        existe: hasStoredConnections(),
        formulario_abierto: formularioAbierto,
        formulario_url: formularioActivo?.url || null,
      },
      limites: {
        max_filas: CONFIG.maxRows,
        escritura_habilitada: CONFIG.writeEnabled,
        tokens_validez_segundos: CONFIG.confirmTtl,
      },
    };

    if (!perfiles.size) {
      return text({
        conectado: false,
        ...estado,
        ayuda: "No hay conexiones. Llama a save_connection para crear la primera.",
      });
    }

    let nombre;
    try {
      nombre = resolverNombre(conexion);
    } catch (error) {
      return text({ conectado: false, ...estado, error: error.message });
    }

    const credenciales = perfiles.get(nombre);
    const destino = descripcionPerfil(credenciales);

    try {
      const [rows] = await getPool(nombre).query(
        "SELECT VERSION() AS version, DATABASE() AS base_de_datos, CURRENT_USER() AS usuario, @@hostname AS host, @@port AS puerto",
      );
      return text({
        conectado: true,
        conexion: nombre,
        destino,
        servidor: sanitize(rows[0]) || {},
        ...estado,
      });
    } catch (error) {
      return text({
        conectado: false,
        conexion: nombre,
        destino,
        error: formatError(error),
        pista: pistaDeError(error),
        ...estado,
      });
    }
  }),
);

server.registerTool(
  "list_connections",
  {
    title: "Listar conexiones",
    description: "Lista las conexiones guardadas, cuál está activa y a qué base de datos apunta cada una. No muestra contraseñas.",
    inputSchema: {},
  },
  wrap(async () => {
    const lista = [...perfiles.entries()].map(([nombre, credenciales]) => ({
      nombre,
      destino: descripcionPerfil(credenciales),
      base_de_datos: credenciales.database || null,
      ssl: Boolean(credenciales.ssl),
      activa: nombre === activo,
      origen: nombre === "env" ? "variables de entorno" : "almacén cifrado",
    }));

    return text({
      total: lista.length,
      activa: activo || null,
      conexiones: lista,
      ...(lista.length === 0 ? { siguiente_paso: "Llama a save_connection para crear la primera." } : {}),
    });
  }),
);

server.registerTool(
  "save_connection",
  {
    title: "Crear o editar conexión",
    description:
      "Abre una ventana nativa de Windows para capturar los datos de una conexión (nombre, host, puerto, usuario, contraseña, base, TLS) y la guarda cifrada con DPAPI. La contraseña nunca pasa por el chat.",
    inputSchema: {
      nombre: z.string().optional().describe("Nombre de la conexión. Si ya existe, se actualiza."),
      host: z.string().optional().describe("Valor inicial del host."),
      port: z.number().int().optional().describe("Valor inicial del puerto."),
      user: z.string().optional().describe("Valor inicial del usuario."),
      database: z.string().optional().describe("Base de datos por defecto (opcional)."),
      ssl: z.boolean().optional().describe("Valor inicial de TLS."),
    },
  },
  wrap(async ({ nombre, host, port, user, database, ssl }) => {
    if (nombre) {
      const problema = validarNombre(nombre);
      if (problema) throw new UserError(problema);
    }

    const prefill = {};
    if (host !== undefined) prefill.host = host;
    if (port !== undefined) prefill.port = port;
    if (user !== undefined) prefill.user = user;
    if (database !== undefined) prefill.database = database;
    if (ssl !== undefined) prefill.ssl = ssl;

    const resultado = await abrirDialogoCredenciales({ prefill, nombre });
    return text({
      ...resultado,
      guardado_en: storePath(),
      nota: "También puedes usar el asistente de terminal: npm run login.",
    });
  }),
);

server.registerTool(
  "use_connection",
  {
    title: "Cambiar conexión activa",
    description:
      "Activa una conexión guardada y opcionalmente cambia su base de datos por defecto. Verifica la conexión y deja el resultado listo para usar.",
    inputSchema: {
      nombre: z.string().describe("Nombre de la conexión a activar."),
      database: z.string().optional().describe("Base de datos por defecto a usar (opcional)."),
    },
  },
  wrap(async ({ nombre, database }) => {
    const resultado = await activarConexion(nombre, database);
    confirmada = true;
    confirmadaPara = resultado.activa;
    return text({
      ...resultado,
      mensaje: resultado.conectado
        ? `BD actual: ${resultado.activa}. Conexión verificada.`
        : `BD actual: ${resultado.activa}, pero ahora mismo no conecta.`,
    });
  }),
);

server.registerTool(
  "confirm_connection",
  {
    title: "Confirmar la BD de esta sesión",
    description:
      "Marca la conexión como confirmada para la sesión actual, tras preguntar al usuario. Sin esto, las herramientas de datos se niegan a ejecutar. Permite cambiar de conexión o de base al confirmar.",
    inputSchema: {
      conexion: z.string().optional().describe("Conexión a usar. Si se omite, la activa."),
      database: z.string().optional().describe("Base de datos a usar en esta sesión."),
    },
  },
  wrap(async ({ conexion, database }) => {
    if (!perfiles.size) {
      throw new UserError(
        "No hay conexiones configuradas. Crea una con save_connection, o ejecuta `mysql-mcp add` en la terminal.",
      );
    }

    const resultado = await activarConexion(conexion, database);
    confirmada = true;
    confirmadaPara = resultado.activa;

    return text({
      confirmada: true,
      ...resultado,
      mensaje: resultado.conectado
        ? `BD actual: ${resultado.activa} (${resultado.bd_actual || "sin base por defecto"}). Lista para trabajar.`
        : `BD actual: ${resultado.activa}, pero no conecta. Revisa la conexión antes de continuar.`,
    });
  }),
);

server.registerTool(
  "remove_connection",
  {
    title: "Borrar conexión",
    description:
      "Elimina una conexión guardada (y sus credenciales cifradas). Si era la activa, pasa a otra. No afecta a las variables de entorno.",
    inputSchema: {
      nombre: z.string().describe("Nombre de la conexión a borrar."),
    },
  },
  wrap(async ({ nombre }) => {
    if (nombre === "env") {
      throw new UserError(
        "La conexión 'env' viene de variables de entorno (.env); quita MYSQL_USER para eliminarla.",
      );
    }
    const existia = perfiles.has(nombre);
    if (!existia) {
      throw new UserError(`No existe la conexión "${nombre}". Disponibles: ${[...perfiles.keys()].join(", ") || "(ninguno)"}.`);
    }

    cerrarPool(nombre);
    removeConnection(nombre);
    perfiles.delete(nombre);
    if (!perfiles.has(activo)) activo = perfiles.has("env") ? "env" : [...perfiles.keys()][0] || "";
    confirmada = false;
    confirmadaPara = "";

    return text({
      borrada: nombre,
      activa: activo || null,
      restantes: [...perfiles.keys()],
      ...(perfiles.size ? { nota: "La nueva conexión activa habrá que confirmarla antes de consultar." } : {}),
    });
  }),
);

server.registerTool(
  "reset_credentials",
  {
    title: "Borrar todas las conexiones guardadas",
    description: "Borra del disco todas las conexiones cifradas y las descarta de memoria. No afecta a las variables de entorno.",
    inputSchema: {},
  },
  wrap(async () => {
    for (const nombre of [...pools.keys()]) cerrarPool(nombre);
    const borrado = deleteStore();
    recargarPerfiles();
    confirmada = false;
    confirmadaPara = "";

    return text({
      archivo_borrado: borrado,
      archivo: storePath(),
      activa: activo || null,
      restantes: [...perfiles.keys()],
      siguiente_paso: perfiles.size
        ? "Sigue disponible la conexión de variables de entorno."
        : "Llama a save_connection para volver a crear una.",
    });
  }),
);

server.registerTool(
  "list_tables",
  {
    title: "Listar tablas",
    description:
      "Lista tablas y vistas. Sin esquema usa la base de la conexión (o todas las bases visibles si no tiene una por defecto).",
    inputSchema: {
      schema: z.string().optional().describe("Esquema/base de datos a inspeccionar. Opcional."),
      conexion: z.string().optional().describe("Conexión a usar. Por defecto, la activa."),
    },
  },
  wrap(async ({ schema, conexion }) => {
    exigirConfirmacion(conexion);
    const { nombre, credenciales } = (() => {
      const n = resolverNombre(conexion);
      return { nombre: n, credenciales: perfiles.get(n) };
    })();

    const objetivo = schema || credenciales.database;
    const parametros = [];
    let filtro = "";
    if (objetivo) {
      filtro = " AND table_schema = ?";
      parametros.push(objetivo);
    }

    const [rows] = await getPool(nombre).query(
      `SELECT table_schema AS esquema, table_name AS tabla, table_type AS tipo,
              engine AS motor, table_rows AS filas_aprox
         FROM information_schema.tables
        WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')${filtro}
        ORDER BY table_schema, table_name`,
      parametros,
    );
    return text({
      conexion: nombre,
      total: rows.length,
      esquema: objetivo || "(todos)",
      tablas: sanitize(rows),
    });
  }),
);

server.registerTool(
  "describe_table",
  {
    title: "Describir tabla",
    description: "Devuelve columnas, índices y claves foráneas de una tabla.",
    inputSchema: {
      table: z.string().describe("Nombre de la tabla."),
      schema: z.string().optional().describe("Esquema/base de datos. Opcional."),
      conexion: z.string().optional().describe("Conexión a usar. Por defecto, la activa."),
    },
  },
  wrap(async ({ table, schema, conexion }) => {
    exigirConfirmacion(conexion);
    const nombre = resolverNombre(conexion);
    const objetivo = schema || perfiles.get(nombre).database;
    if (!objetivo) {
      throw new UserError("Indica el esquema/base de datos (esta conexión no tiene una por defecto).");
    }

    const [columnas] = await getPool(nombre).query(
      `SELECT column_name AS columna, column_type AS tipo, is_nullable AS nulo,
              column_default AS por_defecto, column_key AS clave, extra AS extra
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`,
      [objetivo, table],
    );
    if (!columnas.length) throw new UserError(`No existe la tabla ${objetivo}.${table}.`);

    const [indices] = await getPool(nombre).query(
      `SELECT index_name AS indice, non_unique AS no_unico, seq_in_index AS posicion,
              column_name AS columna, index_type AS tipo
         FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = ?
        ORDER BY index_name, seq_in_index`,
      [objetivo, table],
    );

    const [foraneas] = await getPool(nombre).query(
      `SELECT constraint_name AS restriccion, column_name AS columna,
              referenced_table_schema AS esquema_referenciado,
              referenced_table_name AS tabla_referenciada,
              referenced_column_name AS columna_referenciada
         FROM information_schema.key_column_usage
        WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL
        ORDER BY constraint_name`,
      [objetivo, table],
    );

    return text({
      conexion: nombre,
      tabla: `${objetivo}.${table}`,
      columnas: sanitize(columnas),
      indices: sanitize(indices),
      claves_foraneas: sanitize(foraneas),
    });
  }),
);

server.registerTool(
  "query_read",
  {
    title: "Consultar (solo lectura)",
    description:
      "Ejecuta SELECT/SHOW/DESCRIBE/EXPLAIN en una transacción READ ONLY. Rechaza escrituras y limita las filas devueltas.",
    inputSchema: {
      sql: z.string().describe("Sentencia de lectura. Una sola sentencia, sin punto y coma final."),
      max_rows: z.number().int().positive().optional().describe(`Máximo de filas (por defecto ${CONFIG.maxRows}).`),
      conexion: z.string().optional().describe("Conexión a usar. Por defecto, la activa."),
    },
  },
  wrap(async ({ sql, max_rows, conexion }) => {
    if (classify(sql) !== "read") {
      throw new UserError(
        "query_read es solo para lectura. Para modificar datos usa propose_write y luego confirm_write.",
      );
    }
    exigirConfirmacion(conexion);
    const nombre = resolverNombre(conexion);
    const limite = Math.min(max_rows || CONFIG.maxRows, 5000);
    const resultado = await ejecutarLectura(sql, nombre, limite);
    return text({ conexion: nombre, ...resultado });
  }),
);

server.registerTool(
  "propose_write",
  {
    title: "Proponer escritura (paso 1/2)",
    description:
      "Valida una sentencia de escritura y devuelve su impacto estimado MÁS un token de confirmación. NO modifica la base de datos. Muestra el resultado al usuario antes de confirmar.",
    inputSchema: {
      sql: z.string().describe("Sentencia de escritura (INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP/TRUNCATE/RENAME)."),
      motivo: z.string().optional().describe("Por qué se necesita el cambio. Ayuda al usuario a decidir."),
      conexion: z.string().optional().describe("Conexión a usar. Por defecto, la activa."),
    },
  },
  wrap(async ({ sql, motivo, conexion }) => {
    if (classify(sql) !== "write") {
      throw new UserError("Esa sentencia es de lectura. Usa query_read directamente.");
    }
    if (!CONFIG.writeEnabled) {
      throw new UserError("La escritura está deshabilitada (MYSQL_WRITE_ENABLED=false).");
    }

    exigirConfirmacion(conexion);
    const nombre = resolverNombre(conexion);
    const sentencia = normalizar(sql);
    const impacto = await estimarImpacto(sentencia, nombre);

    limpiarTokens();
    const token = crypto.randomUUID();
    pendientes.set(token, {
      hash: hashDe(sentencia),
      sentencia,
      conexion: nombre,
      motivo: motivo || null,
      expiraEn: Date.now() + CONFIG.confirmTtl * 1000,
    });

    const avisos = [];
    if (esUpdateSinWhere(sentencia)) {
      avisos.push(
        "ATENCIÓN: la sentencia no tiene WHERE; afectará a TODA la tabla. confirm_write exigirá allow_full_table=true.",
      );
    }
    if (/^(drop|truncate)\b/i.test(sentencia)) {
      avisos.push("ATENCIÓN: DDL destructivo. No se puede deshacer.");
    }

    return text({
      estado: "PENDIENTE DE CONFIRMACIÓN - no se ha modificado nada",
      conexion: nombre,
      destino: descripcionPerfil(perfiles.get(nombre)),
      sentencia,
      motivo: motivo || null,
      impacto,
      avisos,
      token,
      valido_durante_segundos: CONFIG.confirmTtl,
      siguiente_paso:
        "Muestra esta sentencia, la conexión y el impacto al usuario. Si confirma, llama confirm_write con la MISMA sentencia, este token y la misma conexión.",
    });
  }),
);

server.registerTool(
  "confirm_write",
  {
    title: "Confirmar escritura (paso 2/2)",
    description:
      "Ejecuta la sentencia SOLO si el token de propose_write es válido, no ha caducado y coincide con la sentencia y la conexión. Consume el token (un solo uso).",
    inputSchema: {
      sql: z.string().describe("La MISMA sentencia aprobada en propose_write."),
      token: z.string().describe("Token devuelto por propose_write."),
      allow_full_table: z
        .boolean()
        .optional()
        .describe("Requerido para UPDATE/DELETE sin WHERE. Solo si el usuario lo autorizó explícitamente."),
      conexion: z.string().optional().describe("Debe coincidir con la conexión de la propuesta."),
    },
  },
  wrap(async ({ sql, token, allow_full_table, conexion }) => {
    if (!CONFIG.writeEnabled) {
      throw new UserError("La escritura está deshabilitada (MYSQL_WRITE_ENABLED=false).");
    }
    if (classify(sql) !== "write") throw new UserError("Esa sentencia no es de escritura.");

    limpiarTokens();
    const pendiente = pendientes.get(token);
    if (!pendiente) {
      throw new UserError(
        "Token inválido, ya usado o caducado. Vuelve a llamar propose_write y pide confirmación otra vez.",
      );
    }
    if (pendiente.hash !== hashDe(sql)) {
      throw new UserError("La sentencia no coincide con la que se propuso. Vuelve a empezar con propose_write.");
    }
    if (conexion && conexion !== pendiente.conexion) {
      throw new UserError(
        `La propuesta era para la conexión "${pendiente.conexion}", no para "${conexion}". Vuelve a proponer.`,
      );
    }
    if (esUpdateSinWhere(sql) && allow_full_table !== true) {
      throw new UserError(
        "UPDATE/DELETE sin WHERE y sin allow_full_table=true. Confirma con el usuario y reintenta indicando allow_full_table=true.",
      );
    }

    pendientes.delete(token);
    const resultado = await ejecutarEscritura(sql, pendiente.conexion);
    return text({
      estado: "EJECUTADO",
      conexion: pendiente.conexion,
      destino: descripcionPerfil(perfiles.get(pendiente.conexion) || {}),
      sentencia: normalizar(sql),
      resultado,
      token_consumido: true,
    });
  }),
);

/** ------------------------------------------------------------------ */

export async function iniciarServidor() {
  recargarPerfiles();
  vigilarAlmacen();

  const transporte = new StdioServerTransport();
  await server.connect(transporte);
  console.error(
    `[mcp-mysql] listo -> conexiones=${[...perfiles.keys()].join(",") || "(ninguna)"} activa=${activo || "-"} escritura=${CONFIG.writeEnabled ? "on" : "off"}`,
  );

  if (!perfiles.size && bool(process.env.MYSQL_PROMPT_ON_START, true)) {
    const resultado = await abrirDialogoCredenciales();
    console.error("[mcp-mysql] sin conexiones:", resultado.url || resultado.mensaje);
  }
}

if (esEntrada(import.meta.url)) {
  await iniciarServidor();
}
