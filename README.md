# mcp-mysql

MySQL MCP server with **multiple named connections**, **cross-platform** (Windows, macOS, Linux),
free reads and writes that are always confirmed in two steps.

- No native dependencies, no PowerShell, no system dialogs.
- Passwords never go through the chat: local web form or terminal wizard.
- No write runs without a prior proposal and a single-use token.
- Before querying, the server requires you to confirm the session's database.

Spanish step-by-step guide: [`USO.md`](USO.md).

---

## Installation

```bash
cd mcp-mysql
npm install
npm link                 # installs the global `mysql-mcp` command
mysql-mcp add            # creates the first connection (opens the browser)
mysql-mcp doctor         # verifies it connects
```

If `mysql-mcp` is not found, open a new terminal or run
`C:\Users\steve\bin\mysql-mcp.cmd` (Windows).

### Standalone binaries (no Node required)

```bash
npm run build        # current platform only
npm run build:all    # Windows, Linux and macOS
```

| File | Platform | Size |
|---|---|---|
| `dist/mysql-mcp-windows-x64.exe` | Windows x64 | 84 MB |
| `dist/mysql-mcp-linux-x64` | Linux x64 | 80 MB |
| `dist/mysql-mcp-darwin-arm64` | macOS Apple Silicon | 61 MB |
| `dist/mysql-mcp-darwin-x64` | macOS Intel | 68 MB |

Each binary bundles the runtime, dependencies, CLI and MCP server. No `npm install` and no Node on
the target machine.

```powershell
.\dist\mysql-mcp-windows-x64.exe status
.\dist\mysql-mcp-windows-x64.exe doctor
```

To make OpenCode use the binary as its server:

```jsonc
"mysql": {
  "type": "local",
  "command": ["C:/Users/steve/mcp-mysql/dist/mysql-mcp-windows-x64.exe", "start"]
}
```

The binary looks for `.env` next to the executable and in the current directory. `dist/` is
git-ignored: binaries are attached to releases, not committed. They are unsigned, so Windows may
show a SmartScreen warning the first time.

---

## Two parts, one shared file

The project has two entry points that **never call each other**: they share the connections file.

```
                     ┌──────────────────────────────────┐
  you ──terminal──▶  │ mysql-mcp  (CLI)                 │
                     │ list · add · use · remove        │
                     └───────────────┬──────────────────┘
                                     │ reads / writes
                                     ▼
                   %APPDATA%\mcp-mysql\connections.json
                                     ▲
                                     │ reads and watches changes
                     ┌───────────────┴──────────────────┐
  OpenCode ──spawn─▶ │ node src/index.js  (MCP, stdio)  │──▶ MySQL
  (it starts it)     └──────────────────────────────────┘
```

| | CLI `mysql-mcp` | MCP server `src/index.js` |
|---|---|---|
| For whom | You, in a terminal | OpenCode |
| Who starts it | You, manually | OpenCode, at startup |
| Protocol | Commands and text output | JSON-RPC over stdin/stdout |
| Keeps running | No | Yes, while OpenCode runs |
| Needs PATH | Yes | No (absolute path) |

**You never start the MCP by hand.** OpenCode spawns it from
`~/.config/opencode/opencode.json`:

```jsonc
"mysql": {
  "type": "local",
  "command": ["node", "C:/Users/steve/mcp-mysql/src/index.js"]
}
```

If you run `mysql-mcp` with no subcommand in a terminal, it will sit waiting for JSON-RPC on
stdin. That is expected; close it with `Ctrl+C`.

### Live changes

The server **watches the file** (once per second). If you switch connections from the terminal:

```powershell
mysql-mcp use sales
```

the running MCP picks it up, reloads the connections and asks you to confirm again
(`Current DB: sales. Do you want to continue with this one?`). Only changing the **code** requires
restarting OpenCode.

---

## Language

All messages are available in **Spanish and English**. The language is taken from your system:

1. `MCP_MYSQL_LANG=es|en` (forces one)
2. `LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE`
3. The OS regional settings (`Intl`)
4. English

Translations live in [`src/locales/es.json`](src/locales/es.json) and
[`src/locales/en.json`](src/locales/en.json). To add a language, copy one file, translate the
values and register it in `src/i18n.js`.

---

## Commands

