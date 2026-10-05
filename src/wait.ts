import { api } from './api.js'
import { fail, info } from './output.js'

/**
 * `--wait` for create, scale and storage resize.
 *
 * The API accepts those and returns an action id; the work itself runs in the
 * background, and when it fails the instance can look unchanged forever. This
 * follows the action to its end, so a script sees a failure as a failure.
 */

const POLL_MS = 3_000

// Nothing takes this long. An action still Running by then was abandoned server-side.
const GIVE_UP_MS = 30 * 60_000

/** Returns once the action succeeded; exits non-zero with the reason when it failed. */
export async function waitForAction(actionId: number, what: string): Promise<void> {
    info('Waiting for it to finish…')

    const deadline = Date.now() + GIVE_UP_MS

    while (Date.now() < deadline) {
        const action = await api.getAction(actionId).catch((error: Error) => {
            fail(`${what} was accepted, but its progress could not be read: ${error.message}`)
        })

        if (action.status === 'Success') return

        if (action.status === 'Failure')
            fail(`${what} failed: ${action.errorMessage?.trim() || 'the API gave no reason.'}`)

        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }

    fail(`${what} is still running after 30 minutes. Check it in the dashboard.`)
}
