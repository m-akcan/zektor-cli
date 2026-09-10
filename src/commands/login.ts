import { createInterface } from 'node:readline'
import { api, ApiError } from '../api.js'
import { readConfig, tokenIsFromEnv, writeConfig } from '../config.js'
import { fail, info, warn } from '../output.js'

/**
 * Reads a line without echoing it, so a pasted token does not sit in the
 * terminal scrollback or get captured by a screen recording.
 *
 * Falls back to a visible prompt when stdin is not a TTY — in that case the
 * caller is piping input and there is nothing to hide from.
 */
function promptHidden(question: string): Promise<string> {
    if (!process.stdin.isTTY) {
        return new Promise((resolve) => {
            const rl = createInterface({ input: process.stdin })
            rl.once('line', (line) => {
                rl.close()
                resolve(line.trim())
            })
        })
    }

    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })

        // readline echoes as it writes; suppress the echo but keep the prompt.
        const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput: (s: string) => void }
        const original = output._writeToOutput.bind(rl)
        output._writeToOutput = (chunk: string) => {
            if (chunk.includes(question)) original(chunk)
        }

        rl.question(question, (answer) => {
            rl.close()
            process.stderr.write('\n')
            resolve(answer.trim())
        })
    })
}

export async function login(options: { token?: string }): Promise<void> {
    if (tokenIsFromEnv())
        warn('ZEKTOR_TOKEN is set and takes precedence — this login will not be used until you unset it.')

    const token =
        options.token ??
        (await promptHidden('Paste an access token (create one in Settings → Access tokens): '))

    if (!token) fail('No token provided.')

    // Verify before writing. Storing an unusable token means the next command
    // fails with a confusing 401 rather than here, where the cause is obvious.
    let me
    try {
        me = await api.me(token)
    } catch (error) {
        if (error instanceof ApiError && error.status === 401)
            fail('That token was rejected. Check you pasted it whole, and that it is not revoked.')

        fail(error instanceof Error ? error.message : String(error))
    }

    // Preserve any apiUrl the user configured; login should not reset it.
    writeConfig({ ...readConfig(), token })

    info(`Logged in as ${me.email}.`)
}
