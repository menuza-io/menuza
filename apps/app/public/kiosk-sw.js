/* Service worker for the shared-tablet time clock (scope: /kiosk).
 *
 * It exists for one reason: a tablet that loses its connection must still open
 * the clock, show the PIN pad and take punches (they wait in an on-device
 * queue). So it keeps the page shell and the build's hashed assets.
 *
 * What it will NOT do, on purpose:
 *   - touch anything outside /kiosk and /assets: the app, the API and every
 *     other page never go through this worker;
 *   - cache a response made with someone's login. The copy it keeps of the
 *     shell is fetched without credentials, so it is the signed-out page;
 *   - cache or intercept calls to the regional time clock API (cross-origin).
 *
 * Plain JavaScript on purpose: this file is served as-is and cannot be bundled.
 */

const VERSION = 'kiosk-shell-v1'
const SHELL_PAGES = ['/kiosk', '/kiosk/pair']
const ASSET_PATTERN =
	/\/assets\/[A-Za-z0-9._~-]+\.(?:js|css|woff2?|svg|png|webp|ico)/g
const NAVIGATION_TIMEOUT_MS = 5000
const REFRESH_EVERY_MS = 10 * 60 * 1000

let lastRefresh = 0

self.addEventListener('install', (event) => {
	event.waitUntil(
		refreshShell().then(
			() => self.skipWaiting(),
			() => self.skipWaiting(),
		),
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys()
			await Promise.all(
				names
					.filter((name) => name.startsWith('kiosk-shell-') && name !== VERSION)
					.map((name) => caches.delete(name)),
			)
			await self.clients.claim()
		})(),
	)
})

self.addEventListener('message', (event) => {
	const data = event.data
	if (!data || data.type !== 'warm' || !Array.isArray(data.urls)) return
	event.waitUntil(cacheAssets(data.urls))
})

self.addEventListener('fetch', (event) => {
	const request = event.request
	if (request.method !== 'GET') return
	const url = new URL(request.url)
	if (url.origin !== self.location.origin) return

	if (request.mode === 'navigate') {
		if (isKioskPath(url.pathname)) {
			event.respondWith(navigate(event, request, url))
		}
		return
	}
	if (url.pathname.startsWith('/assets/')) {
		event.respondWith(assetFirst(request))
	}
})

function isKioskPath(pathname) {
	return pathname === '/kiosk' || pathname.startsWith('/kiosk/')
}

/** `/kiosk/pair` and `/kiosk/pair/` are the same page; so is `/kiosk/`. */
function shellKey(pathname) {
	const trimmed = pathname.replace(/\/+$/, '')
	return SHELL_PAGES.includes(trimmed) ? trimmed : '/kiosk'
}

async function navigate(event, request, url) {
	const key = shellKey(url.pathname)
	try {
		const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS)
		if (response.ok) {
			// Keep the offline copy fresh without slowing this request down.
			if (Date.now() - lastRefresh > REFRESH_EVERY_MS) {
				event.waitUntil(refreshShell().catch(() => undefined))
			}
			return response
		}
		return (await cachedShell(key)) || response
	} catch (error) {
		const cached = await cachedShell(key)
		if (cached) return cached
		throw error
	}
}

async function cachedShell(key) {
	const cache = await caches.open(VERSION)
	return (
		(await cache.match(key, { ignoreSearch: true })) ||
		(await cache.match('/kiosk'))
	)
}

/**
 * Fetches the shell pages without credentials (the signed-out render, which
 * carries no one's data) and the assets they name.
 */
async function refreshShell() {
	lastRefresh = Date.now()
	const cache = await caches.open(VERSION)
	const assets = new Set()
	await Promise.all(
		SHELL_PAGES.map(async (page) => {
			const response = await fetch(
				new Request(page, { credentials: 'omit', cache: 'reload' }),
			)
			if (!response.ok) return
			const copy = response.clone()
			await cache.put(page, response)
			const html = await copy.text()
			for (const match of html.match(ASSET_PATTERN) || []) assets.add(match)
		}),
	)
	await cacheAssets([...assets])
}

async function cacheAssets(urls) {
	const cache = await caches.open(VERSION)
	await Promise.all(
		urls.map(async (value) => {
			let url
			try {
				url = new URL(value, self.location.origin)
			} catch {
				return
			}
			if (url.origin !== self.location.origin) return
			if (!url.pathname.startsWith('/assets/')) return
			if (await cache.match(url.pathname)) return
			try {
				const response = await fetch(url.pathname, { credentials: 'omit' })
				if (response.ok) await cache.put(url.pathname, response)
			} catch {
				// offline right now: the runtime handler will cache it next time
			}
		}),
	)
}

/** Hashed build assets never change under the same name: cache first. */
async function assetFirst(request) {
	const cache = await caches.open(VERSION)
	const hit = await cache.match(request)
	if (hit) return hit
	const response = await fetch(request)
	if (response.ok) cache.put(request, response.clone()).catch(() => undefined)
	return response
}

function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timeout')), ms)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}
