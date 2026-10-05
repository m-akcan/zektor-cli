import { createInterface } from 'node:readline/promises'

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

/**
 * Ends a command the user backed out of at a prompt, with the shell's Ctrl+C code.
 * The newline moves off the prompt line, where the cursor still sits.
 */
export function cancelled(): never {
    process.stderr.write('\n')
    fail('Cancelled. Nothing was changed.', 130)
}

/**
 * Asks one question on stderr. Ctrl+C, Ctrl+D or a closed stdin close readline
 * without an answer, which would leave the await unsettled: Node then prints a
 * warning about the CLI's own code and exits 13. They cancel instead.
 */
export async function ask(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    let answered = false
    rl.on('close', () => {
        if (!answered) cancelled()
    })

    const answer = await rl.question(question)
    answered = true
    rl.close()
    return answer
}
