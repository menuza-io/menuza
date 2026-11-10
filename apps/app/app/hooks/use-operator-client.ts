import { useCallback, useRef } from 'react'
import { z } from 'zod'

const credentialsSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string().url(),
})
export type OperatorCredentials = z.infer<typeof credentialsSchema>

export type OperatorTokenRoute = 'orders-token' | 'qr-token' | 'inventory-token'

/** The App URL that mints read or write credentials for a token route. */
export function operatorTokenUrl(
	orgSlug: string,
	tokenRoute: OperatorTokenRoute,
	write: boolean,
): string {
	const base = `/${encodeURIComponent(orgSlug)}/${tokenRoute}`
	// The inventory token takes a scope; orders and QR take `write=1`.
	if (tokenRoute === 'inventory-token') {
		return `${base}?scope=${write ? 'write' : 'read'}`
	}
	return write ? `${base}?write=1` : base
}

/**
 * A request init that may say the call only reads although it is not a GET
 * (a POST that asks for costs): it then uses the read token, so a member
 * without any write grant is not refused.
 */
export type OperatorRequestInit = RequestInit & { readOnly?: boolean }

/**
 * Calls the organization's regional tenant-api straight from the browser with a
 * short-lived operator token minted by App (`/:org/orders-token`). App returns
 * credentials only: order and contact data never transit App SSR. `base` is the
 * regional route family (`/operator/orders`, `/operator/pos`).
 */
export function useOperatorClient(
	orgSlug: string,
	base: string,
	/** App route that mints the token (QR ordering and inventory have their own). */
	tokenRoute: OperatorTokenRoute = 'orders-token',
) {
	const cached = useRef(
		new Map<
			string,
			{ expires: number; credentials: Promise<OperatorCredentials> }
		>(),
	)

	const credentialsFor = useCallback(
		(write: boolean) => {
			const key = `${tokenRoute}:${orgSlug}:${write ? 'write' : 'read'}`
			let entry = cached.current.get(key)
			if (!entry || entry.expires <= Date.now()) {
				const credentials = fetch(
					operatorTokenUrl(orgSlug, tokenRoute, write),
					{ headers: { Accept: 'application/json' } },
				).then(async (response) => {
					if (!response.ok) throw new Error('Unable to authorize this request.')
					return credentialsSchema.parse(await response.json())
				})
				entry = { credentials, expires: Date.now() + 10 * 60000 }
				cached.current.set(key, entry)
				void credentials.catch(() => cached.current.delete(key))
			}
			return { key, credentials: entry.credentials }
		},
		[orgSlug, tokenRoute],
	)

	const request = useCallback(
		async (path: string, init: OperatorRequestInit = {}) => {
			const write =
				!init.readOnly && init.method !== undefined && init.method !== 'GET'
			const send = async () => {
				const { credentials } = credentialsFor(write)
				const { jwt, tenantApiUrl } = await credentials
				const headers = new Headers(init.headers)
				headers.set('Authorization', `Bearer ${jwt}`)
				if (init.body) headers.set('Content-Type', 'application/json')
				const { readOnly: ignoredReadOnly, ...fetchInit } = init
				return fetch(`${tenantApiUrl}${base}${path}`, {
					...fetchInit,
					headers,
				})
			}
			let response = await send()
			if (response.status === 401) {
				cached.current.delete(credentialsFor(write).key)
				response = await send()
			}
			if (!response.ok) {
				const body: unknown = await response.json().catch(() => null)
				const error = z
					.object({ error: z.string(), message: z.string().optional() })
					.safeParse(body)
				throw new OperatorRequestError(
					error.success
						? (error.data.message ?? error.data.error)
						: 'The request failed.',
					error.success ? error.data.error : 'request_failed',
					response.status,
					error.success ? (body as Record<string, unknown>) : null,
				)
			}
			return response.json() as Promise<unknown>
		},
		[base, credentialsFor],
	)

	/** The regional API origin for this organization (needed to build pairing links). */
	const tenantApiUrl = useCallback(
		async () => (await credentialsFor(false).credentials).tenantApiUrl,
		[credentialsFor],
	)

	return { request, tenantApiUrl }
}

export class OperatorRequestError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly status: number,
		/** The whole error body, for details such as `refundableCents`. */
		readonly body: Record<string, unknown> | null = null,
	) {
		super(message)
	}
}
