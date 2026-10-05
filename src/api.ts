import { configPath, DEFAULT_API_URL, resolveApiUrl, resolveToken, tokenIsFromEnv } from './config.js'

/**
 * Thin fetch wrapper over the handful of endpoints the CLI uses.
 *
 * The interfaces below are hand-written and describe only the fields actually
 * read, so a field appearing or vanishing server-side will not break the build —
 * it will show up at runtime. `npm run gen:api` writes the full OpenAPI types to
 * `types/` (gitignored) for checking these against the real contract; wiring
 * them in directly would pull the entire admin surface into a public package.
 */

/** Thrown for any non-2xx response, carrying the status so callers can branch. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
        this.name = 'ApiError'
    }
}

/** No credential available at all — distinct from one the server rejected. */
export class NotAuthenticatedError extends Error {
    constructor() {
        super('Not logged in. Run `zektor login`, or set ZEKTOR_TOKEN.')
        this.name = 'NotAuthenticatedError'
    }
}

interface RequestOptions {
    method?: string
    body?: unknown
    /** Use this token instead of the stored one — `login` verifies before saving. */
    token?: string
    /** Send no credential at all: the trial endpoints are for people without an account. */
    anonymous?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = options.anonymous ? undefined : (options.token ?? resolveToken())

    if (!token && !options.anonymous) throw new NotAuthenticatedError()

    const url = `${resolveApiUrl()}${path}`

