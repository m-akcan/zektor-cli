import { ApiError, api } from '../api.js'
import { data, fail, info } from '../output.js'

/**
 * `zektor try`: a Postgres database for the next hour, with no account, no token and
 * no card. stdout carries only the connection string, so `psql "$(npx zektor try)"`
 * works; how long it lasts and how to keep it go to stderr.
 */
export async function tryTrial(opts: { json?: boolean }): Promise<void> {
    let trial
    try {
        trial = await api.createTrial()
    } catch (error) {
        // The API answers 404 while trials are switched off.
        if (error instanceof ApiError && error.status === 404)
            fail("Trials aren't available right now. Sign up at https://zektor.io to create a database.")
        throw error
    }

    if (opts.json) {
        data(trial, true)
        return
    }

    const connectUntil = new Date(trial.connectUntil)
    const minutes = Math.max(0, Math.round((connectUntil.getTime() - Date.now()) / 60000))
    info(`Connection works until ${connectUntil.toLocaleTimeString()} (${minutes} min).`)
    info(`Keep it: ${trial.claimUrl}`)
    info(`  Sign up there before ${new Date(trial.claimUntil).toLocaleTimeString()} and your data moves into a database of your own.`)
    info('  Unclaimed trials are deleted, data included. No superuser; trusted extensions such as pgcrypto work.')
    data(trial.connectionString, false)
}
