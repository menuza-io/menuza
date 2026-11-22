// @vitest-environment jsdom
import { assignPhotoVariant } from '@repo/common/photo-test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	applyPhotoTests,
	flushPhotoTestEvents,
	PHOTO_CLIENT_KEY,
	photoClientId,
	photoTestsForCart,
	recordPhotoTestAdd,
	resetPhotoTestClient,
	variantFor,
} from './photo-test-client'

const BROWSER =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

function memoryStorage(): Storage {
	const data = new Map<string, string>()
	return {
		get length() {
			return data.size
		},
		clear: () => data.clear(),
		getItem: (key) => data.get(key) ?? null,
		key: (index) => [...data.keys()][index] ?? null,
		removeItem: (key) => void data.delete(key),
		setItem: (key, value) => void data.set(key, String(value)),
	}
}

/** The test id and a client id that hash to the wanted variant. */
function idFor(testId: string, want: 'A' | 'B') {
	for (let index = 0; index < 200; index += 1) {
		const clientId = `client-${index}-abcdefgh`
		if (assignPhotoVariant({ testId, clientId, userAgent: BROWSER }) === want) {
			return clientId
		}
	}
	throw new Error('no id found')
}

const TEST = 'test_abcdefgh'
const KEY = 'k'.repeat(32)

function photo(extra: Record<string, string> = {}) {
	const img = document.createElement('img')
	img.src = 'https://cdn.test/a.jpg'
	img.dataset.photoTestId = TEST
	img.dataset.photoTestItem = 'dish_1'
	img.dataset.photoTestSrcB = 'https://cdn.test/b.jpg'
	img.dataset.photoTestFocalB = '0,0'
	img.dataset.photoTestKey = KEY
	for (const [key, value] of Object.entries(extra)) img.dataset[key] = value
	document.body.append(img)
	return img
}

type Observer = {
	callback: IntersectionObserverCallback
	targets: Element[]
}
let observers: Observer[]
let fetchMock: ReturnType<typeof vi.fn>
let local: Storage
let session: Storage

function setNavigator(values: {
	userAgent?: string
	doNotTrack?: string | null
}) {
	vi.stubGlobal('navigator', {
		userAgent: values.userAgent ?? BROWSER,
		doNotTrack: values.doNotTrack ?? null,
	})
}

function scrollIntoView(element: Element) {
	for (const observer of observers) {
		if (!observer.targets.includes(element)) continue
		observer.callback(
			[{ target: element, isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver,
		)
	}
}

const bodies = () =>
	fetchMock.mock.calls.map(
		(call) =>
			JSON.parse(String((call[1] as RequestInit).body)) as {
				slug?: string
				host?: string
				events: Array<Record<string, string>>
			},
	)

beforeEach(() => {
	resetPhotoTestClient()
	document.body.innerHTML = ''
	document.documentElement.dataset.tenantApiUrl = 'https://api.test/'
	document.documentElement.dataset.orgSlug = 'acme'
	delete document.documentElement.dataset.customHost
	local = memoryStorage()
	session = memoryStorage()
	vi.stubGlobal('localStorage', local)
	vi.stubGlobal('sessionStorage', session)
	setNavigator({})
	observers = []
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			callback: IntersectionObserverCallback
			targets: Element[] = []
			constructor(callback: IntersectionObserverCallback) {
				this.callback = callback
				observers.push(this)
			}
			observe(target: Element) {
				this.targets.push(target)
			}
			unobserve(target: Element) {
				this.targets = this.targets.filter((entry) => entry !== target)
			}
			disconnect() {
				this.targets = []
			}
		},
	)
	fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('the anonymous client id', () => {
	it('is created once and kept in this browser', () => {
		const id = photoClientId()
		expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/)
		expect(local.getItem(PHOTO_CLIENT_KEY)).toBe(id)
		expect(photoClientId()).toBe(id)
	})

	it('is missing, and the visitor sees A, when storage cannot be written', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => null,
			setItem: () => {
				throw new Error('quota')
			},
		})
		expect(photoClientId()).toBeNull()
		expect(variantFor(TEST)).toBe('A')
	})

	it('is missing when reading storage throws', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('blocked')
			},
		})
		expect(photoClientId()).toBeNull()
	})
})

describe('the variant', () => {
	it('is stable for one browser and about half and half across browsers', () => {
		local.setItem(PHOTO_CLIENT_KEY, 'client-stable-12345')
		const first = variantFor(TEST)
		for (let index = 0; index < 5; index += 1) {
			expect(variantFor(TEST)).toBe(first)
		}
		let b = 0
		for (let index = 0; index < 1000; index += 1) {
			local.setItem(PHOTO_CLIENT_KEY, `visitor-${index}-abcdefgh`)
			if (variantFor(TEST) === 'B') b += 1
		}
		expect(b).toBeGreaterThan(420)
		expect(b).toBeLessThan(580)
	})

	it('is A for a visitor who asks not to be tracked, and no id is made', () => {
		setNavigator({ doNotTrack: '1' })
		expect(variantFor(TEST)).toBe('A')
		expect(local.getItem(PHOTO_CLIENT_KEY)).toBeNull()
	})

	it('is A for a crawler and for a client with no user agent', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
		expect(variantFor(TEST)).toBe('B')
		setNavigator({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })
		expect(variantFor(TEST)).toBe('A')
		setNavigator({ userAgent: '' })
		expect(variantFor(TEST)).toBe('A')
	})
})

