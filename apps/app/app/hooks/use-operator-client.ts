import { useCallback, useRef } from 'react'
import { z } from 'zod'

const credentialsSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string().url(),
})
export type OperatorCredentials = z.infer<typeof credentialsSchema>

/**
 * Calls the organization's regional tenant-api straight from the browser with a
 * short-lived operator token minted by App (`/:org/orders-token`). App returns
 * credentials only: order and contact data never transit App SSR. `base` is the
 * regional route family (`/operator/orders`, `/operator/pos`).
 */
export function useOperatorClient(orgSlug: string, base: string) {
	const cached = useRef(
		new Map<
			string,
			{ expires: number; credentials: Promise<OperatorCredentials> }
		>(),
	)

	const credentialsFor = useCallback(
		(write: boolean) => {
			const key = `${orgSlug}:${write ? 'write' : 'read'}`
			let entry = cached.current.get(key)
			if (!entry || entry.expires <= Date.now()) {
				const credentials = fetch(
					`/${encodeURIComponent(orgSlug)}/orders-token${write ? '?write=1' : ''}`,
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
		[orgSlug],
	)

	const request = useCallback(
		async (path: string, init: RequestInit = {}) => {
			const write = init.method !== undefined && init.method !== 'GET'
			const send = async () => {
				const { credentials } = credentialsFor(write)
				const { jwt, tenantApiUrl } = await credentials
				const headers = new Headers(init.headers)
				headers.set('Authorization', `Bearer ${jwt}`)
				if (init.body) headers.set('Content-Type', 'application/json')
				return fetch(`${tenantApiUrl}${base}${path}`, { ...init, headers })
			}
			let response = await send()
			if (response.status === 401) {
				cached.current.delete(credentialsFor(write).key)
				response = await send()
			}
			if (!response.ok) {
				const error = z
					.object({ error: z.string(), message: z.string().optional() })
					.safeParse(await response.json().catch(() => null))
				throw new OperatorRequestError(
					error.success
						? (error.data.message ?? error.data.error)
						: 'The request failed.',
					error.success ? error.data.error : 'request_failed',
					response.status,
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
	) {
		super(message)
	}
}
