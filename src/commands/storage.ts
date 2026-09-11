import { api, type Instance } from '../api.js'
import { data, fail, info } from '../output.js'

/**
 * Storage commands. Postgres only — a cache has no volume of its own, and the
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

const gb = (mb?: number) => (mb === undefined ? undefined : Math.round((mb / 1024) * 10) / 10)

/** `zektor storage show <id>` — size, usage and the autoscaling rules. */
export async function storageShow(id: string, opts: { json?: boolean }): Promise<void> {
    const instance = await postgresInstance(id)
    const volume = instance.volumes?.[0]

    if (opts.json) {
        data(
            {
                instanceId: instance.id,
                volumeId: volume?.id ?? null,
                sizeGb: volume?.sizeInGb ?? gb(instance.dbStorageLimitMb) ?? null,
                usedGb: gb(instance.dbStorageUsedMb) ?? null,
                autoScale: instance.enableAutoScale ?? false,
                autoScaleUpOnly: instance.autoScaleUpOnly ?? false,
                autoScaleLimitGb: instance.autoScalingLimitGb ?? null,
                minimumDiskSizeGb: instance.minimumDiskSizeGb ?? null,
            },
            true
        )
        return
    }

    const size = volume?.sizeInGb ?? gb(instance.dbStorageLimitMb)
    const used = gb(instance.dbStorageUsedMb)

    const rows: [string, string][] = [
        ['size', size === undefined ? 'unknown' : `${size} GB`],
        ['used', used === undefined ? 'unknown' : `${used} GB`],
        ['autoscale', instance.enableAutoScale ? 'on' : 'off'],
        ['up only', instance.autoScaleUpOnly ? 'yes' : 'no'],
        ['limit', instance.autoScalingLimitGb ? `${instance.autoScalingLimitGb} GB` : 'none'],
        // The API never returns minimumDiskSizeGb — it appears only in the patch
        // request DTO, so a value set here cannot be read back. Reporting "none"
        // would be a lie whenever one is set.
        ['minimum', instance.minimumDiskSizeGb ? `${instance.minimumDiskSizeGb} GB` : 'not reported'],
    ]

    for (const [key, value] of rows) data(`${key.padEnd(10)} ${value}`, false)
}

/**
 * `zektor storage resize <id> --size=<gb>`.
 *
 * Creates the volume when the instance has none yet, resizes it otherwise —
 * the same branch the dashboard takes.
 */
export async function storageResize(
    id: string,
    opts: { size?: string; json?: boolean }
): Promise<void> {
    const size = Number(opts.size)

    if (!opts.size || !Number.isInteger(size) || size <= 0)
        fail('--size must be a whole number of gigabytes, e.g. --size=50.')

    const instance = await postgresInstance(id)
    const volume = instance.volumes?.[0]

    // Hetzner volumes cannot shrink. Saying so is more useful than relaying
    // whatever error the provider returns three layers down.
    if (volume && size < volume.sizeInGb)
        fail(
            `Cannot shrink storage: ${instance.name} is on ${volume.sizeInGb} GB and volumes only grow. ` +
                `Pick a size above ${volume.sizeInGb}.`
        )

    if (volume && size === volume.sizeInGb)
        fail(`${instance.name} is already at ${size} GB.`)

    const action = volume
        ? await api.resizeVolume(volume.id, size)
        : await api.createVolume(instance.id, size)

    if (opts.json) {
        data({ instanceId: instance.id, actionId: action.id, sizeGb: size, created: !volume }, true)
        return
    }

    info(
        volume
            ? `Resizing ${instance.name} from ${volume.sizeInGb} GB to ${size} GB.`
            : `Creating a ${size} GB volume for ${instance.name}.`
    )
}

/**
 * `zektor storage autoscale <id> --on|--off`.
 *
 * Only the flags given are sent, so turning autoscaling on does not silently
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

    const instance = await postgresInstance(id)

    const settings: Record<string, unknown> = {}

    if (opts.on) settings.enableAutoScale = true
    if (opts.off) settings.enableAutoScale = false

    // Takes a value rather than being a bare flag: a flag can only ever turn
    // this on, leaving no way to turn it off again.
    if (opts.upOnly !== undefined) {
        if (opts.upOnly !== 'yes' && opts.upOnly !== 'no')
            fail('--up-only must be "yes" or "no".')
        settings.autoScaleUpOnly = opts.upOnly === 'yes'
    }

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

    if (opts.min !== undefined) {
        const min = Number(opts.min)
        if (!Number.isInteger(min) || min <= 0)
            fail(
                opts.min === 'none'
                    ? 'The API cannot clear a floor once set — it treats an omitted value as "no change". Set a new number instead.'
                    : '--min must be a whole number of gigabytes.'
            )
        settings.minimumDiskSizeGb = min
    }

    if (Object.keys(settings).length === 0)
        fail('Nothing to change. Pass --on, --off, --limit, --min or --up-only.')

    await api.updateStorageSettings(id, settings)

    if (opts.json) {
        data({ instanceId: instance.id, applied: settings }, true)
        return
    }

    info(`Updated storage settings for ${instance.name}.`)
    await storageShow(id, {})
}
