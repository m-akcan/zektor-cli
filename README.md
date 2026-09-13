# zektor

Command-line client for [Zektor.io](https://zektor.io) managed databases and caches.

[![npm](https://img.shields.io/npm/v/zektor)](https://www.npmjs.com/package/zektor)

> **Status: 0.1.0, and waiting on the API.** Every command below is built and
> tested, but the token endpoints it authenticates against are not deployed to
> production yet — so `zektor login` cannot succeed until they are, and
> **Settings → Access tokens** does not exist in the dashboard to mint one from.
> Installing now is fine; using it is not yet possible.

## Install

```bash
npm install -g zektor
```

Or run it without installing:

```bash
npx zektor whoami
```

Requires Node 18 or newer.

## Authenticating

Create a token in the dashboard under **Settings → Access tokens**, then:

```bash
zektor login
```

The token is stored at `~/.config/zektor/config.json` with mode `0600`. It is
verified against the API before being written, so a mistyped token fails here
rather than confusingly on your next command.

`--token` exists for scripts, but prefer the prompt when you are at a keyboard —
an argument lands in your shell history.

### In CI

Set `ZEKTOR_TOKEN` and skip `login` entirely:

```bash
ZEKTOR_TOKEN=zk_… zektor whoami
```

`ZEKTOR_TOKEN` always beats the config file. `zektor whoami` reports which of
the two supplied the credential, which is usually how you discover a stray
environment variable is overriding the account you logged in as.

## Commands

| Command | What it does |
|---|---|
| `zektor login` | Store a token for this machine |
| `zektor logout` | Forget the stored token. Does **not** revoke it — the same token may be in use elsewhere. Revoke in Settings to end its access. |
| `zektor whoami` | Show the account, API URL, and where the token came from |
| `zektor list` | List your instances |
| `zektor show <id>` | Show one instance |
| `zektor db create` / `zektor cache create` | Provision a database or cache |
| `zektor delete <id>` | Delete an instance. Asks you to type its name; `--yes` skips that. |
| `zektor connect <id>` | Open `redis-cli` against a cache |
| `zektor scale <id> --tier=…` | Move an instance to another plan |
| `zektor storage show\|resize\|autoscale <id>` | Postgres storage (see below) |
| `zektor mcp` | Run as an MCP server, so an editor or agent can drive the API (see below) |

Every read command takes `--json`.

### Creating

```bash
zektor db create --name=my-db --tier=AKPG-5 --region=nbg1 --engine=postgres@17
```

`--tier`, `--region` and `--engine` take the names you see in the dashboard and
are resolved to ids for you. Pass a wrong one and the error lists what is valid.

`--storage` appears in the dashboard's "equivalent CLI" panel but is rejected
here: the wizard's own create call does not send it, and storage comes from the
plan. Choose it with `--tier`.

### Connecting

`connect` opens `redis-cli` for a cache. For Postgres it prints the command
shape instead — the password is shown once when a role is created or rotated and
the server never stores it, so there is no credential for the CLI to fetch.
Create or rotate a role in the dashboard first.

### Scaling and storage

```bash
zektor scale 42 --tier=AKPG-10
zektor storage show 42
zektor storage resize 42 --size=50
zektor storage autoscale 42 --on --limit=100
```

`scale` asks you to type the instance name, since it restarts the instance;
`--yes` skips that. A downgrade warns that the smaller plan may be below what
the instance is currently using.

Storage is **PostgreSQL only** — a cache is sized by its plan, so use `scale`.
Volumes only grow, and the first one must be at least 10 GB.

Two API limitations worth knowing:

- `--min` needs a recent API. Older versions accept the value but never return
  it, and `storage show` says `not reported (older API)` rather than pretending
  no minimum is set.
- A ceiling or floor cannot be cleared once set — the API reads an omitted
  value as "leave unchanged". Set a new number instead.

## MCP server

`zektor mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over stdio, so an editor or agent can list, create and scale instances directly.
It uses the token you already logged in with — there is nothing extra to set up.

Add it to your MCP client's config:

```json
{
  "mcpServers": {
    "zektor": { "command": "npx", "args": ["-y", "zektor", "mcp"] }
  }
}
```

For Claude Code, `claude mcp add zektor -- npx -y zektor mcp` does the same thing.

### Tools

| Tool | |
|---|---|
| `whoami`, `list_instances`, `get_instance` | read-only |
| `list_plans`, `list_regions` | read-only; call these before creating rather than guessing a name |
| `get_connection` | read-only, **returns a live password** for caches |
| `get_storage` | read-only, PostgreSQL |
| `create_instance` | costs money |
| `scale_instance` | changes the bill; scaling down can leave an instance short of what it is using |
| `resize_storage`, `set_autoscale` | PostgreSQL; volumes only grow |
| `delete_instance` | **off by default** — see below |

### Guardrails

The CLI's protection against destroying the wrong thing is a prompt: it makes
you type the instance name at a terminal. An MCP server has no terminal and its
caller is a model, so that guard is translated rather than dropped.

- **`delete_instance` is not registered unless `ZEKTOR_MCP_ALLOW_DESTRUCTIVE=1`
  is set.** By default the tool does not appear in the list at all, so the worst
  a confused or injected instruction achieves is spending money, not losing data.
- **`scale_instance` and `delete_instance` require a `confirm_name` argument**
  that must match the instance's real name. It can only be filled in by having
  actually looked the instance up, which is the property the typed-name prompt
  had.
- Every tool carries the protocol's `readOnlyHint` / `destructiveHint`
  annotations, so a client that asks before running a tool asks about the right
  ones.

`get_connection` deserves its own note: for a cache it returns a connection
string containing a live password, which means putting that password into the
model's context. That is the point of the tool — it is how an agent wires an app
up to a new cache — but it is worth knowing before you enable the server
somewhere that logs conversations.

### Diagnostics

The server writes its API URL, where it found a token, and whether deletion is
enabled to stderr at startup; MCP clients collect that as server logs. A server
pointed at the wrong API looks exactly like a broken one until you read them.

## Output

**stdout carries data and nothing else.** Progress, warnings and errors go to
stderr, so pipes stay clean:

```bash
zektor whoami --json | jq -r .email
```

Failures exit non-zero, so `zektor … && next-command` stops rather than
continuing past an error the shell never saw.

## Configuration

| Variable | Purpose |
|---|---|
| `ZEKTOR_TOKEN` | Access token. Overrides the config file. |
| `ZEKTOR_API_URL` | API base URL. Defaults to `https://api.zektor.io`. |
| `XDG_CONFIG_HOME` | Honoured when set; config lives under `$XDG_CONFIG_HOME/zektor/`. |
| `ZEKTOR_MCP_ALLOW_DESTRUCTIVE` | Set to `1` to register `delete_instance` on the MCP server. Unset, the tool does not exist. |

## Roadmap

Next, roughly in order of how often they would be reached for:

- **Backups** — list, trigger, and restore to a point in time
- **Roles** — create and rotate Postgres credentials, which is also what would
  let `connect` work for Postgres rather than printing instructions
- **Logs** — tail an instance, the one thing people currently open a browser for
- **Waiting** — a `--wait` flag on `create` and `scale`, so scripts can block on
  an instance becoming ready instead of polling `list`

Not planned: admin commands. The admin console is deliberately browser-only.

## Development

```bash
npm install
npm run gen:api     # regenerate types/api.d.ts from the API's OpenAPI document
npm run build
node dist/index.js whoami
```

Point the whole thing at a local API with `ZEKTOR_API_URL=http://localhost:5098`,
including the MCP server — `ZEKTOR_API_URL=http://localhost:5098 node dist/index.js mcp`
serves your development backend rather than production.

`npm run gen:api` writes the API's full OpenAPI types to `types/`, which is
gitignored — it describes every endpoint including the admin surface, while this
CLI uses four, and nothing imports it. It is a tool for checking the
hand-written interfaces in `src/api.ts` against the real contract, not a build
input. Point it at a local API with
`ZEKTOR_API_URL=http://localhost:5098 npm run gen:api`.
