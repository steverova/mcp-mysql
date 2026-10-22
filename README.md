# mcp-mysql

Servidor MCP para MySQL con **múltiples conexiones**, **multiplataforma** (Windows, macOS, Linux),
lectura libre y escritura siempre confirmada en dos pasos.

- Sin dependencias nativas, sin PowerShell, sin ventanas del sistema.
- Las contraseñas no pasan por el chat: formulario local o asistente de terminal.
- Ninguna escritura se ejecuta sin una propuesta previa y un token de un solo uso.
- Antes de consultar, el servidor exige confirmar la base de datos de la sesión.

Guía práctica paso a paso: [`USO.md`](USO.md).

---

## Dos piezas, un mismo archivo

El proyecto tiene dos entradas que **no se llaman entre sí**: comparten el archivo de conexiones.

```
                     ┌──────────────────────────────────┐
  tú ──terminal──▶   │ mysql-mcp  (CLI)                 │
                     │ list · add · use · remove        │
                     └───────────────┬──────────────────┘
                                     │ escribe / lee
                                     ▼
                   %APPDATA%\mcp-mysql\connections.json
                                     ▲
                                     │ lee (y vigila cambios)
                     ┌───────────────┴──────────────────┐
  OpenCode ──spawn─▶ │ node src/index.js  (MCP, stdio)  │──▶ MySQL
  (lo arranca él)    └──────────────────────────────────┘
```

| | CLI `mysql-mcp` | Servidor MCP `src/index.js` |
|---|---|---|
| Para quién | Para ti, en una terminal | Para OpenCode |
| Quién lo arranca | Tú, a mano | OpenCode, al iniciarse |
| Protocolo | Comandos y salida de texto | JSON-RPC por stdin/stdout |
| ¿Queda corriendo? | No, termina al acabar | Sí, mientras OpenCode viva |
| ¿Necesita PATH? | Sí | No (ruta absoluta) |

**No hay que arrancar el MCP a mano.** OpenCode lo lanza él mismo leyendo
`~/.config/opencode/opencode.json`:

```jsonc
"mysql": {
  "type": "local",
  "command": ["node", "C:/Users/steve/mcp-mysql/src/index.js"]
}
```

Si ejecutas `mysql-mcp` en una terminal, verás que se queda colgado: está esperando JSON-RPC por
stdin. Eso es normal, no es un fallo; ciérralo con `Ctrl+C`.

### Cambios en caliente

El servidor **vigila el archivo** (cada segundo). Si cambias de conexión desde la terminal:

```powershell
mysql-mcp use ventas
```

el MCP que ya está corriendo lo detecta, recarga las conexiones y te vuelve a pedir confirmación
(`BD actual: ventas. ¿Deseas seguir con esta?`). No hace falta reiniciar OpenCode.

Lo único que **sí** exige reiniciar es cambiar el **código** del servidor (`src/*.js`).

### Cómo comprobar que el MCP está vivo

En OpenCode, pídelo directamente: «¿en qué base estás?» → responde `connection_info`.
Desde fuera:

```bash
opencode mcp list      # si tu versión de OpenCode lo soporta
```

---

## Instalación

```bash
cd mcp-mysql
npm install
npm link                 # instala el comando global `mysql-mcp`
mysql-mcp add            # crea la primera conexión (abre el navegador)
mysql-mcp doctor         # verifica que conecta
```

Si `mysql-mcp` no aparece, abre una terminal nueva o usa
`C:\Users\steve\bin\mysql-mcp.cmd` (Windows).

### Binarios (sin Node instalado)

```bash
npm run build        # solo tu plataforma
npm run build:all    # Windows, Linux y macOS
```

| Archivo | Plataforma | Tamaño |
|---|---|---|
| `dist/mysql-mcp-windows-x64.exe` | Windows x64 | 84 MB |
| `dist/mysql-mcp-linux-x64` | Linux x64 | 79 MB |
| `dist/mysql-mcp-darwin-arm64` | macOS Apple Silicon | 61 MB |
| `dist/mysql-mcp-darwin-x64` | macOS Intel | 68 MB |

