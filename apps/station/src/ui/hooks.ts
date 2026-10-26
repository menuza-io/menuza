import { useEffect, useState, useSyncExternalStore } from 'react'

/** Subscribes to a CSS media query. Tailwind's `lg` is `(min-width: 1024px)`. */
export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(notify) => {
			const mq = window.matchMedia(query)
			mq.addEventListener('change', notify)
			return () => mq.removeEventListener('change', notify)
		},
		() => window.matchMedia(query).matches,
		() => false,
	)
}

export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)')
export const useIsTablet = () => useMediaQuery('(min-width: 768px)')

/** The time now, again every `everyMs` (for "12 min ago" style labels). */
export function useNow(everyMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), everyMs)
		return () => window.clearInterval(timer)
	}, [everyMs])
	return now
}
