import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { api } from '../api.js'
import { data, fail, info } from '../output.js'

/** `zektor list` — one line per instance, or JSON. */
export async function list(opts: { json?: boolean }): Promise<void> {
    const instances = await api.listInstances()

    if (opts.json) return data(instances, true)

    if (instances.length === 0) return info('No instances.')

    // Pad to the widest name so the columns line up without a table library.
    const width = Math.max(...instances.map((i) => i.name.length))

    for (const i of instances)
        data(
            `${String(i.id).padStart(4)}  ${i.name.padEnd(width)}  ${i.status.padEnd(9)}  ${
                i.pricingTier?.product ?? '?'
            }  ${i.location ?? ''}`,
            false
        )
}

/** `zektor show <id>` — the detail the dashboard shows, minus the chrome. */
export async function show(id: string, opts: { json?: boolean }): Promise<void> {
    const instance = await api.getInstance(id)

    if (opts.json) return data(instance, true)

    const rows: [string, string][] = [
        ['id', String(instance.id)],
        ['name', instance.name],
        ['status', instance.status],
        ['engine', instance.pricingTier?.product ?? '?'],
        ['plan', instance.pricingTier?.name ?? '?'],
        ['location', instance.location ?? ''],
        ['port', String(instance.port ?? '')],
        ['created', instance.createdAt ?? ''],
    ]

    for (const [key, value] of rows) data(`${key.padEnd(9)} ${value}`, false)

    // The connection string carries the password. Printing it on `show` would
    // put a live credential into scrollback and CI logs for anyone who ran the
    // command to check a status; `connect` is the deliberate path to it.
    if (instance.connectionString)
        info('\nConnection string not shown. Use `zektor connect` to open a session.')
}

/**
 * `zektor delete <id>`.
 *
 * Prompts unless `--yes`, and asks for the name rather than a bare y/n — the
 * point is to make you look at which instance you are about to destroy.
 */
export async function remove(id: string, opts: { yes?: boolean }): Promise<void> {
    const instance = await api.getInstance(id)

    if (!opts.yes) {
        if (!process.stdin.isTTY)
            fail('Refusing to delete without a terminal to confirm at. Pass --yes if you mean it.')

        const rl = createInterface({ input: process.stdin, output: process.stderr })
        const answer = await rl.question(
            `This deletes "${instance.name}" (#${instance.id}) and its data. Type the name to confirm: `
        )
        rl.close()

        if (answer.trim() !== instance.name) fail('Name did not match. Nothing was deleted.')
    }

    await api.deleteInstance(id)
    info(`Deleting ${instance.name} (#${instance.id}).`)
}

/**
 * `zektor connect <id>`.
 *
 * Opens a `redis-cli` session for Valkey/Redis. For Postgres there is nothing to
 * open with — the password exists only in the response that created the role —
 * so it prints the command shape and says where the credential comes from.
 *
 * The client is not bundled: when it is missing we name it rather than failing
 * with a bare ENOENT, since shipping a database client inside an npm package is
 * not a trade worth making.
 */
export async function connect(id: string): Promise<void> {
    const instance = await api.getInstance(id)

    if (instance.status !== 'active')
        fail(`${instance.name} is ${instance.status}, not active. Wait for provisioning to finish.`)

    const connection = await api.getConnection(id).catch((error) => {
        fail(`Could not read connection details for ${instance.name}: ${(error as Error).message}`)
    })

    // Postgres deliberately has no retrievable credential: the password is
    // emitted once when a role is created and never stored, so there is nothing
    // here to build a connection string from. Saying that is far more useful
    // than failing with an empty string.
    if (connection.type === 'postgres' || !connection.connectionString) {
        const host = connection.host ?? '<host>'
        const port = connection.port ?? instance.port
        const database = connection.databaseName ?? connection.database ?? '<database>'

        info(`${instance.name} is Postgres — its password is not retrievable.`)
        info(
            'Passwords are shown once when a role is created or rotated, and the server does not ' +
                'store them. Create or rotate a role in the dashboard, then:'
        )
        data(`psql "postgresql://<role>:<password>@${host}:${port}/${database}?sslmode=require"`, false)
        return
    }

    const command = 'redis-cli'
    const args = ['-u', connection.connectionString]

    info(`Connecting to ${instance.name} with ${command}…`)

    const child = spawn(command, args, { stdio: 'inherit' })

    child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT')
            fail(
                `${command} is not installed or not on PATH. Install it, or connect manually with the ` +
                    'connection string from the dashboard.'
            )

        fail(error.message)
    })

    // Pass the client's exit code through, so scripts see what really happened.
    child.on('exit', (code) => process.exit(code ?? 0))
}
