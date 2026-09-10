# zektor

Command-line client for [Zektor.io](https://zektor.io) managed databases and caches.

> **Status: early.** Authentication works; resource commands (`db create`,
> `list`, `connect`) are not built yet. See [Roadmap](#roadmap).

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

Every read command takes `--json`.

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

## Roadmap

`db create` and `cache create` will match the "equivalent CLI" panel already
shown in the dashboard's creation wizard, so what it displays is a command you
can actually run. Then `list`, `show`, `delete`, and `connect` — which execs
into `psql` or `redis-cli` with the right connection string.

## Development

```bash
npm install
npm run gen:api     # regenerate types/api.d.ts from the API's OpenAPI document
npm run build
node dist/index.js whoami
```

`types/api.d.ts` is generated from the server's OpenAPI document rather than
hand-written, so a DTO change on the backend becomes a build error here instead
of a runtime surprise in someone's terminal. Point it at a local API with
`ZEKTOR_API_URL=http://localhost:5098 npm run gen:api`.
