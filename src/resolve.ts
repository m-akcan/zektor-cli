import type { Location, PricingTier } from './api.js'

/**
 * Turning the names people use into the ids the API wants.
 *
 * The dashboard speaks in names — `AKPG-5`, `nbg1`, `postgres@17` — and the API
 * takes `priceId`, `location` and `dockerImageId`. Every one of those lookups
 * used to live in `commands/create.ts` and end in `fail()`, which exits the
 * process. That is right for a CLI and fatal for the MCP server, where an exit
 * kills the stdio connection mid-request and the client sees a transport error
 * rather than the perfectly good explanation we had for it.
 *
 * So these throw. The CLI lets the throw reach its top-level handler, which
 * prints the message and exits; the MCP server turns it into a tool error.
 */

/** A name the user supplied that does not match anything. Message is user-facing. */
export class ResolutionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ResolutionError'
    }
}

/** `AKVK-1` and `akvk-1` should both match what the dashboard prints. */
export const slug = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '-')

/** Lists what the user could have said, so an error is actionable. */
export const options = (values: string[]) => (values.length ? values.join(', ') : '(none available)')

/**
 * Engine version out of a docker reference, matching what the dashboard shows.
 *
 * Images arrive fully qualified — `ghcr.io/cloudnative-pg/postgresql:17.6-standard-trixie`
 * — and per the Docker grammar the tag is what follows the final `:` only when
 * that colon comes after the final `/`; otherwise it is a registry port. Ported
 * from `lib/utils/docker-image.ts` so every surface names versions identically.
 */
export function imageVersion(image?: string | null): string {
    if (!image) return ''

    const lastColon = image.lastIndexOf(':')
    const lastSlash = image.lastIndexOf('/')
    const tag = lastColon > lastSlash ? image.slice(lastColon + 1) : ''

    if (!tag) return image

    return tag.match(/^\d+(?:\.\d+)*/)?.[0] ?? tag
}

/** Plan by name, within one product group, listing the alternatives on a miss. */
export function resolveTier(tiers: PricingTier[], group: string, name: string): PricingTier {
    const withinGroup = tiers.filter((t) => t.productGroup === group)
    const tier = withinGroup.find((t) => slug(t.name) === slug(name))

    if (!tier)
        throw new ResolutionError(
            `Unknown ${group} plan "${name}". Available: ${options(withinGroup.map((t) => t.name))}`
        )

    return tier
}

/**
 * `postgres@17` → the tier's docker image id, or undefined to take the default.
 *
 * Accepts a major version as shorthand: `17` matches `17.6`, because that is how
 * people say it and the dashboard offers one option per parsed version anyway.
 * Requiring `@17.6` would mean reading the image reference to type the flag.
 *
 * The engine itself is implied by the plan, so a mismatch is a user error worth
 * naming rather than ignoring.
 */
export function resolveEngine(tier: PricingTier, engine?: string): number | undefined {
    if (!engine) return undefined

    const [product, version] = engine.split('@')

    if (product && slug(product) !== slug(tier.product))
        throw new ResolutionError(
            `Plan "${tier.name}" runs ${tier.product}, not ${product}. ` +
                `Pick a ${product} plan, or drop the engine name.`
        )

    if (!version) return undefined

    const image = tier.dockerImages.find((i) => {
        const parsed = imageVersion(i.version)
        return parsed === version || parsed.startsWith(`${version}.`)
    })

    if (!image)
        throw new ResolutionError(
            `Plan "${tier.name}" cannot run ${tier.product} ${version}. ` +
                `Available: ${options(tier.dockerImages.map((i) => imageVersion(i.version)))}`
        )

    return image.id
}

/** Region by name or city. Refuses one with no capacity rather than letting the API do it. */
export function resolveLocation(locations: Location[], region: string): number {
    const match = locations.find(
        (l) => slug(l.name) === slug(region) || slug(l.city) === slug(region)
    )

    if (!match)
        throw new ResolutionError(
            `Unknown region "${region}". Available: ${options(
                locations.filter((l) => l.rentingAvailable).map((l) => l.name)
            )}`
        )

    if (!match.rentingAvailable)
        throw new ResolutionError(`Region "${match.name}" has no capacity right now. Try another.`)

    return match.id
}
