#!/usr/bin/env node
import { Command } from 'commander'
import { create } from './commands/create.js'
import { connect, list, remove, show } from './commands/instances.js'
import { login } from './commands/login.js'
import { logout } from './commands/logout.js'
import { whoami } from './commands/whoami.js'
import { ApiError, NotAuthenticatedError } from './api.js'
import { fail } from './output.js'

const program = new Command()

program
    .name('zektor')
    .description('Command-line client for Zektor.io managed databases and caches')
    .version('0.1.0')

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
    .command('connect <id>')
    .description('Open a redis-cli session, or print how to connect to Postgres')
    .action(async (id) => {
        await connect(id)
    })

// An unhandled rejection would print a stack trace, which is never the right
// thing for a CLI. API and auth failures already carry a usable message.
process.on('unhandledRejection', (reason) => {
    if (reason instanceof NotAuthenticatedError || reason instanceof ApiError)
        fail(reason.message)

    fail(reason instanceof Error ? reason.message : String(reason))
})

await program.parseAsync(process.argv)
