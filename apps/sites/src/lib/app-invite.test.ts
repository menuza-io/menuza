import { describe, expect, it } from 'vitest'
import {
	bannerDecision,
	type BannerInput,
	isCartOrCheckoutPath,
	platformFromUserAgent,
	storeTapPath,
} from './app-invite'

const DAY = 86_400_000
const base: BannerInput = {
	now: 1_800_000_000_000,
	platform: 'ios',
	enabled: true,
	stores: {
		ios: '/get-app?store=app_store&p=banner',
		android: '/get-app?store=play_store&p=banner',
	},
	inApp: false,
	pathname: '/',
	dismissedAt: null,
	visits: 2,
	ordered: false,
}

describe('the phone banner (#196)', () => {
	it('shows on a phone on the second visit', () => {
		expect(bannerDecision(base)).toEqual({ show: true, platform: 'ios' })
		expect(bannerDecision({ ...base, platform: 'android' })).toEqual({
			show: true,
			platform: 'android',
		})
	})

	it('shows after the first order, even on the first visit', () => {
		expect(bannerDecision({ ...base, visits: 1, ordered: true })).toEqual({
			show: true,
			platform: 'ios',
		})
	})

	it('waits on a first visit with no order', () => {
		expect(bannerDecision({ ...base, visits: 1 })).toEqual({
			show: false,
			reason: 'too_early',
		})
	})

	it('can be dismissed for 30 days on that device, then returns', () => {
		const dismissed = base.now - 29 * DAY
		expect(bannerDecision({ ...base, dismissedAt: dismissed })).toEqual({
			show: false,
			reason: 'dismissed',
		})
		expect(
			bannerDecision({ ...base, dismissedAt: base.now - 31 * DAY }),
		).toEqual({ show: true, platform: 'ios' })
	})

	it('never shows on a desktop, switched off, or without a live store for that phone', () => {
		expect(bannerDecision({ ...base, platform: 'other' })).toEqual({
			show: false,
			reason: 'not_a_phone',
		})
		expect(bannerDecision({ ...base, enabled: false })).toEqual({
			show: false,
			reason: 'off',
		})
		expect(bannerDecision({ ...base, stores: { android: 'x' } })).toEqual({
			show: false,
			reason: 'no_live_store',
		})
		expect(bannerDecision({ ...base, stores: {} })).toEqual({
			show: false,
			reason: 'no_live_store',
		})
	})

	it('never shows inside the app’s own web views', () => {
		expect(bannerDecision({ ...base, inApp: true })).toEqual({
			show: false,
			reason: 'in_app',
		})
	})

	it('never shows on the cart or checkout pages', () => {
		for (const path of [
			'/menu/checkout',
			'/ar/menu/checkout',
			'/menu/payment',
			'/menu/pay',
		]) {
			expect(isCartOrCheckoutPath(path)).toBe(true)
			expect(bannerDecision({ ...base, pathname: path })).toEqual({
				show: false,
				reason: 'cart_or_checkout',
			})
		}
		expect(isCartOrCheckoutPath('/menu')).toBe(false)
		expect(isCartOrCheckoutPath('/menu/success')).toBe(false)
	})
})

describe('platform and taps', () => {
	it('reads the platform from the user agent', () => {
		expect(
			platformFromUserAgent(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
			),
		).toBe('ios')
		expect(
			platformFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)'),
		).toBe('android')
		expect(
			platformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'),
		).toBe('other')
	})

	it('counts a tap through the site’s own redirect, never a store link in the query', () => {
		expect(storeTapPath('app_store', 'banner')).toBe(
			'/get-app?store=app_store&p=banner',
		)
		expect(storeTapPath('play_store', 'footer', '/ar')).toBe(
			'/ar/get-app?store=play_store&p=footer',
		)
	})
})

