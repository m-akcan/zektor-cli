import { api, ApiError, NotAuthenticatedError } from '../api.js'
import { resolveApiUrl, tokenIsFromEnv } from '../config.js'
import { data, fail } from '../output.js'

/**
 * Confirms which account the current token belongs to, and where it came from.
 *
 * The credential source matters more than it looks: an unexpected
 * `ZEKTOR_TOKEN` in the environment silently overrides a `zektor login`, and
 * this is the command that makes that visible.
 */
export async function whoami(options: { json?: boolean }): Promise<void> {
    try {
        const me = await api.me()

        const source = tokenIsFromEnv() ? 'ZEKTOR_TOKEN' : 'config file'

        if (options.json) {
            data({ id: me.id, email: me.email, role: me.role, apiUrl: resolveApiUrl(), tokenSource: source }, true)
            return
        }

        data(`${me.email} (${resolveApiUrl()}, token from ${source})`, false)
    } catch (error) {
        if (error instanceof NotAuthenticatedError) fail(error.message)

        if (error instanceof ApiError) fail(error.message)

        fail(error instanceof Error ? error.message : String(error))
    }
}
