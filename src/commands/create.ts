import { api, type PricingTier } from '../api.js'
import { data, fail, info } from '../output.js'

/**
 * `zektor db create` / `zektor cache create`.
 *
 * The flag grammar is inherited, not designed: the dashboard's creation wizard
 * renders exactly this command as an "equivalent CLI" panel, so it is a
 * specification. What the wizard does *not* show is that the API takes numeric
 * ids — `priceId`, `location`, `dockerImageId` — so every human-readable flag
 * here is resolved to one before the call.
 */

interface CreateOptions {
    name?: string
    engine?: string
    region?: string
    tier?: string
    storage?: string
    json?: boolean
}

/** `AKVK-1` and `akvk-1` should both match what the wizard prints. */
const slug = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '-')

/** Lists what the user could have said, so an error is actionable. */
const options = (values: string[]) =>
    values.length ? values.join(', ') : '(none available)'

export async function create(
    group: 'database' | 'cache',
    opts: CreateOptions
): Promise<void> {
    if (opts.storage)
        fail(
            '--storage is not supported. Storage is fixed by the plan, so choose it with --tier. ' +
                'The wizard shows a --storage flag, but its own create call does not send one.'
        )

    if (!opts.name) fail('--name is required.')
    if (!opts.tier) fail('--tier is required. Run with a wrong value to see the available plans.')

    const tiers = (await api.listTiers()).filter(
        (t) => t.productGroup === group
    )

    const tier = tiers.find((t) => slug(t.name) === slug(opts.tier!))

    if (!tier)
        fail(
            `Unknown ${group} plan "${opts.tier}". Available: ${options(tiers.map((t) => t.name))}`
        )

    const dockerImageId = resolveEngine(tier, opts.engine)

    let location: number | undefined
    if (opts.region) {
        const locations = await api.listLocations()
        const match = locations.find(
            (l) => slug(l.name) === slug(opts.region!) || slug(l.city) === slug(opts.region!)
        )

        if (!match)
            fail(
                `Unknown region "${opts.region}". Available: ${options(
                    locations.filter((l) => l.rentingAvailable).map((l) => l.name)
                )}`
            )

        if (!match.rentingAvailable)
            fail(`Region "${match.name}" has no capacity right now. Try another.`)

        location = match.id
    }

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

/**
 * `--engine=postgres@17` → the tier's docker image for version 17.
 *
 * The engine itself is implied by the plan, so a mismatch is a user error worth
 * naming rather than silently ignoring. Omitting `--engine` lets the backend
 * pick its default image.
 */
function resolveEngine(tier: PricingTier, engine?: string): number | undefined {
    if (!engine) return undefined

    const [product, version] = engine.split('@')

    if (product && slug(product) !== slug(tier.product))
        fail(
            `Plan "${tier.name}" runs ${tier.product}, not ${product}. ` +
                `Pick a ${product} plan, or drop the engine from --engine.`
        )

    if (!version) return undefined

    const image = tier.dockerImages.find((i) => i.version === version)

    if (!image)
        fail(
            `Plan "${tier.name}" cannot run ${tier.product} ${version}. ` +
                `Available: ${options(tier.dockerImages.map((i) => i.version))}`
        )

    return image.id
}
