import { api } from '../api.js'
import { resolveEngine, resolveLocation, resolveTier } from '../resolve.js'
import { data, fail, info } from '../output.js'

/**
 * `zektor db create` / `zektor cache create`.
 *
 * The flag grammar is inherited, not designed: the dashboard's creation wizard
 * renders exactly this command as an "equivalent CLI" panel, so it is a
 * specification. What the wizard does *not* show is that the API takes numeric
 * ids — `priceId`, `location`, `dockerImageId` — so every human-readable flag
 * here is resolved to one first. Those lookups live in `resolve.ts`, shared with
 * the MCP server; a `ResolutionError` from them reaches the top-level handler in
 * `index.ts`, which prints it exactly as `fail()` would.
 */

interface CreateOptions {
    name?: string
    engine?: string
    region?: string
    tier?: string
    storage?: string
    json?: boolean
}

export async function create(group: 'database' | 'cache', opts: CreateOptions): Promise<void> {
    if (opts.storage)
        fail(
            '--storage is not supported. Storage is fixed by the plan, so choose it with --tier. ' +
                'The wizard shows a --storage flag, but its own create call does not send one.'
        )

    if (!opts.name) fail('--name is required.')
    if (!opts.tier) fail('--tier is required. Run with a wrong value to see the available plans.')

    const tier = resolveTier(await api.listTiers(), group, opts.tier)
    const dockerImageId = resolveEngine(tier, opts.engine)

    const location = opts.region
        ? resolveLocation(await api.listLocations(), opts.region)
        : undefined

    const result = await api.createInstance({
        name: opts.name,
        location,
        priceId: tier.id,
        dockerImageId,
    })

    if (opts.json) {
        data({ instanceId: result.instanceId, actionId: result.actionId, name: opts.name }, true)
        return
    }

    // Provisioning is asynchronous and takes under a minute; say so rather than
    // implying the instance is ready to connect to.
    info(`Creating ${opts.name} (#${result.instanceId}) on ${tier.name}.`)
    data(String(result.instanceId), false)
}
