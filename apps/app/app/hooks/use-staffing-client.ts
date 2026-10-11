import { useCallback, useRef } from 'react'
import { z } from 'zod'

const credentialsSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string().url(),
})
type Credentials = z.infer<typeof credentialsSchema>

/** Tokens live 15 minutes; refresh well before so long edits never 401. */
const CREDENTIAL_REUSE_MS = 10 * 60 * 1000

export class StaffingRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(code)
	}
}

/**
 * Browser-direct client for the regional staffing API. App only mints
 * credentials; names, phones, shifts, and punches never transit App SSR.
 */
export function useStaffingClient(orgSlug: string) {
	const cached = useRef<{
		expires: number
		credentials: Promise<Credentials>
	} | null>(null)
	return useCallback(
		async <T = unknown>(path: string, init: RequestInit = {}): Promise<T> => {
			const send = async () => {
				let entry = cached.current
				if (!entry || entry.expires <= Date.now()) {
					const credentials = fetch(
						`/${encodeURIComponent(orgSlug)}/staffing/token`,
						{ headers: { Accept: 'application/json' } },
					).then(async (response) => {
						if (!response.ok) {
							throw new StaffingRequestError(response.status, 'unauthorized')
						}
						return credentialsSchema.parse(await response.json())
					})
					entry = { credentials, expires: Date.now() + CREDENTIAL_REUSE_MS }
					cached.current = entry
					void credentials.catch(() => {
						if (cached.current === entry) cached.current = null
					})
				}
				const { jwt, tenantApiUrl } = await entry.credentials
				const headers = new Headers(init.headers)
				headers.set('Authorization', `Bearer ${jwt}`)
				if (init.body) headers.set('Content-Type', 'application/json')
				return fetch(`${tenantApiUrl}/operator/staffing${path}`, {
					...init,
					headers,
				})
			}
			let response = await send()
			if (response.status === 401) {
				cached.current = null
				response = await send()
			}
			if (!response.ok) {
				const error = z
					.object({ error: z.string() })
					.safeParse(await response.json().catch(() => null))
				throw new StaffingRequestError(
					response.status,
					error.success ? error.data.error : 'request_failed',
				)
			}
			return (await response.json()) as T
		},
		[orgSlug],
	)
}