describe('the browser side', async () => {
	const { runAppInviteBanner } = await import('./app-invite-client')
	const { INVITE_STORAGE } = await import('./app-invite')

	function setup(options: {
		ua: string
		url?: string
		local?: Record<string, string>
		session?: Record<string, string>
	}) {
		const makeStorage = (initial: Record<string, string>) => {
			const map = new Map(Object.entries(initial))
			return {
				getItem: (key: string) => map.get(key) ?? null,
				setItem: (key: string, value: string) => void map.set(key, value),
				map,
			}
		}
		const local = makeStorage(options.local ?? {})
		const session = makeStorage(options.session ?? {})
		const handlers: Array<() => void> = []
		const link = { href: '' }
		const root = {
			hidden: true,
			dataset: {
				iosHref: '/get-app?store=app_store&p=banner',
				androidHref: '/get-app?store=play_store&p=banner',
			},
			querySelector: (selector: string) =>
				selector === '[data-app-invite-link]'
					? link
					: {
							addEventListener: (_: string, handler: () => void) =>
								handlers.push(handler),
						},
		} as unknown as HTMLElement
		const win = {
			location: { href: options.url ?? 'https://acme.menuza.io/' },
			navigator: { userAgent: options.ua },
			localStorage: local,
			sessionStorage: session,
		} as unknown as Window
		return { root, win, local, session, handlers, link }
	}
	const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'

	it('counts one visit per session and shows on the second', () => {
		const first = setup({ ua: IPHONE })
		runAppInviteBanner(first.root, first.win)
		expect(first.root.hidden).toBe(true)
		expect(first.local.map.get(INVITE_STORAGE.visits)).toBe('1')
		// A reload in the same session is not another visit.
		runAppInviteBanner(first.root, first.win)
		expect(first.local.map.get(INVITE_STORAGE.visits)).toBe('1')
		// A new session on the same device is the second visit.
		const second = setup({
			ua: IPHONE,
			local: { [INVITE_STORAGE.visits]: '1' },
		})
		runAppInviteBanner(second.root, second.win)
		expect(second.root.hidden).toBe(false)
		expect(second.link.href).toBe('/get-app?store=app_store&p=banner')
	})

	it('notes an order from the confirmation page and shows the banner', () => {
		const page = setup({
			ua: IPHONE,
			url: 'https://acme.menuza.io/menu/success?order=ord_1',
		})
		runAppInviteBanner(page.root, page.win)
		expect(page.local.map.get(INVITE_STORAGE.ordered)).toBe('1')
		expect(page.root.hidden).toBe(false)
	})

	it('dismisses for 30 days', () => {
		const page = setup({ ua: IPHONE, local: { [INVITE_STORAGE.visits]: '2' } })
		runAppInviteBanner(page.root, page.win)
		expect(page.root.hidden).toBe(false)
		page.handlers[0]!()
		expect(page.root.hidden).toBe(true)
		expect(
			Number(page.local.map.get(INVITE_STORAGE.dismissedAt)),
		).toBeGreaterThan(0)
		const again = setup({
			ua: IPHONE,
			local: {
				[INVITE_STORAGE.visits]: '3',
				[INVITE_STORAGE.dismissedAt]: page.local.map.get(
					INVITE_STORAGE.dismissedAt,
				)!,
			},
		})
		runAppInviteBanner(again.root, again.win)
		expect(again.root.hidden).toBe(true)
	})

	it('stays hidden inside the app’s web view, even on a return visit', () => {
		const inApp = setup({
			ua: IPHONE,
			url: 'https://acme.menuza.io/menu?inapp=1',
			local: { [INVITE_STORAGE.visits]: '5', [INVITE_STORAGE.ordered]: '1' },
		})
		runAppInviteBanner(inApp.root, inApp.win)
		expect(inApp.root.hidden).toBe(true)
		const marked = setup({
			ua: `${IPHONE} MenuzaCustomerApp/1.0`,
			local: { [INVITE_STORAGE.visits]: '5' },
		})
		runAppInviteBanner(marked.root, marked.win)
		expect(marked.root.hidden).toBe(true)
	})

	it('stays hidden on a desktop and when storage is blocked', () => {
		const desktop = setup({
			ua: 'Mozilla/5.0 (Macintosh)',
			local: { [INVITE_STORAGE.visits]: '9' },
		})
		runAppInviteBanner(desktop.root, desktop.win)
		expect(desktop.root.hidden).toBe(true)
		const blocked = setup({ ua: IPHONE })
		Object.defineProperty(blocked.win, 'localStorage', {
			get() {
				throw new Error('blocked')
			},
		})
		Object.defineProperty(blocked.win, 'sessionStorage', {
			get() {
				throw new Error('blocked')
			},
		})
		expect(() => runAppInviteBanner(blocked.root, blocked.win)).not.toThrow()
		expect(blocked.root.hidden).toBe(true)
	})
})