    let response: Response
    try {
        response = await fetch(url, {
            method: options.method ?? 'GET',
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                'Content-Type': 'application/json',
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
    } catch (error) {
        // fetch only ever says "fetch failed"; the reason (ENOTFOUND, ECONNREFUSED, a
        // certificate error) is on its cause. The URL is named only when someone set
        // it, since a typo in ZEKTOR_API_URL is the likeliest cause then.
        const cause = (error as { cause?: { code?: string; message?: string } }).cause
        const reason = cause?.code ?? cause?.message ?? (error as Error).message
        const base = resolveApiUrl()
        const at = base === DEFAULT_API_URL ? '' : ` at ${base}`
        throw new ApiError(0, `Can't reach the Zektor API${at} (${reason}). Check your connection.`)
    }

    if (!response.ok) throw new ApiError(response.status, await describeFailure(response, path, options))

    if (response.status === 204) return undefined as T

    return (await response.json()) as T
}

/**
 * One plain sentence for a failed response, whatever its body looks like.
 *
 * The API answers with plain text, JSON carrying `message`/`error`, or an ASP.NET
 * ProblemDetails or validation body. Cloudflare and Caddy in front of it answer
 * with an HTML page or nothing at all. Only a sentence written for a person is
 * passed on: never an HTML page, a stack trace or the request's route.
 */
async function describeFailure(response: Response, path: string, options: RequestOptions): Promise<string> {
    const status = response.status
    const body = (await response.text().catch(() => '')).trim()
    const html = /html/i.test(response.headers.get('content-type') ?? '') || body.startsWith('<')

    // 502, 504 and 52x only ever come from the proxies. A 503 can be the API's own
    // ("trials are full"), so it counts as an outage only without a body of its own.
    const gateway = status === 502 || status === 504 || (status >= 520 && status <= 530)

    if (html || gateway || (status === 503 && !body))
        return `Zektor's API is not responding right now (HTTP ${status}). This is on our side; try again in a few minutes.`

    if (status === 401) return rejectedToken(options)

    const text = sentence(body)

    if (status === 403) {
        if (!text)
            return "This token isn't allowed to do that. If it is missing a scope, create a token that has it under Settings → Access tokens."

        // The API's own scope refusal already says where to get one.
        return /scope/i.test(text) && !/access tokens/i.test(text)
            ? `${text.replace(/([^.!?])$/, '$1.')} Create a token with that scope under Settings → Access tokens.`
            : text
    }

    // "Not found." alone is what a token pinned to another instance gets, by design.
    if (status === 404) return text && !/^not found\.?$/i.test(text) ? text : notFound(path)

    if (status === 429) {
        if (text) return text
        const seconds = Number(response.headers.get('retry-after'))
        return seconds > 0
            ? `Too many requests. Try again in ${Math.ceil(seconds / 60)} minute(s).`
            : 'Too many requests. Try again later.'
    }

    return text || `The request failed (HTTP ${status}).`
}

/** The body's message: plain text as is, JSON reduced to its one human-readable field. */
function sentence(body: string): string {
    if (!/^[{["]/.test(body)) return body

    let json: unknown
    try {
        json = JSON.parse(body)
    } catch {
        return body
    }

    if (typeof json === 'string') return json
    if (!json || typeof json !== 'object') return ''

    const fields = json as Record<string, unknown>

    for (const key of ['message', 'error', 'detail']) {
        const value = fields[key]
        if (typeof value === 'string' && value) return value
    }

    // Validation errors: nested under "errors" in ProblemDetails, at the top level
    // from BadRequest(ModelState). Either way, field name → list of messages.
    const errors = fields.errors && typeof fields.errors === 'object' ? fields.errors : fields
    for (const value of Object.values(errors))
        if (Array.isArray(value) && typeof value[0] === 'string') return value[0]

    return ''
}

/** A 401 says nothing about which token, and that is the part people get wrong. */
function rejectedToken(options: RequestOptions): string {
    if (options.token)
        return 'That token was rejected: it is invalid, expired or revoked. Check that you pasted all of it, or create a new one under Settings → Access tokens.'

    if (tokenIsFromEnv())
        return 'The token in ZEKTOR_TOKEN is invalid, expired or revoked. Create a new one under Settings → Access tokens and put it in ZEKTOR_TOKEN, or unset ZEKTOR_TOKEN and run `zektor login`.'

    return `The token saved in ${configPath()} is invalid, expired or revoked. Create a new one under Settings → Access tokens and run \`zektor login\` again.`
}

/**
 * Names what a bare 404 was about without printing the route. The API answers 404
 * for an id that is gone, one that was never yours, and anything outside a pinned
 * token's instance, so the message cannot say which.
 */
function notFound(path: string): string {
    const [resource, id] = path.replace(/^\/api\//, '').split(/[/?]/)
    const nouns: Record<string, string> = { instances: 'instance', tokens: 'token', actions: 'background task' }
    const noun = nouns[resource ?? '']
    const what = noun && id && /^\d+$/.test(id) ? `No ${noun} #${id} was found on this account.` : 'Not found on this account.'

    return `${what} If this token is pinned to one instance, it can reach only that instance.`
}

/** Shape of `GET /api/auth/me` — only the fields the CLI actually reads. */
export interface Me {
    id: number
    email: string
    role: string
}

export interface DockerImage {
    id: number
    version: string
}

/** A plan. `product` is the engine it runs; `productGroup` is database vs cache. */
export interface PricingTier {
    id: number
    name: string
    monthlyPriceEur: number
    product: string
    productGroup: string
    memoryMb?: number | null
    storageMb?: number | null
    dockerImages: DockerImage[]
}

export interface Location {
    id: number
    name: string
    city: string
    country: string
    rentingAvailable: boolean
}

export interface Volume {
    id: number
    name: string
    status: string
    sizeInGb: number
}

export interface Instance {
    /** True when this instance is a branch rather than its cluster's default. */
    isBranch?: boolean
    /** When a branch is deleted automatically. Null or absent means it is kept. */
    branchExpiresAt?: string | null

    id: number
    name: string
    status: string
    port: number
    createdAt: string
    location: string
    connectionString: string
    pricingTier: PricingTier
    /** For an instance in error, why creating it failed. Absent on older APIs. */
    failureMessage?: string | null

    // Postgres storage. Absent on caches, which have no volume of their own.
    dbStorageLimitMb?: number
    dbStorageUsedMb?: number
    volumes?: Volume[]
    enableAutoScale?: boolean
    autoScaleUpOnly?: boolean
    autoScalingLimitGb?: number
    minimumDiskSizeGb?: number
}

/** Long-running server-side work. Returned by scale and volume operations. */
export interface ActionResult {
    id: number
}

/** `GET /api/actions/{id}`: how background work started by create, scale or a storage change went. */
export interface Action {
    id: number
    command: string
    status: 'Running' | 'Success' | 'Failure'
    progress: number
    /** Why it failed, written for the customer. Set on Failure, and may be empty. */
    errorMessage?: string | null
    startedAt: string
    finishedAt?: string | null
}

// The API sends both enums as numbers. These are their names, in order.
const ACTION_STATUSES = ['Running', 'Success', 'Failure'] as const
const ACTION_COMMANDS = [
    'InstanceCreation',
    'InstanceScale',
    'VolumeCreation',
    'VolumeScale',
    'VolumeAdminMigration',
    'BackupCreate',
    'BackupRestore',
]

/** A name for an enum value, whether the API sent the number or the name itself. */
const enumName = (names: readonly string[], value: number | string) =>
    typeof value === 'number' ? (names[value] ?? String(value)) : value

export interface StorageSettings {
    enableAutoScale?: boolean
    autoScaleUpOnly?: boolean
    /** null clears the ceiling — autoscaling then has no upper bound. */
    autoScalingLimitGb?: number | null
    minimumDiskSizeGb?: number | null
}

export interface CreateInstanceRequest {
    name: string
    location: number
    priceId: number
    dockerImageId?: number
}

export interface CreateInstanceResponse {
    instanceId: number
    actionId: number
}

/**
 * `GET /api/instances/{id}/connection`.
 *
 * For Valkey/Redis this carries a usable `connectionString`. For Postgres it
 * does not, and cannot: the password is emitted once when a role is created or
 * rotated and the server never stores the plaintext, so `password` and
 * `connectionString` are always null there.
 */
export interface ConnectionInfo {
    type?: 'valkey' | 'redis' | 'mongo' | 'ferret' | 'postgres'
    host: string
    port: number
    username?: string
    databaseName?: string
    database?: string
    ssl?: string
    password: string | null
    connectionString: string | null
}

/**
 * A freshly created Postgres role, with its password. Show-once: the backend keeps
 * no copy, so this response is the only place the password ever exists.
 */
export interface RoleConnectionInfo {
    roleId: number
    name: string
    user: string
    host: string
    port: number
    password: string | null
    connectionString: string | null
    isDefault: boolean
    isSuperuser: boolean
    /** When the credential stops working. Null is permanent. */
    expiresAt: string | null
    attributes: string[]
}

export interface CreateRoleRequest {
    name: string
    /** Seconds until the role stops working. Omit for a permanent role. */
    expiresInSeconds?: number
    attributes?: string[]
}

/** An instance and its branches — everything forked from one original. */
export interface Cluster {
    id: number
    instances: Instance[]
}

export interface CreateBranchRequest {
    name: string
    priceId: number
    location?: number
    /** Days until the branch is deleted automatically. Omit for the default. */
    expiresInDays?: number
}

/** A token as the list reports it. Carries no secret. */
export interface ApiTokenSummary {
    id: number
    name: string
    prefix: string
    createdAt: string
    lastUsedAt: string | null
    scopes: string
    expiresAt: string | null
    instanceId: number | null
    /** Set when another token minted this one. Revoking that token revokes this one. */
    parentTokenId: number | null
}

/** The show-once creation response. `token` exists nowhere else afterwards. */
export interface CreatedApiToken extends ApiTokenSummary {
    token: string
}

export interface CreateTokenRequest {
    name: string
    scopes?: string[]
    expiresAt?: string
    instanceId?: number
}

/** `POST /api/trial`: a Postgres database for the next hour, no account needed. */
export interface TrialDatabase {
    connectionString: string
    /** ISO time. The password stops working then; the data stays until `claimUntil`. */
    connectUntil: string
    /** Opening it (and signing up, with a payment method) keeps the database. Shown once. */
    claimUrl: string
    claimUntil: string
}

export interface TrialAvailability {
    enabled: boolean
    available: boolean
    connectMinutes: number
    claimHours: number
    maxDatabaseMb: number
}

export const api = {
    /** Anonymous. 404 while trials are off, 429 past the daily cap per network, 503 when full. */
    createTrial: () => request<TrialDatabase>('/api/trial', { method: 'POST', anonymous: true }),

    trialAvailability: () => request<TrialAvailability>('/api/trial/availability', { anonymous: true }),

    me: (token?: string) => request<Me>('/api/auth/me', { token }),

    listInstances: () => request<Instance[]>('/api/instances'),

    listTokens: () => request<ApiTokenSummary[]>('/api/tokens'),

    /** The instance's cluster: itself plus every branch of it. */
    getCluster: (instanceId: number | string) =>
        request<Cluster>(`/api/instances/${instanceId}/cluster`),

    /**
     * Forks an instance. The branch is a copy-on-write clone: it has the source's
     * data and costs nothing in storage until it diverges.
     */
    createBranch: (instanceId: number | string, body: CreateBranchRequest) =>
        request<CreateInstanceResponse>(`/api/instances/${instanceId}/branches`, {
            method: 'POST',
            body,
        }),

    /**
     * Deletes a branch. Deliberately not deleteInstance: this route needs only
     * `branches:write`, so a token that can fork can also clean up without being
     * able to destroy the database it forked from.
     */
    deleteBranch: (instanceId: number | string, branchId: number | string) =>
        request<void>(`/api/instances/${instanceId}/branches/${branchId}`, { method: 'DELETE' }),

    /**
     * Sets how long a branch has left, or keeps it indefinitely with a null
     * `expiresInDays`. Null is the explicit opt-out, not "no change".
     */
    setBranchExpiry: (instanceId: number | string, branchId: number | string, expiresInDays: number | null) =>
        request<{ branchId: number; expiresAt: string | null }>(
            `/api/instances/${instanceId}/branches/${branchId}/expiry`,
            { method: 'PATCH', body: { expiresInDays } }
        ),

    /** Makes a branch the cluster's default; the old default becomes a branch. */
    promoteBranch: (branchId: number | string) =>
        request<void>(`/api/instances/${branchId}/promote`, { method: 'POST' }),

    /**
     * Creates a Postgres role and returns its password — the only time it exists.
     *
     * With `expiresInSeconds` the role is created WITH VALID UNTIL, so Postgres stops
     * accepting the password at that instant on its own. Nothing has to run on time
     * for the credential to die.
     */
    createRole: (instanceId: number | string, body: CreateRoleRequest) =>
        request<RoleConnectionInfo>(`/api/instances/${instanceId}/roles`, {
            method: 'POST',
            body,
        }),

    /**
     * Mints a token. When the caller is itself a token — which, from the CLI, it
     * always is — the backend forces the result to be strictly weaker: scopes a
     * subset of the caller's, expiry no later, and the caller's instance pin
     * inherited. So this cannot be used to widen the credential running it.
     */
    createToken: (body: CreateTokenRequest) =>
        request<CreatedApiToken>('/api/tokens', { method: 'POST', body }),

    /** Revokes a token and everything it minted. */
    revokeToken: (id: number | string) =>
        request<void>(`/api/tokens/${id}`, { method: 'DELETE' }),

    getInstance: (id: number | string) => request<Instance>(`/api/instances/${id}`),

    createInstance: (body: CreateInstanceRequest) =>
        request<CreateInstanceResponse>('/api/instances', { method: 'POST', body }),

    deleteInstance: (id: number | string) =>
        request<void>(`/api/instances/${id}`, { method: 'DELETE' }),

    /**
     * Plans, including which engine versions each one can run.
     *
     * `/api/instances/pricing-tiers`, not `/api/products` — the latter is the
     * admin catalogue and returns `dockerImages: []`, so engine versions cannot
     * be resolved from it. Both answer for an admin account, which is exactly
     * why the wrong one is easy to pick.
     */
    listTiers: () => request<PricingTier[]>('/api/instances/pricing-tiers'),

    listLocations: () => request<Location[]>('/api/instances/available-locations'),

    getConnection: (id: number | string) =>
        request<ConnectionInfo>(`/api/instances/${id}/connection`),

    /**
     * Moves an instance to another plan. `upScale` tells the backend which
     * direction it is going; the dashboard derives it by comparing monthly
     * price, and so do we, so both agree on what counts as an upgrade.
     */
    scaleInstance: (id: number | string, pricingTierId: number, upScale: boolean, type: string) =>
        request<ActionResult>(`/api/instances/${id}/scale?type=${encodeURIComponent(type)}`, {
            method: 'POST',
            body: { PricingTierId: pricingTierId, UpScale: upScale },
        }),

    createVolume: (instanceId: number | string, size: number) =>
        request<ActionResult>(`/api/volumes/${instanceId}`, {
            method: 'POST',
            body: { size, instanceId: Number(instanceId) },
        }),

    resizeVolume: (volumeId: number, size: number) =>
        request<ActionResult>(`/api/volumes/${volumeId}`, {
            method: 'PATCH',
            body: { volumeId, size },
        }),

    updateStorageSettings: (id: number | string, settings: StorageSettings) =>
        request<Instance>(`/api/instances/${id}/storage`, { method: 'PATCH', body: settings }),

    getAction: async (id: number | string): Promise<Action> => {
        const action = await request<Omit<Action, 'status' | 'command'> & { status: number | string; command: number | string }>(
            `/api/actions/${id}`
        )
        return {
            ...action,
            status: enumName(ACTION_STATUSES, action.status) as Action['status'],
            command: enumName(ACTION_COMMANDS, action.command),
        }
    },
}
