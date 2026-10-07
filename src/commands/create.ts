import { api } from '../api.js'
import { options, resolveEngine, resolveLocation, resolveTier } from '../resolve.js'
import { data, fail, info } from '../output.js'
import { waitForAction } from '../wait.js'

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
    wait?: boolean
}

export async function create(group: 'database' | 'cache', opts: CreateOptions): Promise<void> {
    if (opts.storage)
        fail(
            '--storage is not supported. Storage starts at what the plan includes; ' +
                'grow it afterwards with `zektor storage resize`.'
        )

    if (!opts.name) fail('--name is required.')

    const tiers = await api.listTiers()

    if (!opts.tier)
        fail(
            `--tier is required. ${group === 'database' ? 'Database' : 'Cache'} plans: ${options(
                tiers.filter((t) => t.productGroup === group).map((t) => `${t.name} (€${t.monthlyPriceEur}/mo)`)
            )}`
        )

    const tier = resolveTier(tiers, group, opts.tier)
    const dockerImageId = resolveEngine(tier, opts.engine)

    // The API has no default region, so asking here beats its 400.
    const locations = await api.listLocations()

    if (!opts.region)
        fail(
            `--region is required. Available regions: ${options(
                locations.filter((l) => l.rentingAvailable).map((l) => `${l.name} (${l.city})`)
            )}`
        )

    const location = resolveLocation(locations, opts.region)

    const result = await api.createInstance({
        name: opts.name,
        location,
        priceId: tier.id,
        dockerImageId,
    })

    // Provisioning is asynchronous and takes under a minute; say so rather than
    // implying the instance is ready to connect to.
    if (!opts.json) info(`Creating ${opts.name} (#${result.instanceId}) on ${tier.name}.`)

    if (opts.wait) {
        await waitForAction(result.actionId, `Creating ${opts.name}`)
        if (!opts.json) info(`${opts.name} is ready.`)
    }

    if (opts.json) {
        data({ instanceId: result.instanceId, actionId: result.actionId, name: opts.name }, true)
        return
    }

    data(String(result.instanceId), false)
}