describe('swapping to photo B', () => {
	it('swaps a visitor in B to photo B with its crop, and tags the photo', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
		const img = photo()
		applyPhotoTests(document)
		expect(img.getAttribute('src')).toBe('https://cdn.test/b.jpg')
		expect(img.style.objectPosition).toBe('0% 0%')
		expect(img.dataset.photoTestVariant).toBe('B')
	})

	it('keeps a visitor in A on photo A', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'A'))
		const img = photo()
		applyPhotoTests(document)
		expect(img.getAttribute('src')).toBe('https://cdn.test/a.jpg')
		expect(img.getAttribute('style')).toBeNull()
		expect(img.dataset.photoTestVariant).toBe('A')
	})

	it('is idempotent', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
		const img = photo()
		applyPhotoTests(document)
		img.src = 'https://cdn.test/changed-later.jpg'
		applyPhotoTests(document)
		expect(img.getAttribute('src')).toBe('https://cdn.test/changed-later.jpg')
		expect(observers.flatMap((entry) => entry.targets)).toHaveLength(1)
	})

	it('never swaps for a crawler, a visitor who asks not to be tracked or one with no id', () => {
		for (const setup of [
			() => {
				local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
				setNavigator({ userAgent: 'Googlebot/2.1' })
			},
			() => {
				local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
				setNavigator({ doNotTrack: '1' })
			},
			() => {
				setNavigator({})
				vi.stubGlobal('localStorage', undefined)
			},
		]) {
			document.body.innerHTML = ''
			setup()
			const img = photo()
			applyPhotoTests(document)
			expect(img.getAttribute('src')).toBe('https://cdn.test/a.jpg')
			scrollIntoView(img)
			flushPhotoTestEvents()
			expect(fetchMock).not.toHaveBeenCalled()
			expect(observers.flatMap((entry) => entry.targets)).toHaveLength(0)
			resetPhotoTestClient()
		}
	})

	it('refuses a photo B address that is not http(s) or a path on this site', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
		const img = photo({ photoTestSrcB: 'javascript:alert(1)' })
		applyPhotoTests(document)
		expect(img.getAttribute('src')).toBe('https://cdn.test/a.jpg')
		const other = photo({ photoTestSrcB: '//evil.test/b.jpg' })
		applyPhotoTests(document)
		expect(other.getAttribute('src')).toBe('https://cdn.test/a.jpg')
	})

	it('swaps a srcset too, so it does not override photo B', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
		const img = photo()
		img.setAttribute('srcset', 'https://cdn.test/a.jpg 1x')
		applyPhotoTests(document)
		expect(img.getAttribute('srcset')).toBe('https://cdn.test/b.jpg')
	})
})

describe('counting views', () => {
	it('counts a view the first time the photo scrolls into view, once per session', () => {
		const id = idFor(TEST, 'B')
		local.setItem(PHOTO_CLIENT_KEY, id)
		const img = photo()
		applyPhotoTests(document)
		expect(fetchMock).not.toHaveBeenCalled()
		scrollIntoView(img)
		flushPhotoTestEvents()
		expect(bodies()).toEqual([
			{
				slug: 'acme',
				events: [
					{
						testId: TEST,
						itemId: 'dish_1',
						variant: 'B',
						event: 'view',
						key: KEY,
					},
				],
			},
		])

		// The same dish shown again (a second card, an opened modal) is not counted.
		const again = photo()
		applyPhotoTests(document)
		scrollIntoView(again)
		flushPhotoTestEvents()
		expect(fetchMock).toHaveBeenCalledTimes(1)

		// Nor after the page script restarts in the same session.
		resetPhotoTestClient()
		const reloaded = photo()
		applyPhotoTests(document)
		scrollIntoView(reloaded)
		flushPhotoTestEvents()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('still counts when session storage is unavailable', () => {
		vi.stubGlobal('sessionStorage', undefined)
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'A'))
		const img = photo()
		applyPhotoTests(document)
		scrollIntoView(img)
		flushPhotoTestEvents()
		expect(bodies()[0]!.events[0]!.variant).toBe('A')
	})
})

