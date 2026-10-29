# mcp-mysql

MySQL MCP server for OpenCode: **multiple named connections**, free reads, and writes that always
require confirmation. Cross-platform, no native dependencies.

## Install (binary, recommended)

Download the file for your platform from
[the latest release](https://github.com/steverova/mcp-mysql/releases/latest):

| Platform | File |
|---|---|
| Windows x64 | `mysql-mcp-windows-x64.exe` |
| Linux x64 | `mysql-mcp-linux-x64` |
| macOS Apple Silicon | `mysql-mcp-darwin-arm64` |
| macOS Intel | `mysql-mcp-darwin-x64` |

No Node, no `npm install`: the runtime and dependencies are inside the file.

### Windows

```powershell
New-Item -ItemType Directory -Force C:\Tools\mcp-mysql
Move-Item "$env:USERPROFILE\Downloads\mysql-mcp-windows-x64.exe" C:\Tools\mcp-mysql\mysql-mcp.exe
Unblock-File C:\Tools\mcp-mysql\mysql-mcp.exe          # clears the SmartScreen mark

$dir = "C:\Tools\mcp-mysql"
if (([Environment]::GetEnvironmentVariable("Path","User")) -split ';' -notcontains $dir) {
  [Environment]::SetEnvironmentVariable("Path", "$([Environment]::GetEnvironmentVariable('Path','User'));$dir", "User")
}
```

Open a new terminal afterwards.

### macOS / Linux

```bash
mkdir -p ~/.local/bin
mv ~/Downloads/mysql-mcp-darwin-arm64 ~/.local/bin/mysql-mcp
chmod +x ~/.local/bin/mysql-mcp
xattr -d com.apple.quarantine ~/.local/bin/mysql-mcp   # macOS only
export PATH="$HOME/.local/bin:$PATH"                    # add to ~/.zshrc or ~/.bashrc
```

### Then, once

```bash
mysql-mcp add          # create the first connection (opens the browser)
mysql-mcp doctor       # verify it connects
mysql-mcp opencode     # register the MCP in OpenCode
```

Restart OpenCode. The first time it touches data it asks:

```
Current DB: local → local@127.0.0.1:3306/demo
Do you want to continue with this one?
```

Answer yes and it calls `confirm_connection`. Nothing runs before you confirm.

> If you skip the PATH step, use the full path (`C:\Tools\mcp-mysql\mysql-mcp.exe status`). OpenCode
> never needs the PATH: `mysql-mcp opencode` writes the absolute path into its config.

---

## Commands

| Command | What it does |
|---|---|
| `mysql-mcp status` | Selected database, server, TLS |
| `mysql-mcp list` | All connections (`*` = active) |
| `mysql-mcp add [name]` | Create or edit a connection (browser) |
| `mysql-mcp use [name]` | Activate one (no name: picker) |
| `mysql-mcp remove [name]` | Delete one (no name: picker) |
| `mysql-mcp doctor [--all]` | Test connections |
| `mysql-mcp opencode` | Register in OpenCode; `--project` for one project, `--dry-run` to preview |
| `mysql-mcp path` | Where connections are stored |

`add --tui` uses a terminal wizard instead of the browser. `remove --all` deletes everything.

## In OpenCode

| You say | It calls |
|---|---|
| "which connections do I have?" | `list_connections` |
| "which database are you on?" | `connection_info` |
| "yes, continue" | `confirm_connection` |
| "connect to sales" | `use_connection` |
| "show me the tables" | `list_tables` |
| "how many customers are there?" | `query_read` |

Any data tool accepts `conexion` to target another connection without switching:

> "query sales without changing the active connection"

### One selection per window

Each OpenCode window keeps its own active connection. `mysql-mcp use` only changes the **default for
new windows**; a window that already confirmed keeps working with its own. Restart a window to pick
up a new default.

## Tools

| Tool | Writes? |
|---|---|
| `connection_info`, `list_connections`, `list_tables`, `describe_table` | No |
| `query_read` (`SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN`, `READ ONLY`) | No |
| `propose_write` (validates, estimates impact, returns a token) | **No** |
| `confirm_write` (runs only with a valid token) | Yes |
| `save_connection`, `use_connection`, `confirm_connection`, `remove_connection`, `reset_credentials` | No (config) |

### Writes take two steps

```
propose_write(sql)  ->  { token, impact, warnings }   nothing changed
        ↓ you confirm
confirm_write(sql, token)  ->  { status: "EXECUTED", affected: N }
```

The token is single-use, expires after 300 s, is bound to the statement and the connection, and
`UPDATE`/`DELETE` without `WHERE` needs `allow_full_table=true`.

---

## Where credentials live

`%APPDATA%\mcp-mysql\connections.json` on Windows, `~/.config/mcp-mysql/connections.json`
elsewhere. It is created with **user-only permissions** (`0600`, ACL on Windows).

**The password is stored in plain text.** No encryption. Same as `~/.aws/credentials`. Anyone
running as your user can read it, and it lands in backups. Mitigate it with a least-privilege MySQL
user (`SELECT, INSERT, UPDATE, DELETE` on your schema only), or skip the file entirely with
`MYSQL_USER` / `MYSQL_PASSWORD` environment variables.

`MYSQL_WRITE_ENABLED=false` makes everything read-only.

## Language

Messages exist in Spanish and English, chosen from your OS regional settings. Force one with
`MCP_MYSQL_LANG=es` or `MCP_MYSQL_LANG=en`. Texts live in `src/locales/{es,en}.json`.

---

## From source (alternative)

Only needed if you want to modify the code:

```bash
npm install
npm link          # same `mysql-mcp` command, running on Node
npm run test:all  # 60 checks, no live MySQL needed
npm run build     # rebuild the binary for your platform
```

## More

- [`USAGE.md`](USAGE.md) — step-by-step guide (Spanish, more detail)
- `mysql-mcp opencode --dry-run` — see exactly what would change in your OpenCode config
