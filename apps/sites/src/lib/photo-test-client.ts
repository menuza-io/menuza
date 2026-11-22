import { focalObjectPosition, parseFocalPoint } from '@repo/common/image-focal'
import {
	assignPhotoVariant,
	isCrawlerUserAgent,
	PHOTO_TEST_MAX_BATCH,
	type PhotoVariant,
} from '@repo/common/photo-test'

/**
 * The browser half of dish photo A/B tests (#192).
 *
 * The menu is cached for everybody, so the server always renders photo A and
 * only marks the photo with the test and photo B:
 *
 *   data-photo-test-id, data-photo-test-item, data-photo-test-src-b,
 *   data-photo-test-focal-b
 *
 * This script gives each visitor a stable variant (a hash of an anonymous id
 * kept only in this browser and the test id), swaps the visitors in B to
 * photo B, and counts views and adds in batches. Search engines, scriptless
 * visitors, visitors who ask not to be tracked and visitors who cannot keep an
 * id all see photo A and send nothing. The id never leaves the browser.
 */

export const PHOTO_CLIENT_KEY = 'menuza:photo-client'
const VIEW_PREFIX = 'menuza:photo-view:'
const FLUSH_DELAY_MS = 2000

export type PhotoTestEvent = {
	testId: string
	itemId: string
	variant: PhotoVariant
	event: 'view' | 'add'
	/** Signed by the App for this test and dish; the region counts only with it. */
	key: string
}

function storage(kind: 'local' | 'session'): Storage | null {
	try {
		return (
			(kind === 'local'
				? globalThis.localStorage
				: globalThis.sessionStorage) ?? null
		)
	} catch {
		return null
	}
}

function newClientId(): string {
	try {
		const id = globalThis.crypto?.randomUUID?.()
		if (id) return id
	} catch {
		/* fall through */
	}
	let id = ''
	for (let index = 0; index < 32; index += 1) {
		id += Math.floor(Math.random() * 16).toString(16)
	}
	return id
}

/**
 * This browser's anonymous id, created on first use. `null` when storage is
 * unavailable: without a stable id the visitor cannot keep a photo, so the
 * caller shows photo A.
 */
export function photoClientId(): string | null {
	const local = storage('local')
	if (!local) return null
	try {
		const existing = local.getItem(PHOTO_CLIENT_KEY)
		if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing
		const id = newClientId()
		local.setItem(PHOTO_CLIENT_KEY, id)
		return id
	} catch {
		return null
	}
}

function userAgent(): string {
	try {
		return globalThis.navigator?.userAgent ?? ''
	} catch {
		return ''
	}
}

/** Whether this visitor may be assigned a photo and counted at all. */
export function photoTestsTracked(): boolean {
	try {
		if (globalThis.navigator?.doNotTrack === '1') return false
	} catch {
		return false
	}
	return !isCrawlerUserAgent(userAgent())
}

/** The photo this browser shows for a test: stable per browser, A when unsure. */
export function variantFor(testId: string): PhotoVariant {
	if (!photoTestsTracked()) return 'A'
	const clientId = photoClientId()
	if (!clientId) return 'A'
	return assignPhotoVariant({ testId, clientId, userAgent: userAgent() })
}

// ---------- counters ----------

let queue: PhotoTestEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let listening = false
const viewedThisPage = new Set<string>()

function context() {
	const data = globalThis.document?.documentElement?.dataset
	const url = data?.tenantApiUrl?.replace(/\/$/, '')
	if (!url) return null
	return {
		url,
		slug: data?.orgSlug || undefined,
		host: data?.customHost || undefined,
	}
}