Cada binario incluye el runtime, las dependencias, el CLI y el servidor MCP. No requiere
`npm install` ni Node en la máquina destino.

```powershell
.\dist\mysql-mcp-windows-x64.exe status
.\dist\mysql-mcp-windows-x64.exe doctor
```

Y para que OpenCode use el binario como servidor:

```jsonc
"mysql": {
  "type": "local",
  "command": ["C:/Users/steve/mcp-mysql/dist/mysql-mcp-windows-x64.exe", "start"]
}
```

El binario busca `.env` junto al ejecutable y en el directorio actual. `dist/` está en
`.gitignore`: los binarios se adjuntan a un release, no al repositorio. No están firmados, así
que Windows puede mostrar un aviso de SmartScreen la primera vez.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `mysql-mcp status` | BD seleccionada, servidor, base y TLS |
| `mysql-mcp list` | Todas las conexiones (`*` = activa) |
| `mysql-mcp add [nombre]` | Crear o editar una conexión (navegador) |
| `mysql-mcp add --tui` | Igual, con el asistente de terminal |
| `mysql-mcp form` | Abrir solo el formulario |
| `mysql-mcp use [nombre]` | Activar una conexión (sin nombre: selector) |
| `mysql-mcp remove [nombre]` | Borrar una (sin nombre: selector) |
| `mysql-mcp remove --all` | Borrar todas |
| `mysql-mcp doctor [--all]` | Probar la conexión activa o todas |
| `mysql-mcp path` | Ruta del archivo de conexiones |
| `mysql-mcp` | Arrancar el servidor MCP (lo usa OpenCode) |

---

## Cómo se capturan las credenciales

Dos caminos, ninguno mete contraseñas en la conversación:

**1. Formulario local.** `save_connection` / `mysql-mcp add` levanta un servidor HTTP en
`127.0.0.1` con puerto aleatorio y token de un solo uso, y abre el navegador. Solo acepta
peticiones con ese token, y se cierra al guardar o al expirar (10 min).

**2. Asistente de terminal.** `mysql-mcp add --tui` pide los datos en tu terminal, con la
contraseña enmascarada, y prueba la conexión antes de guardar.

> Un servidor MCP por stdio **no puede dibujar en la TUI del cliente**: su stdin/stdout son el
> canal del protocolo. Cualquier lectura de consola ahí bloquearía el servidor. Por eso el
> formulario o el asistente, nunca un `prompt` dentro del proceso MCP.

---

## Dónde se guardan las contraseñas (sin adornos)

**Se guardan en texto plano** en un archivo JSON local. No hay cifrado, ni llavero del sistema,
ni DPAPI. Igual que `~/.aws/credentials` o `~/.npmrc`.

| Sistema | Archivo |
|---|---|
| Windows | `%APPDATA%\mcp-mysql\connections.json` |
| macOS / Linux | `$XDG_CONFIG_HOME/mcp-mysql/connections.json` → normalmente `~/.config/mcp-mysql/connections.json` |
| Personalizado | Lo que indique `MCP_MYSQL_STORE` |

Contenido real del archivo (ejemplo con datos ficticios):

```json
{
  "version": 3,
  "active": "steve_local",
  "connections": {
    "steve_local": {
      "host": "127.0.0.1",
      "port": 3306,
      "user": "steve_local",
      "password": "123456",
      "database": "steve_demo",
      "ssl": false
    }
  }
}
```

### Qué protección existe

- El archivo se crea con permisos de **solo tu usuario**: `0600` en macOS/Linux, ACL restrictiva
  (`icacls`) en Windows. Otros usuarios de la máquina no pueden leerlo.
- Vive fuera del proyecto, así que no entra en Git por accidente.
- La contraseña nunca se escribe en `opencode.json`, ni en argumentos de línea de comandos, ni en
  logs. El servidor no imprime credenciales: solo nombres de conexión y destinos.

