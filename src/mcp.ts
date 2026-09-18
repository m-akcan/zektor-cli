import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { api, type Instance } from './api.js'
import { resolveApiUrl, resolveToken, tokenIsFromEnv } from './config.js'
import { VERSION } from './version.js'
import { imageVersion, resolveEngine, resolveLocation, resolveTier } from './resolve.js'

/**
 * `zektor mcp` — the same API as the CLI, exposed to an MCP client.
 *
 * Three rules govern everything in this file:
 *
 * 1. **stdout is the protocol.** On a stdio transport, every byte written to
 *    stdout is parsed as JSON-RPC. A stray `console.log` — ours or a
 *    dependency's — corrupts the stream and the client drops the connection with
 *    a parse error that points nowhere near the cause. Nothing here may import
 *    `output.ts`; diagnostics go to stderr, which clients collect as logs.
 *
 * 2. **A handler never throws and never exits.** `fail()` calls `process.exit`,
 *    which would kill the connection mid-request. Errors come back as tool
 *    results so the model can read them and correct itself — a wrong plan name
 *    returns the list of real ones, exactly as it does on the command line.
 *
 * 3. **The caller is a model, so the guardrails cannot be prompts.** The CLI
 *    asks you to type an instance name at a TTY; there is no TTY here. The
 *    translation is `confirm_name`: a required argument that can only be filled
 *    in correctly by having actually looked the instance up. Deletion is off
 *    unless ZEKTOR_MCP_ALLOW_DESTRUCTIVE is set, so the worst an injected
 *    instruction achieves by default is spending money, not losing data.
 */

/** Deletion is opt-in, read once at startup so the tool list tells the truth. */
const allowDestructive = process.env.ZEKTOR_MCP_ALLOW_DESTRUCTIVE === '1'

type ToolResult = {
    content: { type: 'text'; text: string }[]
    isError?: boolean
    structuredContent?: Record<string, unknown>
}

/**
 * Runs a handler and turns any failure into a readable tool error.
 *
 * `ApiError` and `ResolutionError` already carry messages written for a person,
 * so they pass straight through; anything else is stringified rather than
 * escaping into the transport.
 */
async function guarded(run: () => Promise<unknown>): Promise<ToolResult> {
    try {
        const value = await run()
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return { content: [{ type: 'text', text }] }
    } catch (error) {
        return {
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
            isError: true,
        }
    }
}

/** Accepts 44 and "44" alike — clients differ on how they type an id. */
const instanceId = z.coerce
    .number()
    .int()
    .positive()
    .describe('Instance id, as returned by list_instances')

const confirmName = z
    .string()
    .describe(
        'The exact instance name, as a guard against acting on the wrong one. ' +
            'Call get_instance first and copy it from there.'
    )

const gb = (mb?: number) => (mb === undefined ? undefined : Math.round((mb / 1024) * 10) / 10)

/**
 * The list view. Full instances carry their whole pricing tier including every
 * docker image, which is a lot of context to spend on "which ones do I have".
 *
 * `connectionString` is dropped on purpose. The CLI's `show` withholds it for
 * the same reason — it contains a live password, and a credential should arrive
 * only from the call that exists to fetch one, never as a side effect of asking
 * what is running.
 */
const summarise = (i: Instance) => ({
    id: i.id,
    name: i.name,
    status: i.status,
    engine: i.pricingTier?.product ?? null,
    plan: i.pricingTier?.name ?? null,
    location: i.location ?? null,
})

const detail = (i: Instance) => ({
    ...summarise(i),
    port: i.port ?? null,
    createdAt: i.createdAt ?? null,
    monthlyPriceEur: i.pricingTier?.monthlyPriceEur ?? null,
    productGroup: i.pricingTier?.productGroup ?? null,
    storage: i.volumes?.length || i.dbStorageLimitMb !== undefined ? storage(i) : undefined,
    hint: 'Connection details, including any password, come from get_connection.',
})

function storage(i: Instance) {
    return {
        sizeGb: i.volumes?.[0]?.sizeInGb ?? gb(i.dbStorageLimitMb) ?? null,
        usedGb: gb(i.dbStorageUsedMb) ?? null,
        volumeId: i.volumes?.[0]?.id ?? null,
        autoScale: i.enableAutoScale ?? false,
        autoScaleUpOnly: i.autoScaleUpOnly ?? false,
        autoScalingLimitGb: i.autoScalingLimitGb ?? null,
        // Three states, not two. Older backends omit the field entirely — it was
        // settable while being absent from the read DTO — and there a flat null
        // would read as "no minimum" when one may well be set.
        minimumDiskSizeGb:
            i.minimumDiskSizeGb === undefined ? 'not reported by this API version' : i.minimumDiskSizeGb,
    }
}

