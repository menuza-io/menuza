import { useSyncExternalStore } from 'react'

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
