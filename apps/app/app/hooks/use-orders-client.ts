import { useCallback, useRef } from 'react'
import { z } from 'zod'

const credentialsSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string().url(),
})
type Credentials = z.infer<typeof credentialsSchema>

/** App returns credentials only. Order and contact data never transit App SSR. */
export function useOrdersClient(orgSlug: string) {
	const cached = useRef(
		new Map<string, { expires: number; credentials: Promise<Credentials> }>(),
	)
	return useCallback(
		async (path: string, init: RequestInit = {}) => {
			const write = init.method !== undefined && init.method !== 'GET'
			const key = `${orgSlug}:${write ? 'write' : 'read'}`
			const send = async () => {
				let entry = cached.current.get(key)
				if (!entry || entry.expires <= Date.now()) {
					const credentials = fetch(
						`/${encodeURIComponent(orgSlug)}/orders-token${write ? '?write=1' : ''}`,
						{ headers: { Accept: 'application/json' } },
					).then(async (response) => {
						if (!response.ok) throw new Error('Unable to authorize orders.')
						return credentialsSchema.parse(await response.json())
					})
					entry = { credentials, expires: Date.now() + 10 * 60000 }
					cached.current.set(key, entry)
					void credentials.catch(() => cached.current.delete(key))
				}
				const { jwt, tenantApiUrl } = await entry.credentials
				const headers = new Headers(init.headers)
				headers.set('Authorization', `Bearer ${jwt}`)
				if (init.body) headers.set('Content-Type', 'application/json')
				return fetch(`${tenantApiUrl}/operator/orders${path}`, {
					...init,
					headers,
				})
			}
			let response = await send()
			if (response.status === 401) {
				cached.current.delete(key)
				response = await send()
			}
			if (!response.ok) {
				const error = z
					.object({ error: z.string() })
					.safeParse(await response.json().catch(() => null))
				throw new Error(
					error.success ? error.data.error : 'Unable to load orders.',
				)
			}
			return response.json() as Promise<unknown>
		},
		[orgSlug],
	)
}
