import { ApiError, api } from '../api.js'
import { data, fail, info } from '../output.js'

/**
 * `zektor try`: a Postgres database for the next hour, with no account, no token and
 * no card. stdout carries only the connection string, so `psql "$(npx zektor try)"`
 * works; how long it lasts and how to keep it go to stderr.
 */
export async function tryTrial(opts: { json?: boolean }): Promise<void> {
    // Only for the size cap, so a failure here must not cost the user their trial.
    const maxDatabaseMb = api.trialAvailability().then(
        (a) => a.maxDatabaseMb,
        () => undefined
    )

    let trial
    try {
        trial = await api.createTrial()
    } catch (error) {
        // The API answers 404 while trials are switched off.
        if (error instanceof ApiError && error.status === 404)
            fail("Trials aren't available right now. Sign up at https://zektor.io to create a database.")
        throw error
    }

    const cap = await maxDatabaseMb

    if (opts.json) {
        data(cap === undefined ? trial : { ...trial, maxDatabaseMb: cap }, true)
        return
    }

    const connectUntil = new Date(trial.connectUntil)
    const minutes = Math.max(0, Math.round((connectUntil.getTime() - Date.now()) / 60000))
    info(`Connection works until ${connectUntil.toLocaleTimeString()} (${minutes} min).`)
    info(`Keep it: ${trial.claimUrl}`)
    info(`  Sign up there before ${new Date(trial.claimUntil).toLocaleTimeString()} and your data moves into a database of your own.`)
    info('  Unclaimed trials are deleted, data included. No superuser; trusted extensions such as pgcrypto work.')
    if (cap !== undefined)
        info(`  Size cap: ${cap} MB. Past it the database stops accepting connections; the data is kept for the claim.`)
    data(trial.connectionString, false)
}
