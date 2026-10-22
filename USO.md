# Guía de uso — mysql-mcp

Servidor MCP para MySQL con varias conexiones, lectura libre y escritura confirmada.
Esta guía es práctica: qué escribir y qué esperar en cada momento.

> Referencia técnica completa (arquitectura, variables, seguridad): [`README.md`](README.md).

---

## 1. Flujo completo

### Fase 0 · Instalar el CLI (una sola vez por máquina)

```powershell
cd C:\Users\steve\mcp-mysql
npm install
npm link
mysql-mcp version        # 2.1.0  → el comando global funciona
```

Y registrar el servidor en OpenCode (esto **ya está hecho** en este equipo). En
`C:\Users\steve\.config\opencode\opencode.json`:

```jsonc
"mcp": {
  "mysql": {
    "type": "local",
    "command": ["node", "C:/Users/steve/mcp-mysql/src/index.js"],
    "enabled": true,
    "timeout": 15000
  }
}
```

Aquí hay dos cosas distintas que se confunden fácil:

| | Qué es | Cómo se hace |
|---|---|---|
| **Añadir el MCP a OpenCode** | Decirle a OpenCode que existe este servidor | Editar `opencode.json` (una vez) |
| **Añadir una conexión** | Registrar una base de datos concreta | `mysql-mcp add <nombre>` (cada base) |

`mysql-mcp add mcp` no hace nada especial: `mcp` sería **el nombre que tú eliges** para esa
conexión. Nombres útiles: `local`, `ventas`, `produccion`, `steve_local`.

### Fase 1 · Crear la conexión a la base

```powershell
mysql-mcp add               # abre el navegador con el formulario
mysql-mcp add ventas        # igual, con el nombre "ventas" ya puesto
mysql-mcp add --tui         # sin navegador, en la propia terminal
```

Rellenas: **nombre**, host, puerto, usuario, contraseña, base (opcional) y TLS. Al guardar:

```powershell
mysql-mcp status            # ¿cuál está seleccionada?
mysql-mcp doctor            # ¿conecta de verdad?
```

```
BD actual:
  conexión : steve_local
  servidor : steve_local@127.0.0.1:3306
  base     : steve_demo
```

Si `doctor` dice `OK`, la conexión sirve. Fin de la fase.

### Fase 2 · Usarla desde OpenCode

1. Reinicia OpenCode (la primera vez, para cargar el servidor).
2. Pídele algo: «¿en qué base estás?» o «muéstrame las tablas».
3. Responderá con la puerta de sesión:

   ```
   BD actual: steve_local → steve_local@127.0.0.1:3306/steve_demo
   ¿Deseas seguir con esta?
   ```

4. Di «sí» → confirma y ya puedes consultar.

Ese mensaje **no es un error**: es el freno que impide que el agente empiece a tocar datos en una
base que no has confirmado.

### Fase 3 · Día a día

```powershell
mysql-mcp status            # dónde estoy
mysql-mcp use ventas        # cambiar de base (el MCP lo nota en ~1 s)
mysql-mcp add produccion    # añadir otra
mysql-mcp remove vieja      # borrar una
mysql-mcp doctor --all      # comprobar todas
```

### Resumen en una línea

```
npm install → npm link → mysql-mcp add → mysql-mcp doctor → (reiniciar OpenCode) → "sí, sigue"
```

Estado actual de este equipo:

| | |
|---|---|
| CLI | `mysql-mcp` 2.1.0, en el PATH |
| MCP | registrado en `opencode.json` |
| Conexión | `steve_local` |
| Servidor | MySQL 8.0.46 en `127.0.0.1:3306` |
| Base | `steve_demo` (tabla `clientes`, 2 filas) |
| Archivo | `C:\Users\steve\AppData\Roaming\mcp-mysql\connections.json` |
| Pendiente | reiniciar OpenCode para cargar el servidor nuevo |

---

## 2. Comandos del CLI

Todos funcionan desde cualquier carpeta.

| Comando | Qué hace |
|---|---|
| `mysql-mcp status` | Muestra la BD seleccionada, servidor, base y TLS |
| `mysql-mcp list` | Lista todas las conexiones (`*` = activa) |
| `mysql-mcp add [nombre]` | Crea o edita una conexión en el navegador |
| `mysql-mcp add --tui` | Igual, pero con el asistente de terminal |
| `mysql-mcp form` | Abre solo el formulario |
| `mysql-mcp use [nombre]` | Activa una conexión (sin nombre: selector numerado) |
| `mysql-mcp remove [nombre]` | Borra una (sin nombre: selector) |
| `mysql-mcp remove --all` | Borra todas |
| `mysql-mcp doctor` | Prueba la conexión activa |
| `mysql-mcp doctor --all` | Prueba todas |
| `mysql-mcp doctor --name ventas` | Prueba una concreta |
| `mysql-mcp path` | Ruta del archivo de conexiones |
| `mysql-mcp help` | Ayuda |

### Ejemplo: selector interactivo

