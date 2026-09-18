#!/usr/bin/env node
import { Command } from 'commander'
import { create } from './commands/create.js'
import { connect, list, remove, show } from './commands/instances.js'
import { scale } from './commands/scale.js'
import { storageAutoscale, storageResize, storageShow } from './commands/storage.js'
import { login } from './commands/login.js'
import { logout } from './commands/logout.js'
import { whoami } from './commands/whoami.js'
import { tokensCreate, tokensList, tokensRevoke } from './commands/tokens.js'
import { ApiError, NotAuthenticatedError } from './api.js'
import { fail } from './output.js'
import { VERSION } from './version.js'

/** `--scope a,b --scope c` accumulates rather than overwriting. */
function collectScopeOption(value: string, previous: string[]): string[] {
    return [...previous, ...value.split(',').map((s) => s.trim()).filter(Boolean)]
}

const program = new Command()

program
    .name('zektor')
    .description('Command-line client for Zektor.io managed databases and caches')
    .version(VERSION)

program
    .command('login')
    .description('Store an access token for this machine')
    .option(
        '--token <token>',
        'Token to use instead of being prompted. Prefer the prompt: an argument lands in your shell history.'
    )
    .action(async (options) => {
        await login(options)
    })

program
    .command('logout')
    .description('Remove the stored token from this machine (does not revoke it)')
    .action(async () => {
        await logout()
    })

program
    .command('whoami')
    .description('Show which account the current token belongs to')
    .option('--json', 'Emit JSON on stdout')
    .action(async (options) => {
        await whoami(options)
    })

/** Shared by `db` and `cache`, so the two differ only in which group they create. */
function addCreate(parent: Command, group: 'database' | 'cache') {
    parent
        .command('create')
        .description(`Provision a ${group}`)
        .requiredOption('--name <name>', 'Instance name')
        .option('--tier <plan>', 'Plan name, e.g. AKVK-1')
        .option('--engine <engine>', 'Engine and optional version, e.g. postgres@17')
        .option('--region <region>', 'Region name or city')
        .option('--storage <storage>', 'Not supported — storage comes from the plan')
        .option('--json', 'Emit JSON on stdout')
        .action(async (options) => {
            await create(group, options)
        })
}

const db = program.command('db').description('Managed databases')
addCreate(db, 'database')

const cache = program.command('cache').description('Managed caches')
addCreate(cache, 'cache')

program
    .command('list')
    .description('List your instances')
    .option('--json', 'Emit JSON on stdout')
    .action(async (options) => {
        await list(options)
    })

program
    .command('show <id>')
    .description('Show one instance')
    .option('--json', 'Emit JSON on stdout')
    .action(async (id, options) => {
        await show(id, options)
    })

program
    .command('delete <id>')
    .description('Delete an instance and its data')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (id, options) => {
        await remove(id, options)
    })

program
    .command('scale <id>')
    .description('Move an instance to another plan')
    .requiredOption('--tier <plan>', 'Target plan, e.g. AKPG-10')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--json', 'Emit JSON on stdout')
    .action(async (id, options) => {
        await scale(id, options)
    })

const storage = program
    .command('storage')
    .description('Postgres storage: size and autoscaling')

storage
    .command('show <id>')
    .description('Show size, usage and autoscaling settings')
    .option('--json', 'Emit JSON on stdout')
    .action(async (id, options) => {
        await storageShow(id, options)
    })

storage
    .command('resize <id>')
    .description('Grow the volume. Volumes cannot shrink.')
    .requiredOption('--size <gb>', 'New size in whole gigabytes')
    .option('--json', 'Emit JSON on stdout')
    .action(async (id, options) => {
        await storageResize(id, options)
    })

storage
    .command('autoscale <id>')
    .description('Turn autoscaling on or off and set its bounds')
    .option('--on', 'Enable autoscaling')
    .option('--off', 'Disable autoscaling')
    .option('--limit <gb>', 'Autoscaling ceiling in gigabytes')
    .option('--min <gb>', 'Minimum disk size in gigabytes (write-only: the API never reports it back)')
    .option('--up-only <yes|no>', 'Grow only (yes), or allow automatic shrinking (no)')
    .option('--json', 'Emit JSON on stdout')
    .action(async (id, options) => {
        await storageAutoscale(id, options)
    })

/**
 * `zektor tokens` — mint narrower credentials from the one you already hold.
 *
 * Every token this creates is weaker than the one creating it: the backend
 * intersects the scopes, caps the expiry at your own, and carries over any
 * instance pin. That is what makes it safe to run unattended — a token in CI
 * cannot use this to widen itself, only to hand something narrower to whatever
 * it spawns. Revoking a token revokes everything it minted.
 */
const tokens = program.command('tokens').description('Personal access tokens')

tokens
    .command('list')
    .description('List your tokens')
    .option('--json', 'Emit JSON on stdout')
    .action(async (options) => {
        await tokensList(options)
    })

tokens
    .command('create')
    .description('Mint a narrower token from the one you are using')
    .requiredOption('--name <name>', 'Label for the token, e.g. "ci" or "agent-44"')
    .option(
        '--scope <scope>',
        'Scope to grant; repeatable or comma-separated. Defaults to everything your own token has.',
        collectScopeOption,
        [] as string[]
    )
    .requiredOption('--expires <when>', 'When it dies: 30m, 12h, 7d, or an ISO date')
    .option('--instance <id>', 'Pin the token to one instance')
    .option('--json', 'Emit JSON on stdout')
    .action(async (options) => {
        await tokensCreate(options)
    })

tokens
    .command('revoke <id>')
    .description('Revoke a token, and everything it minted')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (id, options) => {
        await tokensRevoke(id, options)
    })

/**
 * `zektor mcp` — serve the API to an MCP client over stdio.
 *
 * Imported lazily. The MCP SDK is by far the heaviest thing in the dependency
 * tree, and loading it on every `zektor list` would be a cost paid by everyone
 * to benefit the few who wire this into an editor.
 */
program
    .command('mcp')
    .description('Run as an MCP server over stdio (for editors and agents)')
    .action(async () => {
        const { startMcpServer } = await import('./mcp.js')
        await startMcpServer()
    })

program
    .command('connect <id>')
    .description('Open a redis-cli session, or print how to connect to Postgres')
    .action(async (id) => {
        await connect(id)
    })

/**
 * Every failure exits with a message, never a stack trace.
 *
 * A rejected top-level `await` in an ESM module surfaces as an *uncaught
 * exception*, not an unhandled rejection, so listening for the latter alone
 * left commands printing Node's default trace. Catch the await itself; the
 * listener stays for anything that escapes a detached promise.
 */
function reportAndExit(reason: unknown): never {
    if (reason instanceof NotAuthenticatedError || reason instanceof ApiError)
        fail(reason.message)

    fail(reason instanceof Error ? reason.message : String(reason))
}

process.on('unhandledRejection', reportAndExit)

try {
    await program.parseAsync(process.argv)
} catch (error) {
    reportAndExit(error)
}
