// @vitest-environment jsdom
/**
 * #89: in Required mode no tracking vendor script loads before Accept, Reject
 * keeps them off, a browser sending GPC is treated as Reject, and a changed tag
 * set asks again. Vendors get their consent APIs: Google Consent Mode v2,
 * TikTok holdConsent / grantConsent and Meta fbq('consent', ...).
 */
import {
	CONSENT_STORAGE_KEY,
	makeConsentChoice,
	type SiteTagIds,
} from '@repo/common/site-consent'
import { beforeEach, describe, expect, it } from 'vitest'
import { SITE_CONSENT_EVENT, startSiteTags, type PixelEnv } from './site-pixels'

const ids: SiteTagIds = {
	facebook: '1234567890',
	tiktok: 'ABCDEFGHIJ',
	googleAnalytics: 'G-ABC123',
	googleTagManager: 'GTM-ABC123',
}

function root(extra: Record<string, string> = {}) {
	const el = document.createElement('div')
	el.dataset.siteGoogleAnalytics = ''
	el.dataset.facebookPixel = ids.facebook!
	el.dataset.tiktokPixel = ids.tiktok!
	el.dataset.googleAnalytics = ids.googleAnalytics!
	el.dataset.googleTagManager = ids.googleTagManager!
	for (const [key, value] of Object.entries(extra)) el.dataset[key] = value
	return el
}

type Calls = { fbq: unknown[][]; ttq: string[] }

function makeEnv(options: { gpc?: boolean; stored?: unknown } = {}) {
	const data = new Map<string, string>()
	if (options.stored !== undefined) {
		data.set(CONSENT_STORAGE_KEY, JSON.stringify(options.stored))
	}
	const scripts: string[] = []
	const calls: Calls = { fbq: [], ttq: [] }
	const win = window as unknown as Record<string, unknown> & Window
	for (const key of [
		'fbq',
		'_fbq',
		'ttq',
		'dataLayer',
		'gtag',
		'TiktokAnalyticsObject',
	]) {
		delete win[key]
	}
	// Record script elements instead of loading them.
	const realCreate = document.createElement.bind(document)
	const appended: HTMLScriptElement[] = []
	const doc = {
		createElement: (tag: string) => realCreate(tag),
		head: {
			appendChild: (node: HTMLScriptElement) => {
				appended.push(node)
				scripts.push(node.src)
				return node
			},
		},
		getElementsByTagName: () => [
			{
				parentNode: {
					insertBefore: (node: HTMLScriptElement) => {
						appended.push(node)
						scripts.push(node.src)
					},
				},
			},
		],
	}
	const listeners = new Map<string, () => void>()
	const fakeWindow = new Proxy(win, {
		get(target, prop) {
			if (prop === 'document') return doc
			if (prop === 'addEventListener') {
				return (type: string, handler: () => void) =>
					listeners.set(type, handler)
			}
			return Reflect.get(target, prop)
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value)
		},
	}) as unknown as PixelEnv['window']
	const env: PixelEnv = {
		window: fakeWindow,
		storage: { getItem: (key: string) => data.get(key) ?? null },
		now: () => Date.UTC(2026, 5, 1),
		gpc: options.gpc ?? false,
	}
	return {
		env,
		scripts,
		calls,
		data,
		/** Simulates the banner saving a choice and announcing it. */
		choose: (analytics: boolean, marketing: boolean) => {
			data.set(
				CONSENT_STORAGE_KEY,
				JSON.stringify(
					makeConsentChoice({ analytics, marketing }, ids, env.now()),
				),
			)
			listeners.get(SITE_CONSENT_EVENT)?.()
		},
		dataLayer: () => (win.dataLayer ?? []) as unknown[],
		fbq: () => win.fbq as ((...a: unknown[]) => void) | undefined,
	}
}

const dataLayerConsent = (layer: unknown[]) =>
	layer
		.map((entry) => Array.from(entry as ArrayLike<unknown>))
		.filter((args) => args[0] === 'consent')

