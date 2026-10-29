# Usage guide — mcp-mysql

Practical walkthrough: what to run and what you should see.

> Full reference: [`README.md`](README.md).

---

## 1. Full flow

### Phase 0 · Install (once per machine)

Download the binary for your platform from
[the latest release](https://github.com/steverova/mcp-mysql/releases/latest):

| Platform | File |
|---|---|
| Windows x64 | `mysql-mcp-windows-x64.exe` |
| Linux x64 | `mysql-mcp-linux-x64` |
| macOS Apple Silicon | `mysql-mcp-darwin-arm64` |
| macOS Intel | `mysql-mcp-darwin-x64` |

No Node and no `npm install`: the runtime and dependencies are inside the file.

```powershell
# Windows
New-Item -ItemType Directory -Force C:\Tools\mcp-mysql
Move-Item "$env:USERPROFILE\Downloads\mysql-mcp-windows-x64.exe" C:\Tools\mcp-mysql\mysql-mcp.exe
Unblock-File C:\Tools\mcp-mysql\mysql-mcp.exe

$dir = "C:\Tools\mcp-mysql"
if (([Environment]::GetEnvironmentVariable("Path","User")) -split ';' -notcontains $dir) {
  [Environment]::SetEnvironmentVariable("Path", "$([Environment]::GetEnvironmentVariable('Path','User'));$dir", "User")
}
```

```bash
# macOS / Linux
mkdir -p ~/.local/bin
mv ~/Downloads/mysql-mcp-darwin-arm64 ~/.local/bin/mysql-mcp
chmod +x ~/.local/bin/mysql-mcp
xattr -d com.apple.quarantine ~/.local/bin/mysql-mcp   # macOS only
export PATH="$HOME/.local/bin:$PATH"                    # add to ~/.zshrc or ~/.bashrc
```

Open a new terminal and check:

```powershell
mysql-mcp version
```

Then register the server in OpenCode. No JSON editing needed:

```powershell
mysql-mcp opencode            # OpenCode global config
mysql-mcp opencode --project  # only for the current project
mysql-mcp opencode --dry-run  # show what it would change
```

It writes `mcp.mysql`, sets the write permissions to `ask`, keeps the rest of your configuration
and leaves an `opencode.json.bak-<date>` backup. If it was already there, nothing changes.

> **Development alternative:** `npm install && npm link` installs the same command running on Node
> instead of the binary.

Two different things that are easy to confuse:

| | What it is | How |
|---|---|---|
| **Add the MCP to OpenCode** | Tell OpenCode the server exists | `mysql-mcp opencode` (once) |
| **Add a connection** | Register a specific database | `mysql-mcp add <name>` (each database) |

`mysql-mcp add mcp` does nothing special: `mcp` would be **the name you choose** for that connection.
Useful names: `local`, `sales`, `production`.

### Phase 1 · Create the connection

```powershell
mysql-mcp add               # opens the browser form
mysql-mcp add sales         # same, with the name "sales" prefilled
mysql-mcp add --tui         # no browser, terminal wizard
```

Fill in **name**, host, port, user, password, database (optional) and TLS. Then:

```powershell
mysql-mcp status            # which one is selected?
mysql-mcp doctor            # does it actually connect?
```

```
Current DB:
  connection : local
  server     : mcp@127.0.0.1:3306
  database   : demo
```

If `doctor` says `OK`, the connection works.

### Phase 2 · Use it from OpenCode

1. Restart OpenCode (first time only, to load the server).
2. Ask something: "which database are you on?" or "show me the tables".
3. It answers with the session gate:

   ```
   Current DB: local → mcp@127.0.0.1:3306/demo
   Do you want to continue with this one?
   ```

4. Say yes → it confirms and you can query.

That message **is not an error**: it is the gate that prevents the agent from touching data in a
database you have not confirmed.

### Phase 3 · Day to day

```powershell
mysql-mcp status            # where am I
mysql-mcp use sales         # switch (the MCP notices in ~1 s)
mysql-mcp add production    # add another
mysql-mcp remove old        # delete one
mysql-mcp doctor --all      # test them all
```

### One line

```
download → place → (PATH) → mysql-mcp add → mysql-mcp doctor → mysql-mcp opencode → restart → "yes, continue"
```

---

## 2. CLI commands

| Command | What it does |
|---|---|
| `mysql-mcp status` | Selected database, server, database and TLS |
| `mysql-mcp list` | Every connection (`*` = active) |
| `mysql-mcp add [name]` | Create or edit a connection (browser) |
| `mysql-mcp add --tui` | Same, with the terminal wizard |
| `mysql-mcp form` | Open just the form |
| `mysql-mcp use [name]` | Activate a connection (no name: picker) |
| `mysql-mcp remove [name]` | Delete one (no name: picker) |
| `mysql-mcp remove --all` | Delete all |
| `mysql-mcp doctor` | Test the active connection |
| `mysql-mcp doctor --all` | Test all of them |
| `mysql-mcp doctor --name sales` | Test a specific one |
| `mysql-mcp opencode` | Register the MCP in OpenCode |
| `mysql-mcp path` | Path of the connections file |
| `mysql-mcp help` | Help |

### Picker example

```powershell
PS> mysql-mcp use

Connections:
  *  1. local            mcp@127.0.0.1:3306/demo
     2. production       mcp@db.company.com:3306/(no database)
Number or name to activate: 2

Current DB: production
  mcp@db.company.com:3306/(no database)
```

---

## 3. Inside OpenCode

Each window keeps its **own** active connection. `mysql-mcp use` only changes the default for new
windows; a window that already confirmed keeps its own.

### Session gate

At startup the server assumes nothing: the first data operation is refused and returns the
connection that was left selected. You answer:

- "yes" → the agent calls `confirm_connection` and continues.
- "use production" → it switches and confirms.

It is asked once per process; restarting OpenCode asks again.

### Phrases that work

| You say | It calls |
|---|---|
| "which connections do I have?" | `list_connections` |
| "which database are you on?" | `connection_info` |
| "yes, continue" | `confirm_connection` |
| "connect to production" | `use_connection` |
| "use local but the orders database" | `use_connection` with `database` |
| "add a new connection" | `save_connection` → browser |
| "delete the old connection" | `remove_connection` (asks for confirmation) |
| "show me the tables" | `list_tables` |
| "describe customers" | `describe_table` |
| "how many customers are there?" | `query_read` |

### Query another database without switching

Every data tool accepts `connection`:

```
"query production for the order count, without changing the connection"
→ query_read(sql: "...", connection: "production")
```

---

## 4. Reading

Allowed: `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`. They run in a `READ ONLY` transaction with a row
limit (`MYSQL_MAX_ROWS`, 200 by default).

```sql
SELECT id, name, email FROM customers
SHOW TABLES
DESCRIBE customers
EXPLAIN SELECT * FROM customers WHERE email = 'ana@example.com'
```

Rejected:

```
query_read("DELETE FROM customers")        → use propose_write
query_read("SELECT 1; DROP TABLE x")       → one statement only
query_read("SELECT * INTO OUTFILE '...'")  → write attempt
```

---

## 5. Writing (always two steps)

A write never runs directly. The agent first **proposes** and shows the impact:

```
You:  "update Ana's email"
Agent: proposes  UPDATE customers SET email='ana.new@example.com' WHERE id=1
                 impact ~1 row · no warnings
You:  "go ahead"
Agent: confirm_write → EXECUTED, affected: 1
```

What the server guarantees:

- `propose_write` **changes nothing**: it validates and returns a token.
- The token expires after 300 s and is **single-use**.
- The statement and the connection must match the proposal exactly.
- `UPDATE`/`DELETE` without `WHERE` requires explicit authorization (`allow_full_table`).
- `DROP` and `TRUNCATE` are flagged as destructive.

---

## 6. Multiple connections

Each connection has a name and one is active. Switching from the CLI only changes the default for
new windows.

```powershell
mysql-mcp add sales        # new connection called "sales"
mysql-mcp list             # see them all
mysql-mcp use sales        # change the selected one
mysql-mcp remove old       # delete one
mysql-mcp remove --all     # delete all
```

Editing an existing name overwrites it:

```powershell
mysql-mcp add local        # change host, user, password or database of "local"
```

---

## 7. Where credentials are stored

| System | File |
|---|---|
| Windows | `%APPDATA%\mcp-mysql\connections.json` |
| macOS/Linux | `~/.config/mcp-mysql/connections.json` |

- The file is created with **user-only permissions** (`0600`, ACL on Windows).
- **The password is stored in plain text**, like `~/.aws/credentials`. It is not encrypted: it is a
  local secret protected by file permissions.
- Never commit it. It lives outside the project; `.gitignore` is a safety net in case someone
  points `MCP_MYSQL_STORE` inside the folder.
- To avoid it entirely, use `MYSQL_USER` / `MYSQL_PASSWORD` environment variables, or a read-only
  MySQL user.

Recommended MySQL permissions:

```sql
CREATE USER 'mcp'@'%' IDENTIFIED BY 'long_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON your_db.* TO 'mcp'@'%';
```

---

## 8. Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `MYSQL_USER` / `MYSQL_PASSWORD` | empty | If set, they create the `env` connection and win over the file |
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | Server for the `env` connection |
| `MYSQL_PROMPT_ON_START` | `true` | Opens the form at startup if there are no connections |
| `MYSQL_MAX_ROWS` | `200` | Maximum rows per query |
| `MYSQL_WRITE_ENABLED` | `true` | `false` = read-only even with a valid token |
| `MYSQL_CONFIRM_TTL_SECONDS` | `300` | Write token lifetime |
| `MYSQL_CONNECT_TIMEOUT_MS` | `10000` | Connection timeout |
| `MCP_MYSQL_STORE` | default path | Alternative connections file |
| `MCP_MYSQL_LANG` | OS locale | Forces `es` or `en` |

---

## 9. Troubleshooting

**`mysql-mcp` is not recognized**
Open a new terminal (the PATH was updated after). Direct path:
`C:\Users\steve\bin\mysql-mcp.cmd` or `C:\Tools\mcp-mysql\mysql-mcp.exe`.

**The browser does not open on `add`**
The URL is printed in the console; copy it. On headless machines: `mysql-mcp add --tui`.

**`ECONNREFUSED`**
Nothing is listening on that IP/port. Check the service or run `mysql-mcp doctor`.

**`ER_ACCESS_DENIED_ERROR`**
Wrong user or password: `mysql-mcp add <name>` to rewrite them.

**"Current DB: … Do you want to continue with this one?"**
That is the session gate, not a failure. Answer yes, or ask for another connection.

**Invalid or expired token**
More than 5 minutes passed or it was already used. Ask for the operation again.

**"The connections file is corrupt"**
`mysql-mcp remove --all` and create them again.

**The new tools do not show up in OpenCode**
Restart OpenCode: the MCP server is loaded at startup.

---

## 10. Quick reference

```powershell
# Day to day
mysql-mcp status
mysql-mcp add
mysql-mcp use
mysql-mcp doctor

# Inside OpenCode
"which connections are there?"  → list_connections
"which database are you on?"    → connection_info
"yes, continue"                 → confirm_connection
"connect to sales"              → use_connection
"create the orders table"       → propose_write + confirm_write
```

| MCP tool | Modifies data? |
|---|---|
| `connection_info`, `list_connections`, `list_tables`, `describe_table` | No |
| `query_read` | No (`READ ONLY` transaction) |
| `propose_write` | **No** (returns a token) |
| `confirm_write` | Yes (only with a valid token) |
| `save_connection`, `use_connection`, `confirm_connection`, `remove_connection`, `reset_credentials` | No (configuration) |
