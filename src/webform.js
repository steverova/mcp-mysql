/**
 * Formulario local para capturar conexiones MySQL.
 *
 * Se levanta un servidor HTTP en 127.0.0.1 (puerto aleatorio) y se abre el
 * navegador. Funciona igual en Windows, macOS, Linux y WSL; no hay dependencias
 * nativas ni código específico de plataforma. La contraseña viaja por loopback
 * y nunca entra en el historial del chat ni en la configuración de OpenCode.
 */
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { upsertConnection, validarNombre } from "./store.js";

const escapar = (valor) =>
  String(valor ?? "").replace(
    /[&<>"']/g,
    (caracter) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[caracter],
  );

function abrirNavegador(url) {
  if (process.env.MCP_MYSQL_NO_BROWSER === "1") return false;

  let comando;
  let argumentos;
  if (process.platform === "win32") {
    comando = "cmd.exe";
    argumentos = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    comando = "open";
    argumentos = [url];
  } else if (process.env.WSL_DISTRO_NAME) {
    comando = "wslview";
    argumentos = [url];
  } else {
    comando = "xdg-open";
    argumentos = [url];
  }

  try {
    const hijo = spawn(comando, argumentos, { detached: true, stdio: "ignore", windowsHide: true });
    hijo.on("error", () => {});
    hijo.unref();
    return true;
  } catch {
    return false;
  }
}

function pagina({ token, conexiones = [], prefill = {}, error, guardada } = {}) {
  const opciones = conexiones
    .map((nombre) => `<option value="${escapar(nombre)}"></option>`)
    .join("");

  if (guardada) {
    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Conexión guardada</title><style>${ESTILOS}</style></head>
<body><main class="tarjeta">
  <h1>✅ Conexión guardada</h1>
  <p>Se guardó <strong>${escapar(guardada)}</strong> y quedó activa.</p>
  <p class="nota">Ya puedes cerrar esta pestaña y volver a OpenCode.</p>
</main></body></html>`;
  }

  if (error) {
    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Error</title><style>${ESTILOS}</style></head>
<body><main class="tarjeta">
  <h1>⚠️ No se pudo guardar</h1>
  <p class="error">${escapar(error)}</p>
  <p><a href="/?token=${escapar(token)}">Volver al formulario</a></p>
</main></body></html>`;
  }

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Nueva conexión MySQL</title><style>${ESTILOS}</style></head>
<body><main class="tarjeta">
  <h1>Nueva conexión MySQL</h1>
  <p class="nota">Los datos se guardan en tu equipo. La contraseña no pasa por el chat.</p>
  <form method="post" action="/guardar">
    <input type="hidden" name="token" value="${escapar(token)}">
    <label>Nombre
      <input name="nombre" value="${escapar(prefill.nombre || "")}" list="existentes" required maxlength="40" placeholder="local, ventas, produccion...">
      <datalist id="existentes">${opciones}</datalist>
    </label>
    <div class="fila">
      <label>Host<input name="host" value="${escapar(prefill.host || "127.0.0.1")}" required></label>
      <label class="corto">Puerto<input name="port" type="number" value="${escapar(prefill.port || 3306)}" required min="1" max="65535"></label>
    </div>
    <label>Usuario<input name="user" value="${escapar(prefill.user || "")}" required></label>
    <label>Contraseña<input name="password" type="password" value="" autocomplete="off"></label>
    <label>Base de datos <span class="opcional">(opcional)</span>
      <input name="database" value="${escapar(prefill.database || "")}" placeholder="déjala vacía para ver todas">
    </label>
    <label class="check"><input name="ssl" type="checkbox" value="1" ${prefill.ssl ? "checked" : ""}> Usar TLS/SSL</label>
    <button type="submit">Guardar conexión</button>
  </form>
</main></body></html>`;
}

const ESTILOS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0f1115;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color:#e6e8ee; padding:24px; }
.tarjeta { width:100%; max-width:460px; background:#171a21; border:1px solid #262b36; border-radius:14px; padding:26px; }
h1 { font-size:19px; margin:0 0 6px; }
.nota { color:#8b93a7; font-size:13px; margin:0 0 18px; }
.opcional { color:#8b93a7; font-weight:400; }
label { display:block; font-size:13px; color:#b9c0d0; margin-bottom:12px; }
input { width:100%; margin-top:5px; padding:9px 11px; background:#0f1115; color:#e6e8ee;
  border:1px solid #2e3442; border-radius:8px; font-size:14px; }
input:focus { outline:2px solid #3b82f6; outline-offset:-1px; border-color:#3b82f6; }
.fila { display:flex; gap:12px; }
.fila label { flex:1; }
.fila .corto { flex:0 0 110px; }
.check { display:flex; align-items:center; gap:8px; }
.check input { width:auto; margin:0; }
button { width:100%; margin-top:8px; padding:11px; background:#3b82f6; color:#fff; border:0;
  border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
button:hover { background:#2f6fd8; }
.error { color:#f87171; }
a { color:#60a5fa; }
`;

/**
 * Levanta el formulario. No bloquea: devuelve { abierto, url } y llama a onDone
 * cuando el usuario guarda, cancela o expira el tiempo.
 */
export function abrirFormulario({ prefill = {}, conexiones = [], onDone, timeoutMs = 600000 } = {}) {
  const token = crypto.randomBytes(16).toString("hex");
  let cerrado = false;
  let servidor = null;

  const terminar = (resultado) => {
    if (cerrado) return;
    cerrado = true;
    clearTimeout(temporizador);
    try {
      servidor?.close();
    } catch {
      /* ignorado */
    }
    onDone?.(resultado);
  };

  const leerCuerpo = (req) =>
    new Promise((resolve, reject) => {
      let cuerpo = "";
      req.on("data", (trozo) => {
        cuerpo += trozo;
        if (cuerpo.length > 64 * 1024) reject(new Error("cuerpo demasiado grande"));
      });
      req.on("end", () => resolve(cuerpo));
      req.on("error", reject);
    });

  const responder = (res, codigo, html) => {
    res.writeHead(codigo, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  };

  servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      if (url.searchParams.get("token") !== token) {
        responder(res, 403, `<h1>Enlace no válido</h1>`);
        return;
      }
      responder(res, 200, pagina({ token, conexiones, prefill }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/guardar") {
      try {
        const cuerpo = await leerCuerpo(req);
        const datos = new URLSearchParams(cuerpo);

        if (datos.get("token") !== token) {
          responder(res, 403, pagina({ token, conexiones, prefill, error: "Token inválido. Vuelve a abrir el formulario." }));
          return;
        }

        const nombre = (datos.get("nombre") || "").trim();
        const problemaNombre = validarNombre(nombre);
        if (problemaNombre) {
          responder(res, 400, pagina({ token, conexiones, prefill, error: problemaNombre }));
          return;
        }

        const puerto = Number(datos.get("port"));
        if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
          responder(res, 400, pagina({ token, conexiones, prefill, error: "El puerto no es válido." }));
          return;
        }

        const usuario = (datos.get("user") || "").trim();
        if (!usuario) {
          responder(res, 400, pagina({ token, conexiones, prefill, error: "El usuario es obligatorio." }));
          return;
        }

        const credenciales = {
          host: (datos.get("host") || "127.0.0.1").trim(),
          port: puerto,
          user: usuario,
          password: datos.get("password") || "",
          database: (datos.get("database") || "").trim() || undefined,
          ssl: datos.get("ssl") === "1",
        };

        upsertConnection(nombre, credenciales, { activar: true });
        responder(res, 200, pagina({ guardada: nombre }));

        setTimeout(() => terminar({ ok: true, nombre, credentials: credenciales }), 600);
      } catch (error) {
        responder(res, 500, pagina({ token, conexiones, prefill, error: error.message }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    responder(res, 404, "<h1>No encontrado</h1>");
  });

  const temporizador = setTimeout(
    () => terminar({ ok: false, expirado: true, error: "El formulario expiró." }),
    timeoutMs,
  );

  return new Promise((resolve, reject) => {
    servidor.once("error", reject);
    servidor.listen(0, "127.0.0.1", () => {
      const { port } = servidor.address();
      const url = `http://127.0.0.1:${port}/?token=${token}`;

      if (process.env.MCP_MYSQL_FORM_URL_FILE) {
        try {
          fs.writeFileSync(process.env.MCP_MYSQL_FORM_URL_FILE, url, "utf8");
        } catch {
          /* ignorado */
        }
      }

      const abierto = abrirNavegador(url);
      resolve({ abierto: true, url, puerto: port, navegador_abierto: abierto, cerrar: () => terminar({ ok: false }) });
    });
  });
}