function send(
	target: NonNullable<ReturnType<typeof context>>,
	events: PhotoTestEvent[],
) {
	const body = JSON.stringify({
		slug: target.slug,
		host: target.host,
		events,
	})
	try {
		// `keepalive` survives a page change; the answer is never read.
		void fetch(`${target.url}/forms/dish-photo-events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
			keepalive: true,
			credentials: 'omit',
		}).catch(() => {})
	} catch {
		/* the beacon is best effort */
	}
}

/** Sends everything queued, at most 50 entries per request. Never throws. */
export function flushPhotoTestEvents() {
	if (timer) {
		clearTimeout(timer)
		timer = null
	}
	if (queue.length === 0) return
	const pending = queue
	queue = []
	try {
		const target = context()
		if (!target) return
		for (let at = 0; at < pending.length; at += PHOTO_TEST_MAX_BATCH) {
			send(target, pending.slice(at, at + PHOTO_TEST_MAX_BATCH))
		}
	} catch {
		/* best effort */
	}
}

function listenForLeave() {
	if (listening) return
	listening = true
	try {
		globalThis.document?.addEventListener('visibilitychange', () => {
			if (globalThis.document.visibilityState === 'hidden') {
				flushPhotoTestEvents()
			}
		})
		globalThis.addEventListener?.('pagehide', () => flushPhotoTestEvents())
	} catch {
		/* no document */
	}
}

function queueEvent(event: PhotoTestEvent) {
	listenForLeave()
	queue.push(event)
	if (queue.length >= PHOTO_TEST_MAX_BATCH) {
		flushPhotoTestEvents()
		return
	}
	if (!timer) timer = setTimeout(flushPhotoTestEvents, FLUSH_DELAY_MS)
}

/** True the first time a test and dish is seen in this session. */
function firstViewThisSession(testId: string, itemId: string): boolean {
	const key = `${VIEW_PREFIX}${testId}:${itemId}`
	if (viewedThisPage.has(key)) return false
	viewedThisPage.add(key)
	const session = storage('session')
	if (!session) return true
	try {
		if (session.getItem(key)) return false
		session.setItem(key, '1')
		return true
	} catch {
		return true
	}
}

function recordView(
	testId: string,
	itemId: string,
	variant: PhotoVariant,
	key: string | undefined,
) {
	// Without the App's key the region would drop the event anyway.
	if (!key) return
	if (!firstViewThisSession(testId, itemId)) return
	queueEvent({ testId, itemId, variant, event: 'view', key })
}

/** A dish in a running test went into the cart: one `add` for the photo shown. */
export function recordPhotoTestAdd(line: {
	itemId: string
	photoTestId?: string | null
	photoTestKey?: string | null
}) {
	try {
		if (!line.photoTestId || !line.itemId || !line.photoTestKey) return
		if (!photoTestsTracked() || !photoClientId()) return
		queueEvent({
			testId: line.photoTestId,
			itemId: line.itemId,
			variant: variantFor(line.photoTestId),
			event: 'add',
			key: line.photoTestKey,
		})
	} catch {
		/* counting never blocks the cart */
	}
}

/**
 * The tests behind a cart, for the order body: what this browser showed for
 * each dish that was in a test. Empty (so the key is left out) unless this
 * visitor is counted.
 */
export function photoTestsForCart(
	lines: ReadonlyArray<{
		itemId: string
		photoTestId?: string | null
		photoTestKey?: string | null
	}>,
): Array<{
	testId: string
	itemId: string
	variant: PhotoVariant
	key: string
}> {
	const seen = new Set<string>()
	const out: Array<{
		testId: string
		itemId: string
		variant: PhotoVariant
		key: string
	}> = []
	if (!photoTestsTracked() || !photoClientId()) return out
	for (const line of lines) {
		// The region credits an order to a test only with the App's signed key.
		if (!line.photoTestId || !line.photoTestKey) continue
		const key = `${line.photoTestId}:${line.itemId}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({
			testId: line.photoTestId,
			itemId: line.itemId,
			variant: variantFor(line.photoTestId),
			key: line.photoTestKey,
		})
		if (out.length >= 20) break
	}
	return out
}

// ---------- the swap ----------

function safeSource(value: string | undefined): string | null {
	if (!value) return null
	if (value.startsWith('/') && !value.startsWith('//')) return value
	try {
		const url = new URL(value)
		return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
	} catch {
		return null
	}
}

let viewObserver: IntersectionObserver | null = null

function watchView(
	element: HTMLElement,
	testId: string,
	itemId: string,
	variant: PhotoVariant,
) {
	if (typeof IntersectionObserver === 'undefined') {
		recordView(testId, itemId, variant, element.dataset.photoTestKey)
		return
	}
	viewObserver ??= new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue
			viewObserver?.unobserve(entry.target)
			const target = entry.target as HTMLElement
			const id = target.dataset.photoTestId
			const item = target.dataset.photoTestItem
			const shown = target.dataset.photoTestVariant
			if (id && item && (shown === 'A' || shown === 'B')) {
				recordView(id, item, shown, target.dataset.photoTestKey)
			}
		}
	})
	viewObserver.observe(element)
}

/**
 * Picks the variant of every marked photo under `root` and swaps the ones in
 * B. Safe to call again: a photo already tagged with its variant is skipped.
 */
export function applyPhotoTests(root: ParentNode = document) {
	const marked = Array.from(
		root.querySelectorAll<HTMLElement>(
			'[data-photo-test-id]:not([data-photo-test-variant])',
		),
	)
	const rootElement = root as Partial<HTMLElement>
	if (
		typeof rootElement.matches === 'function' &&
		rootElement.matches('[data-photo-test-id]:not([data-photo-test-variant])')
	) {
		marked.unshift(root as HTMLElement)
	}
	const tracked = photoTestsTracked() && photoClientId() !== null
	for (const element of marked) {
		const testId = element.dataset.photoTestId
		const itemId = element.dataset.photoTestItem
		if (!testId || !itemId) continue
		const variant = variantFor(testId)
		element.dataset.photoTestVariant = variant
		if (variant === 'B') {
			const source = safeSource(element.dataset.photoTestSrcB)
			if (source && element instanceof HTMLImageElement) {
				element.src = source
				// A `srcset` would win over `src`; photo B has a single address.
				if (element.hasAttribute('srcset'))
					element.setAttribute('srcset', source)
				element.style.objectPosition = focalObjectPosition(
					parseFocalPoint(element.dataset.photoTestFocalB),
				)
			}
		}
		if (tracked) watchView(element, testId, itemId, variant)
	}
}

let started = false

/** Runs on load and whenever the page adds photos (menu rows, the item modal). */
export function initPhotoTests() {
	if (started || typeof document === 'undefined') return
	started = true
	applyPhotoTests(document)
	if (typeof MutationObserver === 'undefined') return
	let scheduled = false
	const observer = new MutationObserver((records) => {
		if (scheduled) return
		if (!records.some((record) => record.addedNodes.length > 0)) return
		scheduled = true
		queueMicrotask(() => {
			scheduled = false
			applyPhotoTests(document)
		})
	})
	observer.observe(document.body ?? document.documentElement, {
		childList: true,
		subtree: true,
	})
}

/** Test seam: forget the page's state. */
export function resetPhotoTestClient() {
	queue = []
	if (timer) clearTimeout(timer)
	timer = null
	viewedThisPage.clear()
	viewObserver?.disconnect()
	viewObserver = null
	started = false
}
