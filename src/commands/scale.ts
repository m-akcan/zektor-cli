import { api } from '../api.js'
import { resolveTier } from '../resolve.js'
import { ask, data, fail, info, warn } from '../output.js'
import { eur, includedGb, sizeGb, storageOnPlan } from '../storage-figures.js'
import { waitForAction } from '../wait.js'

/**
 * `zektor scale <id> --tier=<plan>`.
 *
 * The API wants a direction as well as a target, and the dashboard derives it by
 * comparing monthly price. We do the same rather than inventing our own rule, so
 * an "upgrade" means the same thing in both places.
 */
export async function scale(
    id: string,
    opts: { tier?: string; yes?: boolean; json?: boolean; wait?: boolean }
): Promise<void> {
    if (!opts.tier) fail('--tier is required. Run with a wrong value to see the available plans.')

    const instance = await api.getInstance(id)
    const current = instance.pricingTier

    if (!current) fail(`Cannot read the current plan for ${instance.name}.`)

    const target = resolveTier(await api.listTiers(), current.productGroup, opts.tier)

    if (target.id === current.id)
        fail(`${instance.name} is already on ${current.name}.`)

    // Matches the dashboard: equal price counts as scaling up, so a sideways
    // move is not treated as a downgrade.
    const upScale = target.monthlyPriceEur >= current.monthlyPriceEur
    const direction = upScale ? 'Upgrading' : 'Downgrading'

    // Storage never shrinks, so what is billed now stays billed against what the
    // target plan includes. Said whatever the flags: --yes skips only the question.
    const storageCost = storageOnPlan(instance, target)

    if (storageCost && storageCost.eur > 0) {
        const included = includedGb(target)
        const monthly = `€${eur(storageCost.eur)}/month net`

        warn(
            `Storage stays at ${sizeGb(instance)} GB: it never shrinks. ` +
                (instance.storageBilledOnWrittenData
                    ? `As a branch it is billed on what it writes: ${storageCost.gb} GB above ${target.name}'s ${included} GB, ${monthly}. `
                    : `${target.name} includes ${included} GB, so ${storageCost.gb} GB are billed on top: ${monthly}. `) +
                `Total ≈ plan €${target.monthlyPriceEur} + storage €${eur(storageCost.eur)}.`
        )
    }

    if (!opts.yes) {
        if (!process.stdin.isTTY)
            fail('Refusing to scale without a terminal to confirm at. Pass --yes if you mean it.')

        // Downgrades are the dangerous direction: less memory than the instance may
        // currently be using, so name that rather than asking a bland "are you sure".
        const warning = upScale
            ? ''
            : '\nThis reduces the memory available to a running instance. If it is using more ' +
              'than the smaller plan provides, that is a problem you will meet during the move.\n'

        const storagePrice = storageCost && storageCost.eur > 0 ? ` + €${eur(storageCost.eur)} storage` : ''

        const answer = await ask(
            `${warning}${direction} ${instance.name} from ${current.name} (€${current.monthlyPriceEur}/mo) ` +
                `to ${target.name} (€${target.monthlyPriceEur}/mo${storagePrice}). Type the instance name to confirm: `
        )

        if (answer.trim() !== instance.name) fail('Name did not match. Nothing was changed.')
    }

    const action = await api.scaleInstance(id, target.id, upScale, current.product)

    // A failed scale leaves the plan as it was, so `zektor show` alone never
    // reveals one. --wait reads the outcome from the action.
    if (!opts.json)
        info(
            `${direction} ${instance.name}: ${current.name} → ${target.name}.` +
                (opts.wait ? '' : ' It runs in the background; pass --wait to see how it ends.')
        )

    if (opts.wait) {
        await waitForAction(action.id, `${direction} ${instance.name} to ${target.name}`)
        if (!opts.json) info(`${instance.name} is now on ${target.name}.`)
    }

    if (opts.json)
        data(
            {
                instanceId: instance.id,
                actionId: action.id,
                from: current.name,
                to: target.name,
                upScale,
                storageAbovePlanGb: storageCost?.gb ?? null,
                storageMonthlyEur: storageCost?.eur ?? null,
            },
            true
        )
}