```powershell
PS> mysql-mcp use

Conexiones:
  *  1. steve_local        steve_local@127.0.0.1:3306/steve_demo
     2. produccion        mcp@db.empresa.com:3306/(sin base)
Número o nombre a activar: 2

BD actual: produccion
  mcp@db.empresa.com:3306/(sin base)
```

### Ejemplo: salida de `status`

```
BD actual:
  conexión : steve_local
  servidor : steve_local@127.0.0.1:3306
  base     : steve_demo
  TLS      : no
  archivo  : C:\Users\steve\AppData\Roaming\mcp-mysql\connections.json
```

---

## 3. Dentro de OpenCode

### Quién arranca qué

Dos piezas que **no se llaman entre sí**; comparten el archivo de conexiones:

| | CLI `mysql-mcp` | Servidor MCP |
|---|---|---|
| Quién lo arranca | Tú, en la terminal | OpenCode, al iniciarse |
| Termina solo | Sí | No: vive mientras OpenCode viva |
| Necesita PATH | Sí | No (OpenCode usa ruta absoluta) |

No arranques el MCP a mano: si ejecutas `mysql-mcp` sin subcomando, se queda esperando JSON-RPC
por stdin y parece colgado. Es correcto; `Ctrl+C` para salir.

El servidor **vigila el archivo**: si haces `mysql-mcp use ventas` mientras OpenCode está abierto,
lo detecta en ~1 segundo y te pedirá confirmar la nueva base. Solo cambiar el **código** obliga a
reiniciar OpenCode.

### La puerta de sesión

Al arrancar, el servidor **no sabe si quieres seguir con la conexión que quedó activa**. Por eso
la primera operación sobre datos se niega y devuelve este mensaje:

```
ERROR: BD actual: steve_local → steve_local@127.0.0.1:3306/steve_demo

Todavía no se ha confirmado en esta sesión. Muestra este mensaje al usuario y pregúntale:
  «BD actual: steve_local. ¿Deseas seguir con esta?»

Si dice que sí: llama a confirm_connection.
Si prefiere otra: use_connection({nombre:"..."}) o confirm_connection({conexion:"..."}).
```

**No es un error del sistema**, es el freno de mano. Tú respondes:

- «sí» → el agente llama a `confirm_connection` y sigue.
- «usa produccion» → cambia y confirma.

Solo se pide una vez por proceso: si reinicias OpenCode, vuelve a preguntar.

### Frases que funcionan

| Tú dices | El agente hace |
|---|---|
| «¿qué conexiones tengo?» | `list_connections` |
| «¿en qué base estás?» | `connection_info` |
| «sí, sigue» / «adelante» | `confirm_connection` |
| «conéctate a produccion» | `use_connection` |
| «usa steve_local pero en la base pedidos» | `use_connection` con `database` |
| «añade una conexión nueva» | `save_connection` → navegador |
| «borra la conexión vieja» | `remove_connection` (pide confirmación) |
| «muéstrame las tablas» | `list_tables` |
| «describe clientes» | `describe_table` |
| «cuántos clientes hay» | `query_read` |

### Consultar otra base sin cambiar la activa

Todas las herramientas aceptan `conexion`:

```
«consulta en produccion cuántos pedidos hay, sin cambiar la conexión»
→ query_read(sql: "...", conexion: "produccion")
```

---

## 4. Consultar (lectura)

Permitido: `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`. Se ejecutan en una transacción `READ ONLY`
y con límite de filas (`MYSQL_MAX_ROWS`, 200 por defecto).

```sql
SELECT id, nombre, email FROM clientes
SHOW TABLES
DESCRIBE clientes
EXPLAIN SELECT * FROM clientes WHERE email = 'ana@ejemplo.com'
```

Se rechazan intentos de escribir por esta vía:

```
query_read("DELETE FROM clientes")        → usa propose_write
query_read("SELECT 1; DROP TABLE x")      → una sola sentencia
query_read("SELECT * INTO OUTFILE '...'") → intento de escritura
```

---

## 5. Escribir (dos pasos, siempre)

Nunca se ejecuta una escritura de golpe. El agente primero **propone** y te enseña el impacto:

```
Tú: «sube el email de Ana»
Agente: propone  UPDATE clientes SET email='ana.nueva@ejemplo.com' WHERE id=1
         impacto ~1 fila · sin avisos
Tú: «adelante»
Agente: confirm_write → EJECUTADO, afectadas: 1
```

Lo que garantiza el servidor:

- `propose_write` **no modifica nada**: solo valida y devuelve un token.
- El token caduca a los 300 s y es de **un solo uso**.
- La sentencia y la conexión deben coincidir exactamente con lo propuesto.
- `UPDATE`/`DELETE` sin `WHERE` exige autorización explícita (`allow_full_table`).
- `DROP` y `TRUNCATE` se marcan como destructivos.

Ejemplos de lo que ya se hizo en este equipo:

```sql
CREATE DATABASE steve_demo CHARACTER SET utf8mb4
CREATE TABLE clientes (id INT AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(100) NOT NULL, ...)
INSERT INTO clientes (nombre, email) VALUES ('Ana Torres','ana@ejemplo.com')
```