describe('Required mode', () => {
	beforeEach(() => {
		document.head.innerHTML = ''
	})

	it('loads no vendor script before Accept', () => {
		const h = makeEnv()
		startSiteTags(root({ consentMode: 'required' }), h.env)
		expect(h.scripts).toEqual([])
		expect(h.fbq()).toBeUndefined()
		expect(
			(h.env.window as unknown as Record<string, unknown>).ttq,
		).toBeUndefined()
		// Consent Mode v2 starts denied, as data only.
		const consent = dataLayerConsent(h.dataLayer())
		expect(consent[0]).toMatchObject([
			'consent',
			'default',
			{ analytics_storage: 'denied', ad_storage: 'denied' },
		])
	})

	it('Accept loads every tag, each with its consent API', () => {
		const h = makeEnv()
		const controller = startSiteTags(root({ consentMode: 'required' }), h.env)
		h.choose(true, true)
		expect(h.scripts.some((s) => s.includes('connect.facebook.net'))).toBe(true)
		expect(h.scripts.some((s) => s.includes('analytics.tiktok.com'))).toBe(true)
		expect(h.scripts.some((s) => s.includes('gtag/js?id=G-ABC123'))).toBe(true)
		expect(h.scripts.some((s) => s.includes('gtm.js?id=GTM-ABC123'))).toBe(true)
		expect([...controller.booted()].sort()).toEqual([
			'facebook',
			'googleAnalytics',
			'googleTagManager',
			'tiktok',
		])
		const consent = dataLayerConsent(h.dataLayer())
		expect(consent.at(-1)).toMatchObject([
			'consent',
			'update',
			{ analytics_storage: 'granted', ad_storage: 'granted' },
		])
		// Meta: the consent call comes before init and tracking.
		const fbq = h.fbq() as unknown as { queue: unknown[][] }
		const names = fbq.queue.map((args) => `${args[0]}:${args[1]}`)
		expect(names.indexOf('consent:grant')).toBeLessThan(
			names.indexOf('init:1234567890'),
		)
		expect(names).toContain('track:PageView')
	})

	it('Reject keeps everything off', () => {
		const h = makeEnv()
		startSiteTags(root({ consentMode: 'required' }), h.env)
		h.choose(false, false)
		expect(h.scripts).toEqual([])
		expect(h.fbq()).toBeUndefined()
	})

	it('Choose can allow analytics only, or marketing only', () => {
		const analyticsOnly = makeEnv()
		startSiteTags(root({ consentMode: 'required' }), analyticsOnly.env)
		analyticsOnly.choose(true, false)
		expect(analyticsOnly.scripts.some((s) => s.includes('gtag/js'))).toBe(true)
		expect(analyticsOnly.scripts.some((s) => s.includes('facebook'))).toBe(
			false,
		)
		expect(analyticsOnly.scripts.some((s) => s.includes('tiktok'))).toBe(false)

		const marketingOnly = makeEnv()
		startSiteTags(root({ consentMode: 'required' }), marketingOnly.env)
		marketingOnly.choose(false, true)
		expect(marketingOnly.scripts.some((s) => s.includes('facebook'))).toBe(true)
		expect(marketingOnly.scripts.some((s) => s.includes('gtag/js'))).toBe(false)
	})

	it('a stored Accept loads on the next visit, before any click', () => {
		const stored = makeConsentChoice(
			{ analytics: true, marketing: true },
			ids,
			Date.UTC(2026, 4, 1),
		)
		const h = makeEnv({ stored })
		startSiteTags(root({ consentMode: 'required' }), h.env)
		expect(h.scripts.length).toBeGreaterThanOrEqual(4)
	})

	it('Cookie settings reopening the choice can switch the tags off again', () => {
		const h = makeEnv()
		startSiteTags(root({ consentMode: 'required' }), h.env)
		h.choose(true, true)
		const fbq = h.fbq() as unknown as { queue: unknown[][] }
		expect(
			fbq.queue.some((args) => args[0] === 'consent' && args[1] === 'grant'),
		).toBe(true)
		h.choose(false, false)
		// Revoked with the vendor APIs, not just forgotten.
		expect(fbq.queue.filter((args) => args[0] === 'consent').at(-1)).toEqual([
			'consent',
			'revoke',
		])
		expect(dataLayerConsent(h.dataLayer()).at(-1)).toMatchObject([
			'consent',
			'update',
			{ analytics_storage: 'denied', ad_storage: 'denied' },
		])
	})

	it('a changed tag set asks again: nothing loads, even what was accepted', () => {
		const old = makeConsentChoice(
			{ analytics: true, marketing: true },
			{ facebook: '1234567890' },
			Date.UTC(2026, 4, 1),
		)
		const h = makeEnv({ stored: old })
		startSiteTags(root({ consentMode: 'required' }), h.env)
		expect(h.scripts).toEqual([])
	})

	it('a choice older than six months is asked again', () => {
		const old = makeConsentChoice(
			{ analytics: true, marketing: true },
			ids,
			Date.UTC(2025, 10, 1),
		)
		const h = makeEnv({ stored: old })
		startSiteTags(root({ consentMode: 'required' }), h.env)
		expect(h.scripts).toEqual([])
	})
})

describe('Global Privacy Control', () => {
	it('is treated as Reject: nothing loads, in Required and Notice mode', () => {
		for (const mode of ['required', 'notice']) {
			const h = makeEnv({ gpc: true })
			startSiteTags(root({ consentMode: mode }), h.env)
			expect(h.scripts, mode).toEqual([])
			expect(h.fbq(), mode).toBeUndefined()
		}
	})

	it('an explicit Accept by the guest still wins', () => {
		const h = makeEnv({ gpc: true })
		startSiteTags(root({ consentMode: 'required' }), h.env)
		h.choose(true, true)
		expect(h.scripts.length).toBeGreaterThanOrEqual(4)
	})
})

describe('Notice only and Off', () => {
	it('Notice loads the tags, and an opt-out revokes them', () => {
		const h = makeEnv()
		startSiteTags(root({ consentMode: 'notice' }), h.env)
		expect(h.scripts.length).toBeGreaterThanOrEqual(4)
		h.choose(false, false)
		const fbq = h.fbq() as unknown as { queue: unknown[][] }
		expect(fbq.queue.filter((args) => args[0] === 'consent').at(-1)).toEqual([
			'consent',
			'revoke',
		])
	})

	it('no mode (or Off) loads the tags as before the banner existed', () => {
		const h = makeEnv()
		startSiteTags(root(), h.env)
		expect(h.scripts.length).toBeGreaterThanOrEqual(4)
	})

	it('ignores ids of the wrong shape', () => {
		const h = makeEnv()
		const bad = root({ consentMode: 'off' })
		bad.dataset.facebookPixel = 'not-a-pixel'
		bad.dataset.tiktokPixel = '<script>'
		bad.dataset.googleAnalytics = 'UA-1'
		bad.dataset.googleTagManager = 'x'
		startSiteTags(bad, h.env)
		expect(h.scripts).toEqual([])
	})
})
