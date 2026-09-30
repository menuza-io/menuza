import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'

const credentialsSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string(),
})
type Credentials = z.infer<typeof credentialsSchema>
const MAILBOX_CHANGED = 'mailbox:changed'

export function notifyMailboxChanged(orgSlug: string) {
	window.dispatchEvent(new CustomEvent(MAILBOX_CHANGED, { detail: orgSlug }))
}

/** Only credentials pass through App. All mailbox data goes browser → regional API. */
export function useMailboxClient(orgSlug: string) {
	const credentials = useRef<{
		orgSlug: string
		value: Promise<Credentials>
		expires: number
	} | null>(null)
	return useCallback(
		async (path: string, init: RequestInit = {}) => {
			const getCredentials = () => {
				if (
					!credentials.current ||
					credentials.current.orgSlug !== orgSlug ||
					credentials.current.expires <= Date.now()
				) {
					const value = fetch(`/${encodeURIComponent(orgSlug)}/mailbox-token`, {
						headers: { Accept: 'application/json' },
					}).then(async (response) => {
						if (!response.ok)
							throw new Error(
								'Unable to authorize mailbox. Refresh the page and try again.',
							)
						return credentialsSchema.parse(await response.json())
					})
					credentials.current = {
						orgSlug,
						value,
						expires: Date.now() + 10 * 60000,
					}
					void value.catch(() => {
						if (credentials.current?.value === value) credentials.current = null
					})
				}
				return credentials.current.value
			}
			const send = async () => {
				const { jwt, tenantApiUrl } = await getCredentials()
				const headers = new Headers(init.headers)
				headers.set('Authorization', `Bearer ${jwt}`)
				if (init.body) headers.set('Content-Type', 'application/json')
				return fetch(`${tenantApiUrl}/operator/mailbox${path}`, {
					...init,
					headers,
				})
			}
			let response = await send()
			if (response.status === 401) {
				credentials.current = null
				response = await send()
			}
			if (!response.ok) {
				const payload: unknown = await response.json().catch(() => null)
				const parsed = z.object({ error: z.string() }).safeParse(payload)
				throw new Error(
					parsed.success
						? parsed.data.error
						: 'Unable to load mailbox. Try again.',
				)
			}
			return response.json() as Promise<unknown>
		},
		[orgSlug],
	)
}

export function useMailboxUnreadCount(
	orgSlug: string | undefined,
	enabled: boolean,
) {
	const request = useMailboxClient(orgSlug || '')
	const [count, setCount] = useState<number | null>(null)
	useEffect(() => {
		setCount(null)
		if (!orgSlug || !enabled) return
		let active = true
		const controller = new AbortController()
		const refresh = async () => {
			try {
				const result = z
					.object({ unreadCount: z.number() })
					.parse(await request('/count', { signal: controller.signal }))
				if (active) setCount(result.unreadCount)
			} catch {
				/* Keep the last known count; unavailable is not zero. */
			}
		}
		const changed = (event: Event) => {
			if ((event as CustomEvent<string>).detail === orgSlug) void refresh()
		}
		void refresh()
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') void refresh()
		}, 60000)
		window.addEventListener('focus', refresh)
		window.addEventListener(MAILBOX_CHANGED, changed)
		return () => {
			active = false
			controller.abort()
			window.clearInterval(timer)
			window.removeEventListener('focus', refresh)
			window.removeEventListener(MAILBOX_CHANGED, changed)
		}
	}, [orgSlug, enabled, request])
	return count
}
