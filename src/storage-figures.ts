import { api, ApiError, type ActionResult, type Instance, type PricingTier, type StorageSettings } from './api.js'

/**
 * Storage sizes, prices and checks, shared by `zektor storage`, `zektor scale` and the
 * MCP server so the three never disagree.
 *
 * The API bills, and sends what it bills now. What is computed here is a preview of a
 * grow or a plan change. The rate comes from the plan, never from this file, so a plan
 * without one (an API before 3.23) yields no figure rather than a guessed one.
 */

/** The API's own ceiling, for an API that doesn't send it. */
const MAX_GB = 1000

/** The API's refusal for a database created before growable storage, word for word. */
export const LEGACY_STORAGE =
    "This database's storage can't grow yet: it was created before growable storage existed, " +
    'and is moving there soon. Contact support if you need more space now.'

const NOT_ON_ACCOUNT = "Growing storage isn't available on this account yet."

/** Megabytes in whole GB, as billing counts them: part of a GB is a GB. */
export const wholeGb = (mb?: number | null) => (mb == null ? undefined : Math.ceil(mb / 1024))

/** The storage a plan includes. */
export const includedGb = (tier?: PricingTier) => wholeGb(tier?.storageMb) ?? 0

/** A database's storage size: its limit, or what its plan includes while it has none. */
export const sizeGb = (i: Instance) => wholeGb(i.dbStorageLimitMb) ?? includedGb(i.pricingTier)

/** Net €/month for `gb` of storage on `tier`, above what it includes. Undefined when the plan has no rate. */
export function abovePlanEur(gb: number, tier?: PricingTier): number | undefined {
    const rate = tier?.storageGbMonthlyPriceEur
    if (rate == null) return undefined

    return Math.round(Math.max(0, gb - includedGb(tier)) * rate * 100) / 100
}

/** Net €/month above the plan once grown to `size`. A branch clone's bill follows what it writes, not its size. */
export const abovePlanAfterGrow = (i: Instance, size: number) =>
    i.storageBilledOnWrittenData ? i.storageAbovePlanMonthlyEur : abovePlanEur(size, i.pricingTier)

/**
 * What storage is billed on: its size, a branch clone's own written data, or nothing
 * (a legacy database). Undefined on an API before 3.23.
 */
export function billedOn(i: Instance): 'size' | 'written' | 'none' | undefined {
    if (i.storageBilledGb === undefined) return undefined
    if (i.storageBilledOnWrittenData) return 'written'

    return i.storageBilledGb === 0 ? 'none' : 'size'
}

/** Money as it is written: two decimals. */
export const eur = (amount: number) => amount.toFixed(2)

/**
 * Grows a database's storage to `size` GB. What the API would refuse anyway is refused
 * here first, in its words, so a grow that can't happen sends nothing.
 *
 * `beforeRequest` runs once those checks pass, just before the request. The CLI prints
 * what the grow costs there, so it never prices a grow it then refuses.
 */
export async function growStorage(i: Instance, size: number, beforeRequest?: () => void): Promise<ActionResult> {
    if (i.storageGrowable === false) throw new Error(i.canBranch === false ? LEGACY_STORAGE : NOT_ON_ACCOUNT)

    const current = sizeGb(i)
    if (size <= current) throw new Error(`Storage can only grow, and it is ${current} GB now. Choose a larger size.`)

    const max = i.storageMaxGb ?? MAX_GB
    if (size > max) throw new Error(`Storage can grow to at most ${max} GB.`)

    beforeRequest?.()

    try {
        return await api.growStorage(i.id, size)
    } catch (error) {
        // The instance was just read with the same token, so a 404 is about the route:
        // growing is off for this account, or the API predates it. Never "No instance #N".
        if (error instanceof ApiError && error.status === 404)
            throw new Error(
                i.storageGrowable === undefined
                    ? "This API doesn't support growing storage yet: it predates growable storage."
                    : NOT_ON_ACCOUNT
            )

        throw error
    }
}

/**
 * Refuses automatic-growth settings the API would refuse, in its words, before sending
 * them. Turning it on needs a limit above the current size, sent now or set before.
 */
export function checkAutoGrow(i: Instance, settings: StorageSettings): void {
    const size = sizeGb(i)
    const limit = settings.autoScalingLimitGb
    const max = i.storageMaxGb ?? MAX_GB

    if (limit !== undefined && limit < size)
        throw new Error(`Auto scaling limit must be at least ${size}GB (current limit)`)

    if (limit !== undefined && limit > max) throw new Error(`Auto scaling limit can only be up to ${max}GB`)

    if (settings.enableAutoScale && (limit ?? i.autoScalingLimitGb ?? 0) <= size)
        throw new Error(`Set a maximum size above the current ${size} GB to turn on automatic growth.`)
}