| Command | What it does |
|---|---|
| `mysql-mcp status` | Selected DB, server, database and TLS |
| `mysql-mcp list` | Every connection (`*` = active) |
| `mysql-mcp add [name]` | Create or edit a connection (browser) |
| `mysql-mcp add --tui` | Same, with the terminal wizard |
| `mysql-mcp form` | Open just the form |
| `mysql-mcp use [name]` | Activate a connection (no name: picker) |
| `mysql-mcp remove [name]` | Delete one (no name: picker) |
| `mysql-mcp remove --all` | Delete all |
| `mysql-mcp doctor [--all]` | Test the active connection or all of them |
| `mysql-mcp opencode` | Register the MCP in OpenCode (no JSON editing) |
| `mysql-mcp path` | Path of the connections file |
| `mysql-mcp` | Start the MCP server (used by OpenCode) |

---

## How credentials are captured

Two paths, neither puts passwords in the conversation:

**1. Local form.** `save_connection` / `mysql-mcp add` starts an HTTP server on `127.0.0.1` with a
random port and a single-use token, and opens the browser. It only accepts requests carrying that
token and shuts down on save or after 10 minutes.

**2. Terminal wizard.** `mysql-mcp add --tui` asks in your terminal, with the password masked, and
tests the connection before saving.

> A stdio MCP server **cannot draw in the client's TUI**: its stdin/stdout are the protocol
> channel. Any console read there would block the server. Hence the form or the wizard, never a
> `prompt` inside the MCP process.

---

## Where passwords are stored (no sugar-coating)

**They are stored in plain text** in a local JSON file. No encryption, no OS keychain, no DPAPI.
Same as `~/.aws/credentials` or `~/.npmrc`.

| System | File |
|---|---|
| Windows | `%APPDATA%\mcp-mysql\connections.json` |
| macOS / Linux | `$XDG_CONFIG_HOME/mcp-mysql/connections.json` → usually `~/.config/mcp-mysql/connections.json` |
| Custom | Whatever `MCP_MYSQL_STORE` points to |

Real file contents (example with fictitious data):

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

### What protection exists

- The file is created **user-only**: `0600` on macOS/Linux, a restrictive ACL (`icacls`) on Windows.
  Other users on the machine cannot read it.
- It lives outside the project, so it never lands in Git by accident.
- The password is never written to `opencode.json`, to command-line arguments or to logs. The server
  never prints credentials: only connection names and destinations.

### What protection does NOT exist

- **No encryption at rest.** Anyone who can read the file as your user can read the password.
- Any process running **as your user** can read it.
- It is included in backups, system snapshots, and, if `%APPDATA%` is synced (OneDrive, iCloud…),
  in the cloud.
- The form sends the password over HTTP on loopback (no TLS). It is local, but not encrypted in
  transit: another privileged local process could observe it.
- Environment variables have the same exposure: any child process can read them.

### How to reduce it

1. **A least-privilege MySQL user.** This is the protection that actually matters:

   ```sql
   CREATE USER 'mcp'@'localhost' IDENTIFIED BY 'long_password';
   GRANT SELECT, INSERT, UPDATE, DELETE ON your_db.* TO 'mcp'@'localhost';
   -- no GRANT ALL, no DROP, no access to mysql.*
   ```

2. **No password on disk:** set `MYSQL_USER` / `MYSQL_PASSWORD` in the environment and create no
   saved connections. The `env` connection takes precedence over the file.

3. **Delete what you don't use:** `mysql-mcp remove <name>` or `mysql-mcp remove --all`.

4. **Read-only while testing:** `MYSQL_WRITE_ENABLED=false`.

5. If the file leaks: change the MySQL user's password and recreate the connection with
   `mysql-mcp add`.

---

## Session confirmation

At startup the server assumes nothing: the first data operation is refused and returns the
connection that was left selected.

```
Current DB: steve_local → steve_local@127.0.0.1:3306/steve_demo
Do you want to continue with this one?
```

- If you accept: the agent calls `confirm_connection` and continues.
- If you prefer another: `use_connection` or `confirm_connection({conexion:"..."})`.
- It is asked once per process; restarting OpenCode asks again.
- `query_read`, `list_tables`, `describe_table` and `propose_write` are blocked until then.

---

## Tools

| Tool | Modifies data? |
|---|---|
| `connection_info` | No |
| `list_connections` | No |
| `list_tables`, `describe_table` | No |
| `query_read` (`SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN`, `READ ONLY` transaction) | No |
| `propose_write` (validates, estimates impact, returns a token) | **No** |
| `confirm_write` (runs only with a valid token) | Yes |
| `save_connection`, `use_connection`, `confirm_connection` | No (configuration) |
| `remove_connection`, `reset_credentials` | No (configuration only) |

Every data tool accepts `conexion` to target another connection without changing the active one.

---

## Two-step writes

```
propose_write(sql, conexion?)  ->  { token, impact, warnings }   nothing changed
        ↓ shown to the user, who confirms
confirm_write(sql, token, conexion?)  ->  { estado: "EXECUTED", affected: N }
```

