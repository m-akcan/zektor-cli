import { api, type Instance, type StorageSettings } from '../api.js'
import { data, fail, info, warn } from '../output.js'
import {
    abovePlanAfterGrow,
    abovePlanEur,
    billedOn,
    checkAutoGrow,
    eur,
    growStorage,
    includedGb,
    sizeGb,
} from '../storage-figures.js'
import { waitForAction } from '../wait.js'

/**
 * Storage commands. Postgres only — a cache is sized by its plan, and the
 * dashboard offers no storage controls for one either.
 */

/** Refuses early rather than letting the API return something confusing. */
async function postgresInstance(id: string): Promise<Instance> {
    const instance = await api.getInstance(id)
    const product = instance.pricingTier?.product

    if (product && product !== 'postgres')
        fail(
            `${instance.name} runs ${product}. Storage is configurable on Postgres instances only — ` +
                'a cache is sized by its plan, so use `zektor scale` instead.'
        )

    return instance
}

/** Usage, to a tenth of a GB. The size is in whole GB, as it is billed. */
const gb = (mb?: number | null) => (mb == null ? undefined : Math.round((mb / 1024) * 10) / 10)

/** `zektor storage show <id>` — size, usage, what is billed, and automatic growth. */
export async function storageShow(id: string, opts: { json?: boolean }): Promise<void> {
    const instance = await postgresInstance(id)
    const size = sizeGb(instance)
    const used = gb(instance.dbStorageUsedMb)
    const included = includedGb(instance.pricingTier)
    const limit = instance.autoScalingLimitGb

    if (opts.json) {
        data(
            {
                // 1.6's keys, kept for scripts, with what is true now: there is no
                // volume, storage only grows, and nothing has a minimum.
                instanceId: instance.id,
                volumeId: null,
                sizeGb: size,
                usedGb: used ?? null,
                autoScale: instance.enableAutoScale ?? false,
                autoScaleUpOnly: true,
                autoScaleLimitGb: limit ?? null,
                minimumDiskSizeGb: null,
                includedGb: included,
                billedGb: instance.storageBilledGb ?? null,
                abovePlanGb: instance.storageAbovePlanGb ?? null,
                abovePlanMonthlyEur: instance.storageAbovePlanMonthlyEur ?? null,
                billedOn: billedOn(instance) ?? null,
                growable: instance.storageGrowable ?? null,
                maxGb: instance.storageMaxGb ?? null,
            },
            true
        )
        return
    }

    const legacy = instance.storageGrowable === false && instance.canBranch === false
    const atLimit = limit ? abovePlanEur(limit, instance.pricingTier) : undefined

    // Key, value, and an optional note after the value.
    const rows: [string, string, string?][] = [
        ['size', `${size} GB`, 'grows only, never shrinks'],
        [
            'used',
            used === undefined ? 'unknown' : `${used} GB`,
            billedOn(instance) === 'written' ? '(branch: its own written data, what it is billed on)' : undefined,
        ],
        ['included', `${included} GB`, `with ${instance.pricingTier?.name ?? 'its plan'}`],
    ]

    if (legacy)
        rows.push(['above plan', "not billed · can't grow yet: created before growable storage, moving soon"])
    else if (instance.storageAbovePlanGb === undefined || instance.storageAbovePlanMonthlyEur === undefined)
        rows.push(['above plan', 'unknown (this API predates growable storage)'])
    else
        rows.push([
            'above plan',
            `${instance.storageAbovePlanGb} GB`,
            `€${eur(instance.storageAbovePlanMonthlyEur)}/month net, prorated by the hour`,
        ])

    rows.push(
        instance.enableAutoScale
            ? [
                  'auto-grow',
                  `on, up to ${limit} GB`,
                  '(at 80% full: +5 GB or to 70% full, whichever is more' +
                      (atLimit === undefined ? ')' : `; at the limit €${eur(atLimit)}/month)`),
              ]
            : ['auto-grow', 'off', limit ? `limit ${limit} GB` : undefined]
    )

    if (instance.storageGrowable === false && !legacy) rows.push(['grow', 'not available on this account yet'])

    for (const [key, value, note] of rows)
        data(`${key.padEnd(10)} ${note ? `${value.padEnd(6)}  ${note}` : value}`, false)
}

