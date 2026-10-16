import {
	type ReservationsFeatureState,
	type ReservationsPermission,
	type ReservationsScope,
} from '@repo/reservations'

const REFRESH_SKEW_MS = 60_000

export class ReservationsApiError extends Error {
	status: number
	body: unknown

	constructor(message: string, status: number, body?: unknown) {
		super(message)
		this.name = 'ReservationsApiError'
		this.status = status
		this.body = body
	}
}

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

export type ReservationsConditionalResult<T = unknown> =
	| {
			status: 200
			data: T
			etag: string | null
	  }
	| {
			status: 304
			etag: string | null
	  }

export type ReservationsScopedClient = {
	scope: ReservationsScope
	request<T = unknown>(
		path: string,
		options?: ReservationsRequestOptions,
	): Promise<T>
	requestConditional<T = unknown>(
		path: string,
		options?: ReservationsRequestOptions & { ifNoneMatch?: string | null },
	): Promise<ReservationsConditionalResult<T>>
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
						throw new ReservationsApiError(
							(detail as { message?: string; error?: string } | null)
								?.message ??
								(detail as { error?: string } | null)?.error ??
								`Reservations API error (${response.status})`,
							response.status,
							detail,
						)
					}

					if (response.status === 204) {
						return undefined as T
					}
					return (await response.json()) as T
				},
				async requestConditional<T = unknown>(
					path: string,
					options: ReservationsRequestOptions & {
						ifNoneMatch?: string | null
					} = {},
				): Promise<ReservationsConditionalResult<T>> {
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
						if (options.ifNoneMatch) {
							headers['If-None-Match'] = options.ifNoneMatch
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

					if (response.status === 304) {
						return {
							status: 304,
							etag:
								response.headers.get('ETag') ??
								response.headers.get('etag') ??
								options.ifNoneMatch ??
								null,
						}
					}

					if (!response.ok) {
						let detail: unknown = null
						try {
							detail = await response.json()
						} catch {
							// ignore non-json error body
						}
						throw new ReservationsApiError(
							(detail as { message?: string; error?: string } | null)
								?.message ??
								(detail as { error?: string } | null)?.error ??
								`Reservations API error (${response.status})`,
							response.status,
							detail,
						)
					}

					const etag =
						response.headers.get('ETag') ?? response.headers.get('etag') ?? null
					const data = (await response.json()) as T
					return {
						status: 200,
						data,
						etag,
					}
				},
			}
		},
		invalidateAll() {
			cached.clear()
			inFlight.clear()
		},
	}
}