- Single-use token, expires after `MYSQL_CONFIRM_TTL_SECONDS` (300 s by default).
- The confirmed statement must be identical to the proposal (hash) **and from the same connection**.
- `UPDATE`/`DELETE` without `WHERE` requires `allow_full_table=true`.
- `DROP`/`TRUNCATE` are flagged as destructive.
- One statement per call, no internal `;`.
- Tokens live in memory: after a restart you must propose again.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | Only if `MYSQL_USER` is set (creates the `env` connection) |
| `MYSQL_USER` | empty | If set, it wins over the file |
| `MYSQL_PASSWORD` | empty | Password for `env` |
| `MYSQL_DATABASE` | empty | Default database for `env` |
| `MYSQL_SSL` | `false` | TLS |
| `MYSQL_PROMPT_ON_START` | `true` | Opens the form at startup if there are no connections |
| `MYSQL_MAX_ROWS` | `200` | Maximum rows per query |
| `MYSQL_WRITE_ENABLED` | `true` | Global write switch |
| `MYSQL_CONFIRM_TTL_SECONDS` | `300` | Token lifetime |
| `MYSQL_CONNECT_TIMEOUT_MS` | `10000` | Connection timeout |
| `MCP_MYSQL_STORE` | default path | Alternative connections file |
| `MCP_MYSQL_LANG` | OS locale | Forces `es` or `en` |
| `MCP_MYSQL_NO_BROWSER` | — | `1` avoids opening the browser (prints the URL) |

---

## Registering in OpenCode

You normally don't edit JSON by hand:

```bash
mysql-mcp opencode            # global config (~/.config/opencode/opencode.json)
mysql-mcp opencode --project  # ./opencode.json of the current project
mysql-mcp opencode --dry-run  # show what it would change
```

It writes or replaces `mcp.mysql`, adds the `mysql_confirm_write` and
`mysql_reset_credentials` permissions as `ask`, keeps the rest of your configuration and leaves an
`opencode.json.bak-<date>` backup. It is idempotent: if it was already there, nothing changes.

Result:

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

You can also use OpenCode's native command, although it does not manage permissions:

```bash
opencode mcp add mysql --global -- node C:/Users/steve/mcp-mysql/src/index.js
opencode mcp list
```

The `ask` permission is the visible barrier in the UI; the server token is the real barrier and
still works when you run with `--auto`.

---

## Project layout

```
mcp-mysql/
├─ bin/mysql-mcp.js      global CLI
├─ src/index.js          MCP server (12 tools)
├─ src/store.js          connections store
├─ src/webform.js        local form
├─ src/wizard.js         terminal wizard
├─ src/form.js           standalone form
├─ src/doctor.js         diagnostics
├─ src/opencode.js       OpenCode registration
├─ src/i18n.js           language detection
├─ src/locales/          es.json · en.json
├─ test/                 handshake · store · webform · reload · opencode · binary
├─ USO.md                guide (Spanish)
└─ README.md             this document
```

### Not versioned (`.gitignore`)

- `node_modules/`
- `.env` and `.env.*` (only `.env.example` is versioned)
- `connections.json` and any `credentials*.json`
- Temporary scripts (`dbg*.mjs`, `probe*.mjs`, `demo.mjs`…), which often end up with hand-written
  passwords
- Database dumps, logs, builds and OS/editor files

The password lives outside the project, so the repository never contains it; the `.gitignore` is a
safety net in case someone points `MCP_MYSQL_STORE` inside the folder.

---

## Tests

```bash
npm run test:all
```

- `test/handshake.mjs` — MCP protocol, 12 tools, SQL classification, multi-connection.
- `test/store.mjs` — profiles, active connection, migration from old formats, corrupt file, names.
- `test/webform.mjs` — token, validation, saving and activation.
- `test/reload.mjs` — the MCP picks up CLI changes without restarting.
- `test/opencode.mjs` — registration is idempotent and preserves existing config.
- `test/binary.mjs` — the compiled binary runs the CLI and the MCP server.

60 checks, no live MySQL needed.

---

## Known limitations

- **No encryption at rest** (see above). A system keychain would need a native dependency; not
  included today.
- **The password stays in process memory** while the connection is in use. Unavoidable in order to
  connect.
- **No OpenTUI inside OpenCode**: a stdio MCP cannot draw in the client's TUI. OpenTUI would only be
  viable for `mysql-mcp add` under Bun, and adds nothing the current wizard does not do.
- **Write tokens live in memory**: restarting the server invalidates any pending proposal.