/** What a grow costs, said before it is asked for: there is no prompt, and no way back. */
function growNotice(instance: Instance, size: number): string {
    const plan = instance.pricingTier?.name
    const included = includedGb(instance.pricingTier)
    const monthly = abovePlanEur(size, instance.pricingTier)
    const now = instance.storageAbovePlanMonthlyEur

    const cost = instance.storageBilledOnWrittenData
        ? ", free while it's a branch; if promoted it is billed on its full size."
        : monthly === undefined || now === undefined
          ? '.'
          : size <= included
            ? `. ${plan} includes ${included} GB, so it costs nothing extra.`
            : `. ${plan} includes ${included} GB; the ${size - included} GB above it cost €${eur(monthly)}/month net ` +
              `(now €${eur(now)}), prorated by the hour.`

    return (
        `Growing ${instance.name} from ${sizeGb(instance)} GB to ${size} GB${cost} ` +
        'Storage never shrinks, not even on a downgrade.'
    )
}

/**
 * `zektor storage resize <id> --size=<gb>`.
 *
 * Grows storage online, with no restart. It never shrinks, so this can't be undone,
 * but it asks nothing either: scripts that call it keep working. What the new size
 * costs goes to stderr just before the request.
 */
export async function storageResize(
    id: string,
    opts: { size?: string; json?: boolean; wait?: boolean }
): Promise<void> {
    const size = Number(opts.size)

    if (!opts.size || !Number.isInteger(size) || size <= 0)
        fail('--size must be a whole number of gigabytes, e.g. --size=50.')

    const instance = await postgresInstance(id)

    const action = await growStorage(instance, size, () => {
        if (!opts.json) info(growNotice(instance, size))
    })

    if (opts.wait) {
        await waitForAction(action.id, `Growing ${instance.name} to ${size} GB`)
        if (!opts.json) info(`${instance.name} now has ${size} GB of storage.`)
    }

    if (opts.json)
        data(
            {
                instanceId: instance.id,
                actionId: action.id,
                sizeGb: size,
                previousSizeGb: sizeGb(instance),
                abovePlanMonthlyEur: abovePlanAfterGrow(instance, size) ?? null,
                created: false,
            },
            true
        )
}

/**
 * `zektor storage autoscale <id> --on|--off [--limit=<gb>]`.
 *
 * Only the flags given are sent, so turning automatic growth on does not silently
 * reset a limit somebody set in the dashboard.
 */
export async function storageAutoscale(
    id: string,
    opts: {
        on?: boolean
        off?: boolean
        limit?: string
        min?: string
        upOnly?: string
        json?: boolean
    }
): Promise<void> {
    if (opts.on && opts.off) fail('Pass either --on or --off, not both.')

    // Still parsed, so 1.6 scripts keep running. Storage only grows, so neither means anything now.
    if (opts.min !== undefined || opts.upOnly !== undefined)
        warn('--min and --up-only are ignored: storage only grows.')

    const instance = await postgresInstance(id)

    const settings: StorageSettings = {}

    if (opts.on) settings.enableAutoScale = true
    if (opts.off) settings.enableAutoScale = false

    // No "none": the API tests each field with HasValue, so null means "leave
    // unchanged", not "clear". Accepting none would silently do nothing.
    if (opts.limit !== undefined) {
        const limit = Number(opts.limit)
        if (!Number.isInteger(limit) || limit <= 0)
            fail(
                opts.limit === 'none'
                    ? 'The API cannot clear a ceiling once set — it treats an omitted value as "no change". Set a new number instead.'
                    : '--limit must be a whole number of gigabytes.'
            )
        settings.autoScalingLimitGb = limit
    }

    if (Object.keys(settings).length === 0) fail('Nothing to change. Pass --on, --off or --limit.')

    checkAutoGrow(instance, settings)

    const after = await api.updateStorageSettings(id, settings)

    if (opts.json) {
        data({ instanceId: instance.id, applied: settings }, true)
        return
    }

    info(`Updated storage settings for ${instance.name}.`)

    if (after.enableAutoScale) {
        const limit = after.autoScalingLimitGb
        const atLimit = limit ? abovePlanEur(limit, after.pricingTier) : undefined

        info(
            `Automatic growth is on: at 80% full it grows to the larger of +5 GB or 70% full, never above ${limit} GB. ` +
                "Each grow is permanent and billed like a manual one, and you're notified each time."
        )
        if (atLimit !== undefined) info(`at the limit: €${eur(atLimit)}/month net above the plan`)
    }

    await storageShow(id, {})
}
