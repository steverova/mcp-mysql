/**
 * Local form to capture MySQL connections.
 *
 * It starts an HTTP server on 127.0.0.1 (random port) and opens the browser.
 * Works the same on Windows, macOS, Linux and WSL; no native dependencies and no
 * platform-specific code. The password travels over loopback and never reaches
 * the chat history or the OpenCode configuration.
 */
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { upsertConnection, validateName } from "./store.js";
import { LANGUAGE, t } from "./i18n.js";

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (caracter) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[caracter],
  );

function openBrowser(url) {
  if (process.env.MCP_MYSQL_NO_BROWSER === "1") return false;

  let command;
  let args;
  if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.env.WSL_DISTRO_NAME) {
    command = "wslview";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function renderPage({ token, connections = [], prefill = {}, error, saved } = {}) {
  const options = connections
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join("");

  if (saved) {
    return `<!doctype html><html lang="${LANGUAGE}"><head><meta charset="utf-8">
<title>${t("webform.savedTitle")}</title><style>${STYLES}</style></head>
<body><main class="tarjeta">
  <h1>✅ ${t("webform.savedTitle")}</h1>
  <p>${t("webform.savedBody", { name: escapeHtml(saved) })}</p>
  <p class="nota">${t("webform.savedHint")}</p>
</main></body></html>`;
  }

  if (error) {
    return `<!doctype html><html lang="${LANGUAGE}"><head><meta charset="utf-8">
<title>${t("webform.errorTitle")}</title><style>${STYLES}</style></head>
<body><main class="tarjeta">
  <h1>⚠️ ${t("webform.errorTitle")}</h1>
  <p class="error">${escapeHtml(error)}</p>
  <p><a href="/?token=${escapeHtml(token)}">${t("webform.back")}</a></p>
</main></body></html>`;
  }

  return `<!doctype html><html lang="${LANGUAGE}"><head><meta charset="utf-8">
<title>${t("webform.newTitle")}</title><style>${STYLES}</style></head>
<body><main class="tarjeta">
  <h1>${t("webform.newTitle")}</h1>
  <p class="nota">${t("webform.note")}</p>
  <form method="post" action="/save">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <label>${t("webform.name")}
      <input name="name" value="${escapeHtml(prefill.name || "")}" list="existingNames" required maxlength="40" placeholder="${t("webform.namePlaceholder")}">
      <datalist id="existingNames">${options}</datalist>
    </label>
    <div class="row">
      <label>${t("webform.host")}<input name="host" value="${escapeHtml(prefill.host || "127.0.0.1")}" required></label>
      <label class="corto">${t("webform.port")}<input name="port" type="number" value="${escapeHtml(prefill.port || 3306)}" required min="1" max="65535"></label>
    </div>
    <label>${t("webform.user")}<input name="user" value="${escapeHtml(prefill.user || "")}" required></label>
    <label>${t("webform.password")}<input name="password" type="password" value="" autocomplete="off"></label>
    <label>${t("webform.database")} <span class="opcional">(${t("webform.optional")})</span>
      <input name="database" value="${escapeHtml(prefill.database || "")}" placeholder="${t("webform.leaveEmpty")}">
    </label>
    <label class="check"><input name="ssl" type="checkbox" value="1" ${prefill.ssl ? "checked" : ""}> ${t("webform.ssl")}</label>
    <button type="submit">${t("webform.save")}</button>
  </form>
</main></body></html>`;
}

const STYLES = `
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
.row { display:flex; gap:12px; }
.row label { flex:1; }
.row .corto { flex:0 0 110px; }
.check { display:flex; align-items:center; gap:8px; }
.check input { width:auto; margin:0; }
button { width:100%; margin-top:8px; padding:11px; background:#3b82f6; color:#fff; border:0;
  border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
button:hover { background:#2f6fd8; }
.error { color:#f87171; }
a { color:#60a5fa; }
`;

/**
 * Starts the form. Non-blocking: returns { open, url } and calls onDone
 * when the user saves, cancels or the time expires.
 */
export function openForm({ prefill = {}, connections = [], onDone, timeoutMs = 600000 } = {}) {
  const token = crypto.randomBytes(16).toString("hex");
  let cerrado = false;
  let serverInfo = null;

  const finish = (result) => {
    if (cerrado) return;
    cerrado = true;
    clearTimeout(temporizador);
    try {
      serverInfo?.close();
    } catch {
      /* ignorado */
    }
    onDone?.(result);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (trozo) => {
        body += trozo;
        if (body.length > 64 * 1024) reject(new Error(t("webform.bodyTooLarge")));
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });

  const responder = (res, codigo, html) => {
    res.writeHead(codigo, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  };

  serverInfo = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      if (url.searchParams.get("token") !== token) {
        responder(res, 403, `<h1>${t("webform.invalidLink")}</h1>`);
        return;
      }
      responder(res, 200, renderPage({ token, connections, prefill }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/save") {
      try {
        const body = await readBody(req);
        const data = new URLSearchParams(body);

        if (data.get("token") !== token) {
          responder(res, 403, renderPage({ token, connections, prefill, error: t("webform.invalidToken") }));
          return;
        }

        const name = (data.get("name") || "").trim();
        const nameProblem = validateName(name);
        if (nameProblem) {
          responder(res, 400, renderPage({ token, connections, prefill, error: nameProblem }));
          return;
        }

        const port = Number(data.get("port"));
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          responder(res, 400, renderPage({ token, connections, prefill, error: t("webform.badPort") }));
          return;
        }

        const user = (data.get("user") || "").trim();
        if (!user) {
          responder(res, 400, renderPage({ token, connections, prefill, error: t("webform.userRequired") }));
          return;
        }

        const creds = {
          host: (data.get("host") || "127.0.0.1").trim(),
          port: port,
          user: user,
          password: data.get("password") || "",
          database: (data.get("database") || "").trim() || undefined,
          ssl: data.get("ssl") === "1",
        };

        upsertConnection(name, creds, { activate: true });
        responder(res, 200, renderPage({ saved: name }));

        setTimeout(() => finish({ ok: true, name, credentials: creds }), 600);
      } catch (error) {
        responder(res, 500, renderPage({ token, connections, prefill, error: error.message }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    responder(res, 404, `<h1>${t("webform.notFound")}</h1>`);
  });

  const temporizador = setTimeout(
    () => finish({ ok: false, expirado: true, error: t("webform.expired") }),
    timeoutMs,
  );

  return new Promise((resolve, reject) => {
    serverInfo.once("error", reject);
    serverInfo.listen(0, "127.0.0.1", () => {
      const { port } = serverInfo.address();
      const url = `http://127.0.0.1:${port}/?token=${token}`;

      if (process.env.MCP_MYSQL_FORM_URL_FILE) {
        try {
          fs.writeFileSync(process.env.MCP_MYSQL_FORM_URL_FILE, url, "utf8");
        } catch {
          /* ignorado */
        }
      }

      const open = openBrowser(url);
      resolve({ open: true, url, port: port, browserOpened: open, close: () => finish({ ok: false }) });
    });
  });
}
