import { z } from 'zod'

/**
 * The phone's direct line to the regional inventory node (#516). The App
 * hands out a short-lived inventory token (`GET /api/inventory/token`, the
 * phone's bearer login) together with the address of the member's regional
 * node; every stock, count, delivery and order call then goes straight to that
 * node with that token. Nothing regional passes through the US App, the same
 * rule as the web screens. Pure TypeScript with injected `fetch` and clock so
 * the rules (cache, early refresh, one retry on 401, typed errors) run under
 * plain Jest.
 */

export const inventoryAccessSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string(),
	scope: z.enum(['read', 'write']),
	grants: z.array(z.string()),
	features: z.object({
		enabled: z.boolean(),
		purchasing: z.boolean(),
		recipes: z.boolean(),
		prep: z.boolean(),
		transfers: z.boolean(),
	}),
	/** Epoch milliseconds when the token stops working. */
	expiresAt: z.number(),
	organizationId: z.string(),
	currency: z.string(),
	canManageSettings: z.boolean(),
	locations: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type InventoryAccess = z.infer<typeof inventoryAccessSchema>
export type InventoryScope = 'read' | 'write'

/** A token is renewed this long before it expires, so a request never carries a dying one. */
export const TOKEN_EARLY_REFRESH_MS = 60_000

/** Fetches a token from the App: the real one calls `/api/inventory/token`. */
export type AccessFetcher = (
	organizationId: string,
	scope: InventoryScope,
) => Promise<InventoryAccess>

export class RegionError extends Error {
	readonly status: number
	/** The region's machine code (`count_closed`, `devices_still_counting`, ...) or `network_error`. */
	readonly code: string
	readonly body: Record<string, unknown> | null

	constructor(
		status: number,
		code: string,
		body: Record<string, unknown> | null = null,
	) {
		super(code)
		this.name = 'RegionError'
		this.status = status
		this.code = code
		this.body = body
	}
}

export interface RegionClient {
	/** The member's grants, flags and locations (reads a token if none is cached). */
	access(scope?: InventoryScope): Promise<InventoryAccess>
	/** A JSON call under `/operator/inventory`; `write: true` uses the write token. */
	request(
		path: string,
		init?: { method?: string; body?: unknown; write?: boolean },
	): Promise<unknown>
	/** Forget the cached tokens (sign-out, organization switch). */
	forget(): void
}

export function createRegionClient(options: {
	organizationId: string
	fetchAccess: AccessFetcher
	fetchImpl?: typeof fetch
	now?: () => number
}): RegionClient {
	const { organizationId, fetchAccess } = options
	const fetchImpl =
		options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
	const now = options.now ?? (() => Date.now())
	const cache = new Map<InventoryScope, InventoryAccess>()
	const inflight = new Map<InventoryScope, Promise<InventoryAccess>>()

	async function access(scope: InventoryScope = 'read') {
		const cached = cache.get(scope)
		if (cached && cached.expiresAt - TOKEN_EARLY_REFRESH_MS > now()) {
			return cached
		}
		const pending = inflight.get(scope)
		if (pending) return pending
		const next = fetchAccess(organizationId, scope)
			.then((value) => {
				cache.set(scope, value)
				return value
			})
			.finally(() => inflight.delete(scope))
		inflight.set(scope, next)
		return next
	}

	async function send(
		path: string,
		init: { method?: string; body?: unknown; write?: boolean },
		retried: boolean,
	): Promise<unknown> {
		const scope: InventoryScope = init.write ? 'write' : 'read'
		const granted = await access(scope)
		let response: Response
		try {
			response = await fetchImpl(
				`${granted.tenantApiUrl.replace(/\/+$/, '')}/operator/inventory${path}`,
				{
					method: init.method ?? 'GET',
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${granted.jwt}`,
						...(init.body !== undefined
							? { 'Content-Type': 'application/json' }
							: {}),
					},
					body: init.body === undefined ? undefined : JSON.stringify(init.body),
				},
			)
		} catch {
			throw new RegionError(0, 'network_error')
		}
		const text = await response.text().catch(() => '')
		let parsed: unknown = null
		try {
			parsed = text ? JSON.parse(text) : null
		} catch {
			parsed = null
		}
		if (response.status === 401 && !retried) {
			// The token was revoked or the clock disagrees: take a new one once.
			cache.delete(scope)
			return send(path, init, true)
		}
		if (!response.ok) {
			const body =
				parsed && typeof parsed === 'object'
					? (parsed as Record<string, unknown>)
					: null
			const code =
				typeof body?.code === 'string'
					? body.code
					: typeof body?.error === 'string'
						? body.error
						: `http_${response.status}`
			throw new RegionError(response.status, code, body)
		}
		return parsed
	}

	return {
		access,
		request: (path, init = {}) => send(path, init, false),
		forget: () => {
			cache.clear()
			inflight.clear()
		},
	}
}
