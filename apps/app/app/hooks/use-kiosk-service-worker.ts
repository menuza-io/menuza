import { useEffect } from 'react'

/**
 * Registers the kiosk service worker (scope `/kiosk`) and, once it is in
 * control, tells it which build assets this page actually loaded so they are
 * cached for the next time the tablet has no connection. The worker has no
 * other way to learn the names of lazily loaded chunks (route code, the
 * Arabic and English catalogs).
 */
export function useKioskServiceWorker() {
	useEffect(() => {
		if (!('serviceWorker' in navigator)) return
		let cancelled = false

		async function setup() {
			try {
				await navigator.serviceWorker.register('/kiosk-sw.js', {
					scope: '/kiosk',
				})
				const registration = await navigator.serviceWorker.ready
				if (cancelled) return
				// Give the lazy chunks (catalogs) a moment to be requested first.
				await new Promise((resolve) => setTimeout(resolve, 3000))
				const urls = performance
					.getEntriesByType('resource')
					.map((entry) => entry.name)
					.filter((name) => {
						try {
							const url = new URL(name)
							return (
								url.origin === location.origin &&
								url.pathname.startsWith('/assets/')
							)
						} catch {
							return false
						}
					})
				registration.active?.postMessage({ type: 'warm', urls })
			} catch {
				// No service worker (private window, insecure origin): the kiosk
				// still works online; it just cannot reload itself offline.
			}
		}
		void setup()
		return () => {
			cancelled = true
		}
	}, [])
}