### Qué protección NO existe

- **Nada de cifrado en reposo.** Quien pueda leer el archivo con tu usuario, lee la contraseña.
- Cualquier proceso ejecutándose **como tu usuario** puede leerlo.
- Entra en copias de seguridad, instantáneas del sistema y, si `%APPDATA%` está sincronizado
  (OneDrive, iCloud, etc.), en la nube.
- El formulario envía la contraseña por HTTP en loopback (sin TLS). Es local, pero no está
  cifrado en tránsito: otro proceso local con privilegios podría observarlo.
- Las variables de entorno tienen la misma exposición: cualquier proceso hijo puede leerlas.

### Cómo reducirlo

1. **Usuario MySQL con privilegios mínimos.** Es la defensa que de verdad importa:

   ```sql
   CREATE USER 'mcp'@'localhost' IDENTIFIED BY 'contraseña_larga';
   GRANT SELECT, INSERT, UPDATE, DELETE ON tu_base.* TO 'mcp'@'localhost';
   -- sin GRANT ALL, sin DROP, sin acceso a mysql.*
   ```

2. **Sin contraseña en disco:** define `MYSQL_USER` / `MYSQL_PASSWORD` en el entorno y no crees
   conexiones guardadas. La conexión `env` manda sobre el archivo.

3. **Borrar lo que no uses:** `mysql-mcp remove <nombre>` o `mysql-mcp remove --all`.

4. **Solo lectura mientras pruebas:** `MYSQL_WRITE_ENABLED=false`.

5. Si el archivo se filtra: cambia la contraseña del usuario MySQL y vuelve a crearla con
   `mysql-mcp add`.

---

## Confirmación de sesión

Al arrancar, el servidor no asume nada: la primera operación sobre datos se niega y responde con
la conexión que quedó seleccionada.

```
BD actual: steve_local → steve_local@127.0.0.1:3306/steve_demo
¿Deseas seguir con esta?
```

- Si aceptas: el agente llama a `confirm_connection` y continúa.
- Si prefieres otra: `use_connection` o `confirm_connection({conexion:"..."})`.
- Se pide una vez por proceso; al reiniciar OpenCode vuelve a preguntar.
- `query_read`, `list_tables`, `describe_table` y `propose_write` están bloqueadas hasta entonces.

---

## Herramientas

| Herramienta | ¿Modifica datos? |
|---|---|
| `connection_info` | No |
| `list_connections` | No |
| `list_tables`, `describe_table` | No |
| `query_read` (`SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN`, transacción `READ ONLY`) | No |
| `propose_write` (valida, estima impacto, devuelve token) | **No** |
| `confirm_write` (ejecuta solo con token válido) | Sí |
| `save_connection`, `use_connection`, `confirm_connection` | No (configuración) |
| `remove_connection`, `reset_credentials` | No (solo borran configuración) |

Todas las herramientas de datos aceptan `conexion` para apuntar a otra conexión sin cambiar la
activa.

---

## Escritura en dos pasos

```
propose_write(sql, conexion?)  ->  { token, impacto, avisos }   sin cambios en la BD
        ↓ se muestra al usuario, que confirma
confirm_write(sql, token, conexion?)  ->  { estado: "EJECUTADO", afectadas: N }
```

- Token de un solo uso, caduca a los `MYSQL_CONFIRM_TTL_SECONDS` (300 s por defecto).
- La sentencia confirmada debe ser idéntica a la propuesta (hash) **y de la misma conexión**.
- `UPDATE`/`DELETE` sin `WHERE` exige `allow_full_table=true`.
- `DROP`/`TRUNCATE` se marcan como destructivos.
- Una sola sentencia por llamada, sin `;` interno.
- Los tokens viven en memoria: al reiniciar, hay que volver a proponer.

---

## Variables de entorno

