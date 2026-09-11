import { createInterface } from 'node:readline/promises'
import { api } from '../api.js'
import { data, fail, info } from '../output.js'

/**
 * `zektor scale <id> --tier=<plan>`.
 *
 * The API wants a direction as well as a target, and the dashboard derives it by
 * comparing monthly price. We do the same rather than inventing our own rule, so
 * an "upgrade" means the same thing in both places.
 */
export async function scale(
    id: string,
    opts: { tier?: string; yes?: boolean; json?: boolean }
): Promise<void> {
    if (!opts.tier) fail('--tier is required. Run with a wrong value to see the available plans.')

    const instance = await api.getInstance(id)
    const current = instance.pricingTier

    if (!current) fail(`Cannot read the current plan for ${instance.name}.`)

    const group = current.productGroup
    const tiers = (await api.listTiers()).filter((t) => t.productGroup === group)

    const slug = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '-')
    const target = tiers.find((t) => slug(t.name) === slug(opts.tier!))

    if (!target)
        fail(
            `Unknown ${group} plan "${opts.tier}". Available: ${
                tiers.map((t) => t.name).join(', ') || '(none)'
            }`
        )

    if (target.id === current.id)
        fail(`${instance.name} is already on ${current.name}.`)

    // Matches the dashboard: equal price counts as scaling up, so a sideways
    // move is not treated as a downgrade.
    const upScale = target.monthlyPriceEur >= current.monthlyPriceEur
    const direction = upScale ? 'Upgrading' : 'Downgrading'

    if (!opts.yes) {
        if (!process.stdin.isTTY)
            fail('Refusing to scale without a terminal to confirm at. Pass --yes if you mean it.')

        const rl = createInterface({ input: process.stdin, output: process.stderr })

        // Downgrades are the dangerous direction: less memory or storage than the
        // instance may currently be using, so name that rather than asking a bland
        // "are you sure".
        const warning = upScale
            ? ''
            : '\nThis reduces the resources available to a running instance. If it is using more ' +
              'than the smaller plan provides, that is a problem you will meet during the move.\n'

        const answer = await rl.question(
            `${warning}${direction} ${instance.name} from ${current.name} (€${current.monthlyPriceEur}/mo) ` +
                `to ${target.name} (€${target.monthlyPriceEur}/mo). Type the instance name to confirm: `
        )
        rl.close()

        if (answer.trim() !== instance.name) fail('Name did not match. Nothing was changed.')
    }

    const action = await api.scaleInstance(id, target.id, upScale, current.product)

    if (opts.json) {
        data({ instanceId: instance.id, actionId: action.id, from: current.name, to: target.name, upScale }, true)
        return
    }

    info(`${direction} ${instance.name}: ${current.name} → ${target.name}. Watch it with \`zektor show ${id}\`.`)
}
