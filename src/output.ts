/**
 * Output discipline, in one place so every command obeys it.
 *
 * stdout carries data and nothing else, so `zektor list --json | jq` works
 * without filtering. Progress, warnings and errors go to stderr. Retrofitting
 * this later is painful, which is why it exists before there is much to print.
 */

/** Machine-readable payload. The only thing that may reach stdout. */
export function data(value: unknown, json: boolean): void {
    if (json) {
        process.stdout.write(JSON.stringify(value, null, 2) + '\n')
        return
    }

    if (typeof value === 'string') {
        process.stdout.write(value + '\n')
        return
    }

    process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

/** Human-facing confirmation. Never stdout — it would corrupt piped output. */
export function info(message: string): void {
    process.stderr.write(message + '\n')
}

export function warn(message: string): void {
    process.stderr.write(`warning: ${message}\n`)
}

/**
 * Prints to stderr and exits non-zero, so `zektor … && next-thing` stops rather
 * than continuing on a failure the shell never saw.
 */
export function fail(message: string, code = 1): never {
    process.stderr.write(`error: ${message}\n`)
    process.exit(code)
}
