import {
	grantsSatisfying,
	isStaffingPermission,
	type StaffingPermission,
	type StaffingScope,
} from '@repo/staffing'
import { z } from 'zod'

/**
 * Browser-direct client for the regional staff API.
 *
 * The App only decides who may ask: `GET /:orgSlug/staff/token` returns a
 * short-lived bearer token plus the regional tenant-api origin, and every staff
 * call then goes from the browser to that node. No name, wage or PIN passes
 * through the US servers.
 *
 * Tokens live in memory only (never `localStorage`): staff data is sensitive and
 * a token is cheap to mint again. They are cached per scope and refreshed one
 * minute before they expire, and concurrent callers share one in-flight mint.
 */

export const TOKEN_REFRESH_MARGIN_MS = 60_000

const credentialsSchema = z.object({
	jwt: z.string().min(1),
	tenantApiUrl: z.string().url(),
	scope: z.string(),
	grants: z.array(z.string()),
	expiresAt: z.number(),
})

export type StaffCredentials = {
	jwt: string
	tenantApiUrl: string
	scope: StaffingScope
	grants: readonly StaffingPermission[]
	expiresAt: number
}

export type StaffApiIssue = { path: string; code: string; message?: string }

/** A failed call. `code` is the server's short error string, never a stack. */
export class StaffApiError extends Error {
	readonly status: number
	readonly code: string
	readonly issues: StaffApiIssue[]

	constructor(
		status: number,
		code: string,
		message?: string,
		issues: StaffApiIssue[] = [],
	) {
		super(message || code)
		this.name = 'StaffApiError'
		this.status = status
		this.code = code
		this.issues = issues
	}
}

const errorBodySchema = z
	.object({
		error: z.string().optional(),
		message: z.string().optional(),
		issues: z
			.array(
				z.object({
					path: z.string().default(''),
					code: z.string().default('invalid'),
					message: z.string().optional(),
				}),
			)
			.optional(),
		// Cross-field rule failures (labor policy) use the same `{ path, code }`.
		problems: z
			.array(
				z.object({
					path: z.string().default(''),
					code: z.string().default('invalid'),
				}),
			)
			.optional(),
	})
	.passthrough()

export type StaffRequestInit = Omit<RequestInit, 'body'> & {
	/** Serialized as JSON with the right content type. */
	json?: unknown
}

export type StaffClientOptions = {
	orgSlug: string
	scope?: StaffingScope
	fetchImpl?: typeof fetch
	now?: () => number
	refreshMarginMs?: number
}

export type StaffClient = {
	readonly scope: StaffingScope
	/** Current credentials, minting or refreshing them when needed. */
	credentials(): Promise<StaffCredentials>
	/** Grants the token carries (what the server will honor). */
	grants(): Promise<ReadonlySet<StaffingPermission>>
	request(path: string, init?: StaffRequestInit): Promise<unknown>
	/** Drop the cached token (for example after sign-out). */
	forget(): void
}

export function createStaffClient(options: StaffClientOptions): StaffClient {
	const {
		orgSlug,
		scope = 'staff',
		fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
		now = () => Date.now(),
		refreshMarginMs = TOKEN_REFRESH_MARGIN_MS,
	} = options

	let cached: Promise<StaffCredentials> | null = null
	let cachedExpiry = 0

	async function mint(): Promise<StaffCredentials> {
		const response = await fetchImpl(
			`/${encodeURIComponent(orgSlug)}/staff/token?scope=${scope}`,
			{ headers: { Accept: 'application/json' }, credentials: 'same-origin' },
		)
		if (!response.ok) {
			throw new StaffApiError(response.status, 'token_unavailable')
		}
		const parsed = credentialsSchema.safeParse(await response.json())
		if (!parsed.success) throw new StaffApiError(502, 'token_malformed')
		return {
			jwt: parsed.data.jwt,
			tenantApiUrl: parsed.data.tenantApiUrl.replace(/\/+$/, ''),
			scope,
			grants: parsed.data.grants.filter(isStaffingPermission),
			expiresAt: parsed.data.expiresAt,
		}
	}

	function credentials(): Promise<StaffCredentials> {
		if (cached && cachedExpiry - refreshMarginMs > now()) return cached
		const pending = mint()
		cached = pending
		// Until the mint resolves the entry is not reusable past this call.
		cachedExpiry = Number.POSITIVE_INFINITY
		pending.then(
			(value) => {
				if (cached === pending) cachedExpiry = value.expiresAt
			},
			() => {
				if (cached === pending) cached = null
			},
		)
		return pending
	}

	function forget() {
		cached = null
		cachedExpiry = 0
	}

	async function send(path: string, init: StaffRequestInit) {
		const creds = await credentials()
		const { json, headers: initHeaders, ...rest } = init
		const headers = new Headers(initHeaders)
		headers.set('Authorization', `Bearer ${creds.jwt}`)
		headers.set('Accept', 'application/json')
		let body: string | undefined
		if (json !== undefined) {
			headers.set('Content-Type', 'application/json')
			body = JSON.stringify(json)
		}
		// The API has no trailing-slash routes: `/?q=x` must become `?q=x`, and a
		// bare `/` the collection root itself.
		const suffix =
			path === '/' ? '' : path.startsWith('/?') ? path.slice(1) : path
		// Each token scope reaches its own route group: `/operator/staff`,
		// `/operator/timeclock`, and so on.
		return fetchImpl(`${creds.tenantApiUrl}/operator/${scope}${suffix}`, {
			...rest,
			headers,
			body,
			// Staff data must never be served from a shared or stale cache.
			cache: 'no-store',
		})
	}

	async function request(path: string, init: StaffRequestInit = {}) {
		let response = await send(path, init)
		if (response.status === 401) {
			// The token may have been revoked or the clock drifted: mint once more.
			forget()
			response = await send(path, init)
		}
		const text = await response.text()
		let parsed: unknown = null
		try {
			parsed = text ? JSON.parse(text) : null
		} catch {
			parsed = null
		}
		if (!response.ok) {
			const body = errorBodySchema.safeParse(parsed)
			throw new StaffApiError(
				response.status,
				(body.success && body.data.error) || 'request_failed',
				body.success ? body.data.message : undefined,
				body.success ? (body.data.issues ?? body.data.problems ?? []) : [],
			)
		}
		return parsed
	}

	return {
		scope,
		credentials,
		async grants() {
			return new Set((await credentials()).grants)
		},
		request,
		forget,
	}
}

/** One client per scope for one organization; created once per Staff layout. */
export type StaffClientPool = {
	readonly orgSlug: string
	get(scope: StaffingScope): StaffClient
	forgetAll(): void
}

export function createStaffClientPool(
	orgSlug: string,
	overrides: Omit<StaffClientOptions, 'orgSlug' | 'scope'> = {},
): StaffClientPool {
	const clients = new Map<StaffingScope, StaffClient>()
	return {
		orgSlug,
		get(scope) {
			let client = clients.get(scope)
			if (!client) {
				client = createStaffClient({ ...overrides, orgSlug, scope })
				clients.set(scope, client)
			}
			return client
		},
		forgetAll() {
			for (const client of clients.values()) client.forget()
		},
	}
}

/** Whether `held` satisfies `required` (a stronger grant satisfies a read). */
export function holdsGrant(
	held: ReadonlySet<string> | null | undefined,
	required: StaffingPermission,
): boolean {
	if (!held) return false
	return grantsSatisfying(required).some((grant) => held.has(grant))
}
