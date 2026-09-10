import { clearConfig, configPath, readConfig, tokenIsFromEnv } from '../config.js'
import { info, warn } from '../output.js'

/**
 * Forgets the stored token.
 *
 * Deliberately does not revoke it server-side: the token may be in use on
 * another machine or in CI, and "log out of this laptop" should not break those.
 * Revoking is a separate, deliberate act in Settings.
 */
export async function logout(): Promise<void> {
    const hadToken = Boolean(readConfig().token)

    clearConfig()

    if (tokenIsFromEnv())
        warn('ZEKTOR_TOKEN is still set in this environment — unset it to fully log out.')

    info(
        hadToken
            ? `Removed the token from ${configPath()}. It is still valid — revoke it in Settings to end its access.`
            : 'No stored token to remove.'
    )
}
