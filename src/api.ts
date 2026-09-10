import { resolveApiUrl, resolveToken } from './config.js'

/**
 * Thin fetch wrapper. Deliberately not a generated runtime client — the types in
 * `types/api.d.ts` come from the server's OpenAPI document, so drift is a build
 * error, while the transport stays small enough to read in one sitting.
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
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = options.token ?? resolveToken()

    if (!token) throw new NotAuthenticatedError()

    const url = `${resolveApiUrl()}${path}`

    let response: Response
    try {
        response = await fetch(url, {
            method: options.method ?? 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
    } catch (cause) {
        // A DNS failure or refused connection is not an API error, and saying
        // "request failed" without the URL sends people hunting in the wrong place.
        throw new ApiError(0, `Could not reach ${resolveApiUrl()} — ${(cause as Error).message}`)
    }

    if (response.status === 401)
        throw new ApiError(401, 'Token rejected. It may have been revoked — check Settings.')

    if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ApiError(response.status, text.trim() || `${response.status} ${response.statusText}`)
    }

    if (response.status === 204) return undefined as T

    return (await response.json()) as T
}

/** Shape of `GET /api/auth/me` — only the fields the CLI actually reads. */
export interface Me {
    id: number
    email: string
    role: string
}

export const api = {
    me: (token?: string) => request<Me>('/api/auth/me', { token }),
}