/** Storage is a Postgres concept; a cache is sized by its plan and has no volume. */
async function postgresInstance(id: number): Promise<Instance> {
    const instance = await api.getInstance(id)
    const product = instance.pricingTier?.product

    if (product && product !== 'postgres')
        throw new Error(
            `${instance.name} runs ${product}. Storage is configurable on Postgres instances only — ` +
                'a cache is sized by its plan, so use scale_instance instead.'
        )

    return instance
}

export async function startMcpServer(): Promise<void> {
    // Belt and braces for rule 1. Anything that reaches for console.log — a
    // dependency, a future edit here — lands on stderr instead of corrupting the
    // JSON-RPC stream, which fails in a way that is very hard to diagnose.
    console.log = console.error
    console.info = console.error

    const server = new McpServer(
        { name: 'zektor', version: VERSION },
        {
            instructions:
                'Manages Zektor.io databases (PostgreSQL) and caches (Valkey/Redis).\n\n' +
                'Instances are addressed by numeric id — call list_instances to find one. ' +
                'A plan ("pricing tier") fixes the engine, memory, storage and price, so ' +
                'creating an instance means choosing a plan with list_plans rather than ' +
                'specifying resources individually. Provisioning is asynchronous and takes ' +
                'about a minute; create_instance returns as soon as the work is queued, and ' +
                'the instance is usable when its status reads "active".\n\n' +
                'Storage tools apply to PostgreSQL only. PostgreSQL passwords are never ' +
                'retrievable: they are shown once when a role is created or rotated and are ' +
                'not stored, so get_connection returns a usable connection string for caches ' +
                'but only host and port for PostgreSQL.',
        }
    )

    server.registerTool(
        'whoami',
        {
            title: 'Show the authenticated account',
            description:
                'Reports which Zektor account the current token belongs to, the API it is ' +
                'talking to, and whether the token came from the environment or the config file.',
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () =>
            guarded(async () => {
                const me = await api.me()

                // Picked field by field, never spread. `/api/auth/me` returns the
                // whole customer record — account credit, VAT number, billing
                // address, payment method — and the `Me` interface describes only
                // the three fields we read, so a spread would quietly hand all of
                // it to the model. TypeScript cannot catch that: the interface is
                // a subset of the response by design, not a guarantee of shape.
                return {
                    id: me.id,
                    email: me.email,
                    role: me.role,
                    apiUrl: resolveApiUrl(),
                    tokenSource: tokenIsFromEnv() ? 'ZEKTOR_TOKEN' : 'config file',
                }
            })
    )

    server.registerTool(
        'list_instances',
        {
            title: 'List instances',
            description:
                'Every database and cache on the account, with id, name, status, engine and plan.',
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () => guarded(async () => (await api.listInstances()).map(summarise))
    )

    server.registerTool(
        'get_instance',
        {
            title: 'Get one instance',
            description:
                'Full detail for a single instance, including storage and autoscaling where it ' +
                'applies. Does not include credentials — use get_connection for those.',
            inputSchema: { id: instanceId },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ id }) => guarded(async () => detail(await api.getInstance(id)))
    )

    server.registerTool(
        'list_plans',
        {
            title: 'List available plans',
            description:
                'The plans an instance can be created on or scaled to, with price, engine, ' +
                'memory, storage and the engine versions each one can run. Call this before ' +
                'create_instance or scale_instance rather than guessing a plan name.',
            inputSchema: {
                group: z
                    .enum(['database', 'cache'])
                    .optional()
                    .describe('Restrict to databases or caches. Omit for both.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ group }) =>
            guarded(async () => {
                const tiers = await api.listTiers()
                return tiers
                    .filter((t) => !group || t.productGroup === group)
                    .map((t) => ({
                        name: t.name,
                        group: t.productGroup,
                        engine: t.product,
                        monthlyPriceEur: t.monthlyPriceEur,
                        memoryGb: gb(t.memoryMb ?? undefined) ?? null,
                        storageGb: gb(t.storageMb ?? undefined) ?? null,
                        // Parsed, not the raw `valkey/valkey:9-alpine` reference —
                        // these are the values create_instance's `engine` accepts,
                        // and handing back something it would reject is a trap.
                        engineVersions: [
                            ...new Set(t.dockerImages.map((i) => imageVersion(i.version))),
                        ],
                    }))
            })
    )

    server.registerTool(
        'list_regions',
        {
            title: 'List regions',
            description:
                'Regions an instance can be created in. `available` is false where there is no ' +
                'capacity right now; creating there will be refused.',
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () =>
            guarded(async () =>
                (await api.listLocations()).map((l) => ({
                    name: l.name,
                    city: l.city,
                    country: l.country,
                    available: l.rentingAvailable,
                }))
            )
    )

    server.registerTool(
        'get_connection',
        {
            title: 'Get connection details',
            description:
                'RETURNS A LIVE CREDENTIAL for caches: the connection string includes the ' +
                'password. Treat the result as a secret and do not repeat it anywhere it would ' +
                'be stored or logged.\n\n' +
                'For PostgreSQL there is no password to return — one is shown only when a role ' +
                'is created, and the server does not keep it — so the result carries host, port ' +
                'and database. Use create_ephemeral_role to obtain a usable credential.',
            inputSchema: { id: instanceId },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ id }) =>
            guarded(async () => {
                const instance = await api.getInstance(id)

                if (instance.status !== 'active')
                    throw new Error(
                        `${instance.name} is ${instance.status}, not active. ` +
                            'Connection details exist once provisioning has finished.'
                    )

                const connection = await api.getConnection(id)

                if (connection.type === 'postgres' || !connection.connectionString)
                    return {
                        engine: connection.type ?? 'postgres',
                        host: connection.host,
                        port: connection.port ?? instance.port,
                        database: connection.databaseName ?? connection.database ?? null,
                        username: connection.username ?? null,
                        password: null,
                        connectionString: null,
                        note:
                            'PostgreSQL passwords are not stored and cannot be read back. Call ' +
                            'create_ephemeral_role on this instance to mint a temporary one that ' +
                            'returns a usable connection string and removes itself afterwards.',
                    }

                return {
                    engine: connection.type ?? null,
                    host: connection.host,
                    port: connection.port,
                    connectionString: connection.connectionString,
                }
            })
    )

    server.registerTool(
        'create_instance',
        {
            title: 'Create an instance',
            description:
                'Provisions a database or cache. THIS COSTS MONEY — the plan is billed monthly ' +
                'from creation until the instance is deleted.\n\n' +
                'Storage is not a parameter: it comes with the plan. Provisioning is ' +
                'asynchronous, so this returns an instance id immediately and the instance ' +
                'becomes usable when get_instance reports status "active".',
            inputSchema: {
                group: z.enum(['database', 'cache']).describe('database for PostgreSQL, cache for Valkey/Redis'),
                name: z.string().min(1).describe('Instance name'),
                tier: z.string().describe('Plan name from list_plans, e.g. AKPG-5'),
                region: z.string().optional().describe('Region name or city from list_regions. Omit for the default.'),
                engine: z
                    .string()
                    .optional()
                    .describe('Engine version, e.g. "postgres@17" or just "17". Omit for the default.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ group, name, tier, region, engine }) =>
            guarded(async () => {
                const plan = resolveTier(await api.listTiers(), group, tier)

                // A bare "17" is a version, not an engine name. The CLI gets the
                // engine for free from the `product@version` grammar; here the
                // field is free text, so accept both spellings.
                const dockerImageId = resolveEngine(
                    plan,
                    engine && !engine.includes('@') ? `${plan.product}@${engine}` : engine
                )

                const location = region ? resolveLocation(await api.listLocations(), region) : undefined

                const result = await api.createInstance({
                    name,
                    location,
                    priceId: plan.id,
                    dockerImageId,
                })

                return {
                    instanceId: result.instanceId,
                    name,
                    plan: plan.name,
                    monthlyPriceEur: plan.monthlyPriceEur,
                    status: 'provisioning',
                    note: 'Provisioning takes about a minute. Poll get_instance until status is "active".',
                }
            })
    )

    server.registerTool(
        'scale_instance',
        {
            title: 'Move an instance to another plan',
            description:
                'Changes the plan an instance runs on, which changes what it costs. ' +
                'Scaling DOWN reduces the memory and storage available to a running instance; ' +
                'if it is using more than the smaller plan provides, that becomes a problem ' +
                'during the move. Check current usage with get_instance first.',
            inputSchema: {
                id: instanceId,
                tier: z.string().describe('Target plan name from list_plans'),
                confirm_name: confirmName,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
        async ({ id, tier, confirm_name }) =>
            guarded(async () => {
                const instance = await api.getInstance(id)

                if (confirm_name !== instance.name)
                    throw new Error(
                        `confirm_name "${confirm_name}" does not match instance #${id}, which is ` +
                            `"${instance.name}". Nothing was changed.`
                    )

                const current = instance.pricingTier
                if (!current) throw new Error(`Cannot read the current plan for ${instance.name}.`)

                const target = resolveTier(await api.listTiers(), current.productGroup, tier)

                if (target.id === current.id)
                    throw new Error(`${instance.name} is already on ${current.name}.`)

                // Matches the dashboard: equal price counts as scaling up, so a
                // sideways move is not treated as a downgrade.
                const upScale = target.monthlyPriceEur >= current.monthlyPriceEur

                await api.scaleInstance(id, target.id, upScale, current.product)

                return {
                    instanceId: instance.id,
                    from: current.name,
                    to: target.name,
                    direction: upScale ? 'up' : 'down',
                    monthlyPriceEur: target.monthlyPriceEur,
                    note: 'Scaling is asynchronous. Watch get_instance for the new plan.',
                }
            })
    )

    server.registerTool(
        'create_ephemeral_role',
        {
            title: 'Create a temporary PostgreSQL login',
            description:
                'RETURNS A LIVE CREDENTIAL. Creates a PostgreSQL role that stops working by ' +
                'itself after ttl_seconds and is then removed.\n\n' +
                'This is the way to connect to a PostgreSQL instance: passwords are never ' +
                'stored, so get_connection cannot return one. The expiry is enforced by ' +
                'PostgreSQL itself, so the credential dies on time whether or not anything ' +
                'else is running.\n\n' +
                'The password is returned once and exists nowhere else. Treat it as a secret ' +
                'and do not repeat it anywhere it would be stored or logged.',
            inputSchema: {
                id: instanceId,
                ttl_seconds: z.coerce
                    .number()
                    .int()
                    .min(60)
                    .max(86400)
                    .default(3600)
                    .describe('How long the credential lives, 60s to 24h. Defaults to one hour.'),
                name: z
                    .string()
                    .optional()
                    .describe('Label for the role. Defaults to a generated one.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ id, ttl_seconds, name }) =>
            guarded(async () => {
                const instance = await api.getInstance(id)

                if (instance.pricingTier?.product !== 'postgres')
                    throw new Error(
                        `${instance.name} runs ${instance.pricingTier?.product ?? 'an unknown engine'}. ` +
                            'Ephemeral roles are a PostgreSQL feature — for a cache, get_connection ' +
                            'already returns a usable connection string.'
                    )

                if (instance.status !== 'active')
                    throw new Error(
                        `${instance.name} is ${instance.status}, not active. Roles can be created ` +
                            'once provisioning has finished.'
                    )

                // Unique by default. A fixed name collides on the second call, and a model
                // retrying a failed step should not get "a role named agent already exists".
                const roleName = name ?? `agent-${Date.now().toString(36)}`

                const role = await api.createRole(id, {
                    name: roleName,
                    expiresInSeconds: ttl_seconds,
                })

                // A backend that predates expiring roles ignores expiresInSeconds rather
                // than rejecting it — ASP.NET drops unknown JSON fields — and hands back a
                // PERMANENT credential. Reporting a TTL we did not get is the worst
                // possible outcome here, so say so loudly and name the role to delete.
                if (role.expiresAt === null)
                    throw new Error(
                        `Role ${role.name} (id ${role.roleId}) was created WITHOUT an expiry: ` +
                            'this API does not support ephemeral roles yet, and silently ignored ' +
                            'the TTL. The credential is permanent — delete the role and upgrade ' +
                            'the backend before relying on this tool.'
                    )

                return {
                    instanceId: instance.id,
                    roleId: role.roleId,
                    name: role.name,
                    user: role.user,
                    host: role.host,
                    port: role.port,
                    password: role.password,
                    connectionString: role.connectionString,
                    expiresAt: role.expiresAt,
                    note:
                        'Shown once and not recoverable. PostgreSQL refuses this password after ' +
                        'expiresAt, so long-running work should mint a fresh one rather than ' +
                        'caching this past its expiry.',
                }
            })
    )

    server.registerTool(
        'get_storage',
        {
            title: 'Show storage and autoscaling',
            description: 'Size, usage and autoscaling settings for a PostgreSQL instance.',
            inputSchema: { id: instanceId },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ id }) =>
            guarded(async () => {
                const instance = await postgresInstance(id)
                return { instanceId: instance.id, name: instance.name, ...storage(instance) }
            })
    )

    server.registerTool(
        'resize_storage',
        {
            title: 'Grow storage',
            description:
                'Grows the volume of a PostgreSQL instance, creating one if it has none. ' +
                'ONE WAY: volumes cannot shrink, so the new size is a floor on what the ' +
                'instance costs from now on. Creates the volume when the instance has none yet.',
            inputSchema: {
                id: instanceId,
                size_gb: z.coerce.number().int().positive().describe('New size in whole gigabytes'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ id, size_gb }) =>
            guarded(async () => {
                const instance = await postgresInstance(id)
                const volume = instance.volumes?.[0]

                if (volume && size_gb < volume.sizeInGb)
                    throw new Error(
                        `Cannot shrink storage: ${instance.name} is on ${volume.sizeInGb} GB and ` +
                            `volumes only grow. Pick a size above ${volume.sizeInGb}.`
                    )

                if (volume && size_gb === volume.sizeInGb)
                    throw new Error(`${instance.name} is already at ${size_gb} GB.`)

                await (volume ? api.resizeVolume(volume.id, size_gb) : api.createVolume(instance.id, size_gb))

                return {
                    instanceId: instance.id,
                    sizeGb: size_gb,
                    created: !volume,
                    previousSizeGb: volume?.sizeInGb ?? null,
                }
            })
    )

    server.registerTool(
        'set_autoscale',
        {
            title: 'Configure storage autoscaling',
            description:
                'Turns autoscaling on or off for a PostgreSQL instance and sets its bounds. ' +
                'Only the fields you pass are sent, so changing one setting leaves the others ' +
                'alone. Note that a bound cannot be cleared once set — the API reads an omitted ' +
                'field as "no change" — so it can only be moved to a different number.',
            inputSchema: {
                id: instanceId,
                enabled: z.boolean().optional().describe('Turn autoscaling on or off'),
                limit_gb: z.coerce.number().int().positive().optional().describe('Ceiling, in gigabytes'),
                minimum_gb: z.coerce.number().int().positive().optional().describe('Floor, in gigabytes'),
                up_only: z
                    .boolean()
                    .optional()
                    .describe('true to grow only; false to allow automatic shrinking'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async ({ id, enabled, limit_gb, minimum_gb, up_only }) =>
            guarded(async () => {
                const instance = await postgresInstance(id)

                const settings: Record<string, unknown> = {}
                if (enabled !== undefined) settings.enableAutoScale = enabled
                if (up_only !== undefined) settings.autoScaleUpOnly = up_only
                if (limit_gb !== undefined) settings.autoScalingLimitGb = limit_gb
                if (minimum_gb !== undefined) settings.minimumDiskSizeGb = minimum_gb

                if (Object.keys(settings).length === 0)
                    throw new Error('Nothing to change. Pass at least one of enabled, limit_gb, minimum_gb, up_only.')

                await api.updateStorageSettings(id, settings)

                const after = await api.getInstance(id)
                return { instanceId: instance.id, applied: settings, current: storage(after) }
            })
    )

    if (allowDestructive)
        server.registerTool(
            'delete_instance',
            {
                title: 'Delete an instance',
                description:
                    'PERMANENTLY DESTROYS an instance and all of its data. There is no undo and ' +
                    'no backup taken on the way out. Confirm with the user before calling this.',
                inputSchema: { id: instanceId, confirm_name: confirmName },
                annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
            },
            async ({ id, confirm_name }) =>
                guarded(async () => {
                    const instance = await api.getInstance(id)

                    if (confirm_name !== instance.name)
                        throw new Error(
                            `confirm_name "${confirm_name}" does not match instance #${id}, which is ` +
                                `"${instance.name}". Nothing was deleted.`
                        )

                    await api.deleteInstance(id)
                    return { instanceId: instance.id, name: instance.name, deleted: true }
                })
        )

    // Startup diagnostics on stderr, where MCP clients collect them. Without
    // these, a server pointed at the wrong API or holding a stale token looks
    // identical to one that is simply broken.
    process.stderr.write(`zektor mcp: api ${resolveApiUrl()}\n`)
    process.stderr.write(
        `zektor mcp: token ${
            resolveToken() ? (tokenIsFromEnv() ? 'from ZEKTOR_TOKEN' : 'from config file') : 'MISSING — run `zektor login`'
        }\n`
    )
    process.stderr.write(
        `zektor mcp: delete_instance ${
            allowDestructive ? 'ENABLED' : 'disabled (set ZEKTOR_MCP_ALLOW_DESTRUCTIVE=1 to enable)'
        }\n`
    )

    await server.connect(new StdioServerTransport())
}
