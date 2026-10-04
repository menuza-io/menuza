import { useEffect, useState } from 'react'
import { z } from 'zod'

export const CHAT_CHANGED = 'chat:changed'

export function notifyChatActivity(orgSlug: string) {
	window.dispatchEvent(new CustomEvent(CHAT_CHANGED, { detail: orgSlug }))
}

export function useChatUnreadCount(
	orgSlug: string | undefined,
	enabled: boolean,
) {
	const [count, setCount] = useState<number | null>(null)
	useEffect(() => {
		setCount(null)
		if (!orgSlug || !enabled) return
		let active = true
		const controller = new AbortController()
		const refresh = async () => {
			try {
				const response = await fetch(
					`/${encodeURIComponent(orgSlug)}/chat/unread`,
					{
						headers: { Accept: 'application/json' },
						signal: controller.signal,
					},
				)
				if (!response.ok) return
				const payload = z
					.object({ total: z.number().int().nonnegative() })
					.parse(await response.json())
				if (active) setCount(payload.total)
			} catch {
				/* keep last count */
			}
		}
		void refresh()
		const interval = setInterval(() => void refresh(), 30_000)
		const onChange = (event: Event) => {
			const detail = (event as CustomEvent<string>).detail
			if (detail === orgSlug) void refresh()
		}
		window.addEventListener(CHAT_CHANGED, onChange)
		return () => {
			active = false
			controller.abort()
			clearInterval(interval)
			window.removeEventListener(CHAT_CHANGED, onChange)
		}
	}, [orgSlug, enabled])
	return count
}