| Variable | Defecto | Descripción |
|---|---|---|
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | Solo si defines `MYSQL_USER` (crea la conexión `env`) |
| `MYSQL_USER` | vacío | Si tiene valor, manda sobre el archivo |
| `MYSQL_PASSWORD` | vacío | Contraseña de `env` |
| `MYSQL_DATABASE` | vacío | Base por defecto de `env` |
| `MYSQL_SSL` | `false` | TLS |
| `MYSQL_PROMPT_ON_START` | `true` | Abre el formulario al arrancar si no hay conexiones |
| `MYSQL_MAX_ROWS` | `200` | Filas máximas por consulta |
| `MYSQL_WRITE_ENABLED` | `true` | Interruptor global de escritura |
| `MYSQL_CONFIRM_TTL_SECONDS` | `300` | Validez del token |
| `MYSQL_CONNECT_TIMEOUT_MS` | `10000` | Timeout de conexión |
| `MCP_MYSQL_STORE` | ruta por defecto | Archivo de conexiones alternativo |
| `MCP_MYSQL_NO_BROWSER` | — | `1` evita abrir el navegador (imprime la URL) |

---

## Registro en OpenCode

```jsonc
{
  "mcp": {
    "mysql": {
      "type": "local",
      "command": ["node", "C:/Users/steve/mcp-mysql/src/index.js"],
      "enabled": true,
      "timeout": 15000
    }
  },
  "permission": {
    "mysql_confirm_write": "ask",
    "mysql_reset_credentials": "ask"
  }
}
```

El permiso `ask` es la barrera visible en la interfaz; el token del servidor es la barrera real y
sigue funcionando aunque ejecutes con `--auto`.

---

## Estructura del proyecto

```
mcp-mysql/
├─ bin/mysql-mcp.js      CLI global
├─ src/index.js          servidor MCP (12 herramientas)
├─ src/store.js          almacén de conexiones
├─ src/webform.js        formulario local
├─ src/wizard.js         asistente de terminal
├─ src/form.js           formulario suelto
├─ src/doctor.js         diagnóstico
├─ test/                 handshake · store · webform
├─ USO.md                guía práctica
└─ README.md             este documento
```

### Qué no se versiona (`.gitignore`)

- `node_modules/`
- `.env` y `.env.*` (solo se versiona `.env.example`)
- `connections.json` y cualquier `credentials*.json`
- Scripts temporales (`dbg*.mjs`, `probe*.mjs`, `demo.mjs`…), que suelen acabar con contraseñas
  escritas a mano
- Volcados de base de datos, logs, builds y archivos de sistema/editor

La contraseña vive fuera del proyecto, así que el repositorio no la contiene; el `.gitignore` es
la red de seguridad por si alguien apunta `MCP_MYSQL_STORE` dentro de la carpeta.

---

## Pruebas

```bash
npm run test:all
```

- `test/handshake.mjs` — protocolo MCP, 12 herramientas, clasificación SQL, multi-conexión.
- `test/store.mjs` — perfiles, activa, migración de formatos antiguos, archivo corrupto, nombres.
- `test/webform.mjs` — token, validaciones, guardado y activación.
- `test/reload.mjs` — el MCP ve en caliente lo que cambia el CLI.

46 comprobaciones, sin necesidad de un MySQL vivo.

---

## Limitaciones conocidas

- **Sin cifrado en reposo** (ver arriba). Para un llavero del sistema habría que añadir una
  dependencia nativa; hoy no está.
- **La contraseña permanece en memoria** del proceso mientras la conexión está en uso. Es
  inevitable para conectar.
- **No hay OpenTUI dentro de OpenCode**: un MCP por stdio no puede dibujar en la TUI del cliente.
  OpenTUI solo sería viable en `mysql-mcp add` ejecutado con Bun, y no aporta nada que el
  asistente actual no haga.
- **Tokens de escritura en memoria**: reiniciar el servidor invalida cualquier propuesta pendiente.
