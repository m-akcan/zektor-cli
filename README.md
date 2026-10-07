# zektor

Command-line client for [Zektor.io](https://zektor.io) managed databases and caches.

[![npm](https://img.shields.io/npm/v/zektor)](https://www.npmjs.com/package/zektor)

> **Beta.** The CLI and its MCP server are supported and live, but young. Expect
> commands to be added and rough edges filed off as we learn how people use them.
>
> Beta is not a warning about stability of what exists: **1.0.0 settles the
> command surface.** Flags, output shapes and exit codes will not change without
> a major version, so `--json` is safe to parse in a script, and tokens you
> create now keep working.

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
| `zektor try` | A Postgres database for the next hour, **no account needed** (see below) |
| `zektor login` | Store a token for this machine |
| `zektor logout` | Forget the stored token. Does **not** revoke it — the same token may be in use elsewhere. Revoke in Settings to end its access. |
| `zektor whoami` | Show the account, API URL, and where the token came from |
| `zektor list` | List your instances |
| `zektor show <id>` | Show one instance |
| `zektor db create` / `zektor cache create` | Provision a database or cache |
| `zektor delete <id>` | Delete an instance. Asks you to type its name; `--yes` skips that. |
| `zektor connect <id>` | Open `redis-cli` against a cache |
| `zektor scale <id> --tier=…` | Move an instance to another plan |
| `zektor storage show\|resize\|autoscale <id>` | Postgres storage: see what it costs, grow it, and set automatic growth (see below) |
| `zektor mcp` | Run as an MCP server, so an editor or agent can drive the API (see below) |

Every read command takes `--json`.

### Trying it without an account

```sh
psql "$(npx zektor try)"
```

`zektor try` prints a connection string on stdout and, on stderr, how long it works
and a claim link. The database accepts connections for 60 minutes. Open the claim
link within 3 hours, sign up and add a payment method, and the data moves into a
database of your own; otherwise it is deleted. Up to 200 MB and 3 connections, no
superuser (trusted extensions such as `pgcrypto` work), and 3 trials per network per
day. `--json` prints all of it as JSON. The same is available without the CLI:

```sh
curl -X POST https://api.zektor.io/api/trial
```

### Creating

```bash
zektor db create --name=my-db --tier=AKPG-5 --region=nbg1 --engine=postgres@17
```

`--tier`, `--region` and `--engine` take the names you see in the dashboard and
are resolved to ids for you. `--tier` and `--region` are required; leave one out
or pass a wrong one and the error lists what is valid.

Creating runs in the background. Add `--wait` to block until the instance is
ready; if creating it fails, the command prints why and exits non-zero.

`--storage` is rejected: storage starts at what the plan includes. Grow it
afterwards with `zektor storage resize`.

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
`--yes` skips that. A downgrade warns that the smaller plan has less memory than
the instance may be using. When the target plan includes less storage than the
database is billed for, `scale` also says what the difference costs, with or
without `--yes`.

`scale` and `storage resize` run in the background too, and take `--wait`: it
blocks until the change has finished, and on failure prints the reason and
exits non-zero. Without it, a failed scale is easy to miss, since the instance
simply stays on its old plan.

Storage is **PostgreSQL only** — a cache is sized by its plan, so use `scale`.

- **Included.** Every plan includes storage: 5 GB on AKPG-5 to AKPG-40, then 10,
  20 and 40 GB on AKPG-80, 160 and 320. A new database starts there.
- **Growing.** `storage resize` grows it any time, up to 1000 GB. It runs
  online, with no restart, and prints on stderr what the new size costs.
- **Never shrinks.** Storage only grows. Neither you, a plan change nor a
  restore can make it smaller. The only way to pay for less is to `pg_dump`
  into a new database and delete the old one.
- **Price.** €0.15/GB/month net above what the plan includes, in whole GB,
  prorated by the hour like plans. You pay for the size, not the usage:
  deleting rows frees room, not money. `storage show` prints what is billed now.
- **Payment.** Growing above the plan, or turning on automatic growth, needs a
  payment method or account credit.
- **Automatic growth** is opt-in, and needs a maximum above the current size:
  `storage autoscale 42 --on --limit=100`. At 80% full it grows to the larger
  of +5 GB or 70% full, never above the maximum. Each grow is permanent and
  billed like a manual one, and you're notified each time. After a failed
  automatic grow it waits a day. A limit can't be cleared once set, since the
  API reads an omitted value as "leave unchanged"; set a new number, or turn
  growth off with `--off`.
- **Plan changes.** An upgrade to a plan that includes more raises the size to
  the plan's, free. A downgrade keeps its storage, and the GB above the smaller
  plan are billed.
- **Branches.** A branch is billed on its plan, plus what it writes itself
  above its plan's included storage, while it is a branch. Once promoted, it is
  billed on its full size, which is the source's size when it was branched (or
  larger, if grown).
- **Legacy databases.** Databases created before growable storage can't grow
  yet. They are moving soon, and are never billed for storage.

**Changed in 1.7.0.** `storage resize` now grows storage through
`/api/instances/{id}/storage/grow` and refuses a size that isn't larger than
now. `storage autoscale` still accepts `--min` and `--up-only`, and ignores
them. The MCP tool `resize_storage` now requires `confirm_name`.

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
| `create_trial_database` | only when **no token** is configured: a free database for an hour, with a claim link to give the user |
| `whoami`, `list_instances`, `get_instance` | read-only |
| `get_action` | read-only; how the background work started by `create_instance`, `scale_instance` or `resize_storage` went, by the `actionId` they return |
| `list_plans`, `list_regions` | read-only; call these before creating rather than guessing a name |
| `get_connection` | read-only, **returns a live password** for caches |
| `get_storage` | read-only, PostgreSQL; size, usage and what is billed above the plan |
| `create_instance` | costs money |
| `scale_instance` | changes the bill; scaling down can leave an instance short of memory, and keeps its storage, billing the GB above the smaller plan |
| `resize_storage` | PostgreSQL; grows storage, which can't be undone; GB above the plan are billed |
| `set_autoscale` | PostgreSQL; turns automatic growth on or off, up to a limit |
| `delete_instance` | **off by default** — see below |

### Guardrails

The CLI's protection against destroying the wrong thing is a prompt: it makes
you type the instance name at a terminal. An MCP server has no terminal and its
caller is a model, so that guard is translated rather than dropped.

- **`delete_instance` is not registered unless `ZEKTOR_MCP_ALLOW_DESTRUCTIVE=1`
  is set.** By default the tool does not appear in the list at all, so the worst
  a confused or injected instruction achieves is spending money, not losing data.
- **`scale_instance`, `resize_storage` and `delete_instance` require a `confirm_name` argument**
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
gitignored — it describes every endpoint including the admin surface, and
nothing imports it. It is a tool for checking the
hand-written interfaces in `src/api.ts` against the real contract, not a build
input. Point it at a local API with
`ZEKTOR_API_URL=http://localhost:5098 npm run gen:api`.