describe('counting adds and the beacon', () => {
	it('emits one add for the photo shown', () => {
		const id = idFor(TEST, 'B')
		local.setItem(PHOTO_CLIENT_KEY, id)
		recordPhotoTestAdd({
			itemId: 'dish_1',
			photoTestId: TEST,
			photoTestKey: KEY,
		})
		flushPhotoTestEvents()
		expect(bodies()).toHaveLength(1)
		expect(bodies()[0]!.events).toEqual([
			{
				testId: TEST,
				itemId: 'dish_1',
				variant: 'B',
				event: 'add',
				key: KEY,
			},
		])
	})

	it("counts nothing for a test without the App's key (an older cart or menu)", () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
		recordPhotoTestAdd({ itemId: 'dish_1', photoTestId: TEST })
		flushPhotoTestEvents()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('counts nothing for a dish that is in no test, or for a visitor who is not counted', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
		recordPhotoTestAdd({ itemId: 'dish_1' })
		setNavigator({ doNotTrack: '1' })
		recordPhotoTestAdd({
			itemId: 'dish_1',
			photoTestId: TEST,
			photoTestKey: KEY,
		})
		flushPhotoTestEvents()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('posts to the tenant API with keepalive and no credentials, and never sends the client id', () => {
		const id = idFor(TEST, 'B')
		local.setItem(PHOTO_CLIENT_KEY, id)
		document.documentElement.dataset.customHost = 'menu.acme.test'
		recordPhotoTestAdd({
			itemId: 'dish_1',
			photoTestId: TEST,
			photoTestKey: KEY,
		})
		flushPhotoTestEvents()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://api.test/forms/dish-photo-events')
		expect(init.method).toBe('POST')
		expect(init.keepalive).toBe(true)
		expect(init.credentials).toBe('omit')
		const body = String(init.body)
		expect(body).not.toContain(id)
		expect(JSON.parse(body)).toEqual({
			slug: 'acme',
			host: 'menu.acme.test',
			events: [
				{
					testId: TEST,
					itemId: 'dish_1',
					variant: 'B',
					event: 'add',
					key: KEY,
				},
			],
		})
	})

	it('sends at most 50 events per request, and sends a full batch at once', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'A'))
		for (let index = 0; index < 50; index += 1) {
			recordPhotoTestAdd({
				itemId: `dish_${index}`,
				photoTestId: TEST,
				photoTestKey: KEY,
			})
		}
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(bodies()[0]!.events).toHaveLength(50)
		for (let index = 0; index < 3; index += 1) {
			recordPhotoTestAdd({
				itemId: `more_${index}`,
				photoTestId: TEST,
				photoTestKey: KEY,
			})
		}
		flushPhotoTestEvents()
		expect(bodies().map((body) => body.events.length)).toEqual([50, 3])
	})

	it('flushes after a short delay and when the page is hidden', () => {
		vi.useFakeTimers()
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'A'))
		recordPhotoTestAdd({
			itemId: 'dish_1',
			photoTestId: TEST,
			photoTestKey: KEY,
		})
		expect(fetchMock).not.toHaveBeenCalled()
		vi.advanceTimersByTime(2500)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		recordPhotoTestAdd({
			itemId: 'dish_2',
			photoTestId: TEST,
			photoTestKey: KEY,
		})
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		})
		document.dispatchEvent(new Event('visibilitychange'))
		expect(fetchMock).toHaveBeenCalledTimes(2)
		Reflect.deleteProperty(document, 'visibilityState')
	})

	it('never throws when the network or the page has no tenant API', async () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'A'))
		fetchMock.mockImplementation(() => {
			throw new Error('offline')
		})
		recordPhotoTestAdd({
			itemId: 'dish_1',
			photoTestId: TEST,
			photoTestKey: KEY,
		})
		expect(() => flushPhotoTestEvents()).not.toThrow()
		fetchMock.mockImplementation(() => Promise.reject(new Error('offline')))
		recordPhotoTestAdd({
			itemId: 'dish_1',
			photoTestId: TEST,
			photoTestKey: KEY,
		})
		expect(() => flushPhotoTestEvents()).not.toThrow()
		delete document.documentElement.dataset.tenantApiUrl
		recordPhotoTestAdd({
			itemId: 'dish_1',
			photoTestId: TEST,
			photoTestKey: KEY,
		})
		expect(() => flushPhotoTestEvents()).not.toThrow()
	})
})

describe('the tests behind a cart', () => {
	it('lists each dish in a test once with the photo this browser showed', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
		expect(
			photoTestsForCart([
				{ itemId: 'dish_1', photoTestId: TEST },
				{ itemId: 'dish_1', photoTestId: TEST },
				{ itemId: 'dish_2' },
			]),
		).toEqual([{ testId: TEST, itemId: 'dish_1', variant: 'B' }])
	})

	it('is empty when no dish is in a test or the visitor is not counted', () => {
		local.setItem(PHOTO_CLIENT_KEY, idFor(TEST, 'B'))
		expect(photoTestsForCart([{ itemId: 'dish_2' }])).toEqual([])
		setNavigator({ doNotTrack: '1' })
		expect(
			photoTestsForCart([{ itemId: 'dish_1', photoTestId: TEST }]),
		).toEqual([])
	})
})
