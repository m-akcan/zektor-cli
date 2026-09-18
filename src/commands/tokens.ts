import { createInterface } from 'node:readline/promises'
import { api, type ApiTokenSummary } from '../api.js'
import { data, fail, info, warn } from '../output.js'

/**
 * Valid scopes, duplicated from the backend on purpose.
 *
 * Catching a typo here turns a 400 round-trip into an immediate message that
 * lists the alternatives. The cost is that a scope added server-side is
 * rejected by an older CLI until it updates — which is the safer direction to
 * be wrong in, since the other one silently sends nonsense.
 */
const SCOPES = [
    'instances:read',
    'instances:write',
    'instances:delete',
    'branches:write',
    'roles:write',
    'billing:read',
    'tokens:write',
]

/**
 * Accepts `30m`, `12h`, `7d`, or anything Date can parse.
 *
 * The relative forms are what anyone actually wants at a prompt: an agent
 * credential is measured in minutes, and making people compute an ISO timestamp
 * for that is how you end up with everyone passing a year.
 */
function parseExpiry(value: string): string {
    const relative = /^(\d+)\s*([mhd])$/i.exec(value.trim())

    if (relative) {
        const amount = Number(relative[1])
        const unit = relative[2]!.toLowerCase() as 'm' | 'h' | 'd'
        const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]
        return new Date(Date.now() + amount * ms).toISOString()
    }

    const absolute = new Date(value)
    if (Number.isNaN(absolute.getTime()))
        fail(`Could not read "${value}" as a time. Use 30m, 12h, 7d, or an ISO date.`)

    return absolute.toISOString()
}

function describe(token: ApiTokenSummary): string {
    const parts = [`#${token.id}`, token.name, token.prefix + '…']

    parts.push(token.scopes.split(',').length === SCOPES.length ? 'all scopes' : token.scopes)

    if (token.instanceId !== null) parts.push(`instance ${token.instanceId}`)
    if (token.expiresAt !== null) parts.push(`expires ${token.expiresAt}`)
    else parts.push('never expires')
    if (token.parentTokenId !== null) parts.push(`minted by #${token.parentTokenId}`)

    return parts.join('  ')
}

export async function tokensList(options: { json?: boolean }): Promise<void> {
    const tokens = await api.listTokens()

    if (options.json) {
        data(tokens, true)
        return
    }

    if (tokens.length === 0) {
        info('No tokens.')
        return
    }

    data(tokens.map(describe).join('\n'), false)
}

export async function tokensCreate(options: {
    name: string
    scope?: string[]
    expires?: string
    instance?: string
    json?: boolean
}): Promise<void> {
    const scopes = options.scope ?? []

    const unknown = scopes.filter((s) => !SCOPES.includes(s))
    if (unknown.length > 0)
        fail(`Unknown scope: ${unknown.join(', ')}. Valid scopes: ${SCOPES.join(', ')}`)

    // The backend refuses an unbounded derived token anyway. Saying so here costs a
    // round-trip less and explains the rule rather than just the rejection.
    if (!options.expires)
        fail(
            'A token minted by another token must expire. Pass --expires (e.g. 1h, 7d), ' +
                'capped at 90 days or at this token\'s own expiry, whichever is sooner.'
        )

    const created = await api.createToken({
        name: options.name,
        scopes: scopes.length > 0 ? scopes : undefined,
        expiresAt: parseExpiry(options.expires),
        instanceId: options.instance ? Number(options.instance) : undefined,
    })

    if (options.json) {
        data(created, true)
        return
    }

    // The plaintext alone on stdout, so `TOKEN=$(zektor tokens create …)` works and
    // everything explanatory stays on stderr where it cannot corrupt it.
    info(`Created #${created.id} "${created.name}" — ${describe(created)}`)
    warn('This is the only time the token is shown. It is not recoverable.')
    data(created.token, false)
}

export async function tokensRevoke(id: string, options: { yes?: boolean }): Promise<void> {
    const tokens = await api.listTokens()
    const token = tokens.find((t) => String(t.id) === String(id))

    if (!token) fail(`No token #${id}.`)

    // Children are revoked with their parent, so this can end far more access than the
    // one line the caller typed suggests. Say how much before doing it.
    const descendants = countDescendants(tokens, token.id)

    if (!options.yes) {
        if (!process.stdin.isTTY)
            fail('Refusing to revoke without a terminal to confirm at. Pass --yes if you mean it.')

        const also = descendants > 0 ? ` and ${descendants} token(s) minted by it` : ''
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        const answer = await rl.question(
            `This revokes "${token.name}" (#${token.id})${also}. Type the name to confirm: `
        )
        rl.close()

        if (answer.trim() !== token.name) fail('Name did not match. Nothing was revoked.')
    }

    await api.revokeToken(token.id)

    const also = descendants > 0 ? ` and ${descendants} descendant(s)` : ''
    info(`Revoked ${token.name} (#${token.id})${also}.`)
}

/** Walks the parent links the list already carries, rather than asking the API again. */
function countDescendants(tokens: ApiTokenSummary[], rootId: number): number {
    let frontier = [rootId]
    let total = 0

    while (frontier.length > 0) {
        const children = tokens.filter(
            (t) => t.parentTokenId !== null && frontier.includes(t.parentTokenId)
        )
        if (children.length === 0) break

        total += children.length
        frontier = children.map((c) => c.id)
    }

    return total
}
