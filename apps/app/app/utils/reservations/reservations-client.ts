import {
	type ReservationsFeatureState,
	type ReservationsPermission,
	type ReservationsScope,
} from '@repo/reservations'

const REFRESH_SKEW_MS = 60_000

export type ReservationsTokenResponse = {
	jwt: string
	token?: string
	tenantApiUrl: string
	expiresAt: number
	scope: ReservationsScope
	grants: ReservationsPermission[]
	locationIds: string[] | null
	features: ReservationsFeatureState
}

export type ReservationsRequestOptions = {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
	query?: Record<string, string | number | boolean | undefined | null>
	body?: unknown
	headers?: Record<string, string>
	signal?: AbortSignal
}

export type ReservationsScopedClient = {
	scope: ReservationsScope
	request<T = unknown>(
		path: string,
		options?: ReservationsRequestOptions,
	): Promise<T>
	getToken(): Promise<ReservationsTokenResponse>
	invalidate(): void
}

export type ReservationsClientPool = {
	orgSlug: string
	forScope(
		scope: ReservationsScope,
		locationIds?: readonly string[],
	): ReservationsScopedClient
	invalidateAll(): void
}

function cacheKey(
	scope: ReservationsScope,
	locationIds?: readonly string[],
): string {
	if (!locationIds || locationIds.length === 0) return scope
	return `${scope}:${[...locationIds].sort().join(',')}`
}

export function createReservationsClientPool({
	orgSlug,
	fetchImpl = fetch,
}: {
	orgSlug: string
	fetchImpl?: typeof fetch
}): ReservationsClientPool {
	const cached = new Map<string, ReservationsTokenResponse>()
	const inFlight = new Map<string, Promise<ReservationsTokenResponse>>()

	async function mintToken(
		scope: ReservationsScope,
		locationIds?: readonly string[],
	): Promise<ReservationsTokenResponse> {
		const params = new URLSearchParams({ scope })
		if (locationIds && locationIds.length > 0) {
			params.set('locationIds', locationIds.join(','))
		}
		const response = await fetchImpl(
			`/${encodeURIComponent(orgSlug)}/reservations/token?${params.toString()}`,
			{
				method: 'GET',
				headers: { Accept: 'application/json' },
				credentials: 'same-origin',
				cache: 'no-store',
			},
		)
		if (!response.ok) {
			const error = new Error(
				`Failed to mint reservations token (${response.status})`,
			) as Error & { status?: number }
			error.status = response.status
			throw error
		}
		const payload = (await response.json()) as ReservationsTokenResponse
		return {
			...payload,
			jwt: payload.jwt ?? payload.token ?? '',
		}
	}

	async function getOrMint(
		scope: ReservationsScope,
		locationIds?: readonly string[],
	): Promise<ReservationsTokenResponse> {
		const key = cacheKey(scope, locationIds)
		const existing = cached.get(key)
		if (existing && existing.expiresAt - Date.now() > REFRESH_SKEW_MS) {
			return existing
		}
		const pending = inFlight.get(key)
		if (pending) return pending

		const promise = mintToken(scope, locationIds)
			.then((token) => {
				cached.set(key, token)
				inFlight.delete(key)
				return token
			})
			.catch((err) => {
				inFlight.delete(key)
				throw err
			})
		inFlight.set(key, promise)
		return promise
	}

	return {
		orgSlug,
		forScope(scope, locationIds) {
			const key = cacheKey(scope, locationIds)
			return {
				scope,
				getToken: () => getOrMint(scope, locationIds),
				invalidate: () => {
					cached.delete(key)
				},
				async request<T = unknown>(
					path: string,
					options: ReservationsRequestOptions = {},
				): Promise<T> {
					const execute = async (
						token: ReservationsTokenResponse,
					): Promise<Response> => {
						const baseUrl = token.tenantApiUrl.replace(/\/+$/, '')
						const relPath = path.startsWith('/') ? path : `/${path}`
						const url = new URL(`${baseUrl}${relPath}`)
						if (options.query) {
							for (const [k, v] of Object.entries(options.query)) {
								if (v !== undefined && v !== null) {
									url.searchParams.set(k, String(v))
								}
							}
						}
						const headers: Record<string, string> = {
							Accept: 'application/json',
							Authorization: `Bearer ${token.jwt}`,
							...options.headers,
						}
						let body: BodyInit | undefined
						if (options.body !== undefined) {
							headers['Content-Type'] = 'application/json'
							body = JSON.stringify(options.body)
						}
						return fetchImpl(url.toString(), {
							method: options.method ?? 'GET',
							headers,
							body,
							cache: 'no-store',
							signal: options.signal,
						})
					}

					let token = await getOrMint(scope, locationIds)
					let response = await execute(token)
					if (response.status === 401) {
						cached.delete(key)
						token = await getOrMint(scope, locationIds)
						response = await execute(token)
					}

					if (!response.ok) {
						let detail: unknown = null
						try {
							detail = await response.json()
						} catch {
							// ignore non-json error body
						}
						const err = new Error(
							(detail as { message?: string; error?: string } | null)
								?.message ??
								(detail as { error?: string } | null)?.error ??
								`Reservations API error (${response.status})`,
						) as Error & { status?: number; body?: unknown }
						err.status = response.status
						err.body = detail
						throw err
					}

					if (response.status === 204) {
						return undefined as T
					}
					return (await response.json()) as T
				},
			}
		},
		invalidateAll() {
			cached.clear()
			inFlight.clear()
		},
	}
}
