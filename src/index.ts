#!/usr/bin/env node
import { Command } from 'commander'
import { login } from './commands/login.js'
import { logout } from './commands/logout.js'
import { whoami } from './commands/whoami.js'
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

// Commander throws on unknown commands rather than exiting, and an unhandled
// rejection prints a stack trace no user of a CLI wants to read.
process.on('unhandledRejection', (reason) => {
    fail(reason instanceof Error ? reason.message : String(reason))
})

await program.parseAsync(process.argv)