---

## 6. Varias conexiones

Cada conexión tiene nombre y una queda activa. La activa se guarda en el archivo, así que
sobrevive a reinicios.

```powershell
mysql-mcp add ventas        # nueva conexión llamada "ventas"
mysql-mcp list              # ver todas
mysql-mcp use ventas        # cambiar la seleccionada
mysql-mcp remove vieja      # borrar una
mysql-mcp remove --all      # borrar todas
```

Si editas una que ya existe usando el mismo nombre, se sobrescribe:

```powershell
mysql-mcp add steve_local   # cambia host, usuario, contraseña o base de esa conexión
```

---

## 7. Dónde se guarda y qué tan seguro es

| Sistema | Ruta |
|---|---|
| Windows | `%APPDATA%\mcp-mysql\connections.json` |
| macOS/Linux | `~/.config/mcp-mysql/connections.json` |

- El archivo se crea con permisos de solo-usuario (`0600`, ACL en Windows).
- **La contraseña está en claro** dentro del archivo, igual que `~/.aws/credentials`. No es
  cifrado: es un secreto local protegido por permisos del sistema.
- No lo subas a un repositorio. Está fuera del proyecto, y el `.gitignore` bloquea
  `connections.json` y `.env` por si alguien cambia la ruta con `MCP_MYSQL_STORE`.
- Detalle completo de riesgos y mitigaciones: sección «Dónde se guardan las contraseñas» de
  [`README.md`](README.md).
- Para evitarlo del todo, usa variables de entorno (`MYSQL_USER` / `MYSQL_PASSWORD`) en lugar
  del archivo, o crea un usuario MySQL de solo lectura.

Permisos recomendados en MySQL:

```sql
CREATE USER 'mcp'@'%' IDENTIFIED BY 'contraseña_larga';
GRANT SELECT, INSERT, UPDATE, DELETE ON tu_base.* TO 'mcp'@'%';
```

---

## 8. Configuración (`.env`)

Archivo: `C:\Users\steve\mcp-mysql\.env`

| Variable | Defecto | Para qué |
|---|---|---|
| `MYSQL_USER` / `MYSQL_PASSWORD` | vacío | Si tienen valor, crean la conexión `env` y mandan sobre el archivo |
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | Servidor de la conexión `env` |
| `MYSQL_PROMPT_ON_START` | `true` | Abre el formulario al arrancar si no hay conexiones |
| `MYSQL_MAX_ROWS` | `200` | Filas máximas por consulta |
| `MYSQL_WRITE_ENABLED` | `true` | `false` = solo lectura, aunque haya token |
| `MYSQL_CONFIRM_TTL_SECONDS` | `300` | Validez del token de escritura |
| `MYSQL_CONNECT_TIMEOUT_MS` | `10000` | Timeout de conexión |
| `MCP_MYSQL_STORE` | ruta por defecto | Archivo de conexiones alternativo |

---

## 9. Problemas frecuentes

**`mysql-mcp` no se reconoce**
Abre una terminal nueva (el PATH se actualizó después). Ruta directa:
`C:\Users\steve\bin\mysql-mcp.cmd`

**El navegador no se abre al hacer `add`**
La URL se imprime en la consola; cópiala. En servidores sin escritorio:
`mysql-mcp add --tui`

**`ECONNREFUSED`**
No hay MySQL escuchando en esa IP/puerto. Comprueba el servicio o usa `mysql-mcp doctor`.
Ojo: el servicio `MySQL96` (9.6) está parado; aquí responde MySQL 8.0.46 en 3306.

**`ER_ACCESS_DENIED_ERROR`**
Usuario o contraseña incorrectos: `mysql-mcp add steve_local` para reescribirlos.

**«BD actual: … ¿Deseas seguir con esta?»**
Es la puerta de sesión, no un fallo. Responde que sí (o pide otra conexión).

**Token inválido o caducado**
Pasaron más de 5 minutos o se usó ya. Pide la operación otra vez para generar uno nuevo.

**«El archivo de conexiones está corrupto»**
`mysql-mcp remove --all` y vuelve a crearlas.

**Las herramientas nuevas no aparecen en OpenCode**
Reinicia OpenCode: el servidor MCP se carga al arrancar.

---

## 10. Referencia rápida

```powershell
# Día a día
mysql-mcp status
mysql-mcp add
mysql-mcp use
mysql-mcp doctor

# Dentro de OpenCode
"¿qué conexiones hay?"        → list_connections
"¿en qué base estás?"         → connection_info
"sí, sigue"                   → confirm_connection
"conéctate a ventas"          → use_connection
"crea la tabla pedidos"       → propose_write + confirm_write
```

| Herramienta MCP | ¿Modifica datos? |
|---|---|
| `connection_info`, `list_connections`, `list_tables`, `describe_table` | No |
| `query_read` | No (transacción READ ONLY) |
| `propose_write` | **No** (devuelve token) |
| `confirm_write` | Sí (solo con token válido) |
| `save_connection`, `use_connection`, `confirm_connection`, `remove_connection`, `reset_credentials` | No (configuración) |
