import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where the token lives, and the rules for finding one.
 *
 * `ZEKTOR_TOKEN` beats the config file, always. That is what makes the CLI work
 * in CI — a job sets one environment variable and never runs `zektor login` —
 * and it is the main reason the API uses long-lived personal access tokens
 * rather than the seven-day session JWT.
 */

export interface Config {
    token?: string
    /** Only set when the user overrode it; otherwise the default applies. */
    apiUrl?: string
}

export const DEFAULT_API_URL = 'https://api.zektor.io'

/**
 * `~/.config/zektor/config.json`, honouring `XDG_CONFIG_HOME` where it is set so
 * the file lands where the rest of a Linux user's tooling expects it.
 */
export function configPath(): string {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    return join(base, 'zektor', 'config.json')
}

export function readConfig(): Config {
    const path = configPath()

    if (!existsSync(path)) return {}

    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Config
    } catch {
        // A corrupt file should not wedge the CLI into an unusable state — treat it
        // as absent so `zektor login` can overwrite it.
        return {}
    }
}

export function writeConfig(config: Config): void {
    const path = configPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

    // Written 0600 because it holds a credential with the same power as the
    // account. mode on writeFileSync is subject to umask, so chmod after.
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    chmodSync(path, 0o600)
}

export function clearConfig(): void {
    const path = configPath()
    if (existsSync(path)) rmSync(path)
}

/** Env var first, then the config file. Undefined when neither has one. */
export function resolveToken(): string | undefined {
    return process.env.ZEKTOR_TOKEN || readConfig().token
}

/** Env var, then config, then the production default. */
export function resolveApiUrl(): string {
    return (
        process.env.ZEKTOR_API_URL ||
        readConfig().apiUrl ||
        DEFAULT_API_URL
    ).replace(/\/+$/, '')
}

/** True when the active token came from the environment rather than the file. */
export function tokenIsFromEnv(): boolean {
    return Boolean(process.env.ZEKTOR_TOKEN)
}
