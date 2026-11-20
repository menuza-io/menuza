import { describe, expect, it } from 'vitest'
import {
	couponValidOnline,
	frequencyAllows,
	pickPopup,
	popupCouponHref,
	popupExcludedPath,
	popupMatchesPage,
	popupPageKey,
	popupWindowOpen,
	sitePopupInputSchema,
} from './site-popup'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)

describe('pages a popup never covers (#132)', () => {
	it.each([
		'/checkout',
		'/menu/checkout',
		'/ar/checkout',
		'/payment',
		'/profile',
		'/profile/orders',
		'/account',
		'/login',
		'/verify',
		'/menu/success',
		'/reserve/manage',
		'/reserve/pay',
		'/shop/success',
		'/cart',
	])('never shows on %s', (path) => {
		expect(popupExcludedPath(path)).toBe(true)
		expect(popupMatchesPage(['all'], path)).toBe(false)
	})

	it.each([
		'/',
		'/menu',
		'/menu/margherita',
		'/about',
		'/ar',
		'/ar/menu',
		'/events',
	])('may show on %s', (path) => {
		expect(popupExcludedPath(path)).toBe(false)
		expect(popupMatchesPage(['all'], path)).toBe(true)
	})

	it('a dish page is a menu page, whatever the dish is called', () => {
		expect(popupExcludedPath('/menu/margherita')).toBe(false)
		expect(popupExcludedPath('/menu/margherita/pay')).toBe(false)
		expect(popupExcludedPath('/ar/menu/checkout')).toBe(true)
	})

	it('keeps to the chosen pages', () => {
		expect(popupPageKey('/')).toBe('home')
		expect(popupPageKey('/ar')).toBe('home')
		expect(popupPageKey('/menu')).toBe('menu')
		expect(popupPageKey('/ar/menu')).toBe('menu')
		expect(popupPageKey('/events')).toBe('other')
		expect(popupMatchesPage(['menu'], '/menu')).toBe(true)
		expect(popupMatchesPage(['menu'], '/')).toBe(false)
		expect(popupMatchesPage(['home', 'menu'], '/events')).toBe(false)
		expect(popupMatchesPage(['other'], '/events')).toBe(true)
	})
})

describe('frequency cap (#132)', () => {
	it('shows a popup nobody closed', () => {
		for (const frequency of ['session', 'day', 'week', 'ever'] as const) {
			expect(frequencyAllows(frequency, null, NOW)).toBe(true)
		}
	})

	it('keeps a closed popup away for the whole window', () => {
		expect(frequencyAllows('day', NOW - 2 * 60 * 60 * 1000, NOW)).toBe(false)
		expect(frequencyAllows('day', NOW - DAY + 1, NOW)).toBe(false)
		expect(frequencyAllows('day', NOW - DAY, NOW)).toBe(true)
		expect(frequencyAllows('week', NOW - 6 * DAY, NOW)).toBe(false)
		expect(frequencyAllows('week', NOW - 7 * DAY, NOW)).toBe(true)
		expect(frequencyAllows('ever', NOW - 400 * DAY, NOW)).toBe(false)
	})

	it('a session cap blocks only inside the session', () => {
		expect(frequencyAllows('session', NOW - 1000, NOW, true)).toBe(false)
		expect(frequencyAllows('session', NOW - 1000, NOW, false)).toBe(true)
	})
})

describe('which popup shows (#132)', () => {
	const popup = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		pages: ['all' as const],
		startsAt: null,
		endsAt: null,
		frequency: 'day' as const,
		...extra,
	})
	const input = { pathname: '/menu', now: NOW, closedAt: {} }

	it('shows at most one: the most recently started wins', () => {
		const picked = pickPopup(
			[
				popup('old', { startsAt: '2026-10-01T00:00:00Z' }),
				popup('new', { startsAt: '2026-11-10T00:00:00Z' }),
				popup('never-dated'),
			],
			input,
		)
		expect(picked?.id).toBe('new')
	})

	it('respects dates, pages and the cap', () => {
		expect(
			pickPopup([popup('later', { startsAt: '2026-12-01T00:00:00Z' })], input),
		).toBeNull()
		expect(
			pickPopup([popup('over', { endsAt: '2026-11-19T00:00:00Z' })], input),
		).toBeNull()
		expect(
			pickPopup([popup('menu-only', { pages: ['menu'] })], {
				...input,
				pathname: '/',
			}),
		).toBeNull()
		expect(
			pickPopup([popup('seen')], {
				...input,
				closedAt: { seen: NOW - 3600_000 },
			}),
		).toBeNull()
		// Closed popups do not hide another one.
		expect(
			pickPopup([popup('seen'), popup('other')], {
				...input,
				closedAt: { seen: NOW - 3600_000 },
			})?.id,
		).toBe('other')
	})

	it('never shows on checkout, payment or account pages', () => {
		for (const pathname of [
			'/checkout',
			'/menu/checkout',
			'/profile',
			'/payment',
		]) {
			expect(pickPopup([popup('a')], { ...input, pathname })).toBeNull()
		}
	})

	it('window open uses start and end', () => {
		expect(
			popupWindowOpen('2026-11-20T00:00:00Z', '2026-11-21T00:00:00Z', NOW),
		).toBe(true)
		expect(popupWindowOpen('2026-11-20T13:00:00Z', null, NOW)).toBe(false)
		expect(popupWindowOpen(null, '2026-11-20T12:00:00Z', NOW)).toBe(false)
	})
})

describe('the coupon (#132)', () => {
	const facts = {
		status: 'active',
		application: 'code',
		channels: ['web', 'pos'],
		startsAt: null,
		endsAt: null,
		localNow: '2026-11-20T15:00',
		totalLimit: null,
		uses: 0,
		codes: ['WELCOME'],
	}
	it('accepts an active online code', () => {
		expect(couponValidOnline(facts)).toBe(true)
	})
	it('refuses an in-store-only, paused, expired, early, used up or code-less coupon', () => {
		expect(couponValidOnline({ ...facts, channels: ['pos'] })).toBe(false)
		expect(couponValidOnline({ ...facts, status: 'paused' })).toBe(false)
		expect(couponValidOnline({ ...facts, endsAt: '2026-11-20T15:00' })).toBe(
			false,
		)
		expect(couponValidOnline({ ...facts, startsAt: '2026-11-21T00:00' })).toBe(
			false,
		)
		expect(couponValidOnline({ ...facts, totalLimit: 10, uses: 10 })).toBe(
			false,
		)
		expect(couponValidOnline({ ...facts, codes: [] })).toBe(false)
		expect(couponValidOnline({ ...facts, application: 'automatic' })).toBe(
			false,
		)
		// Unknown usage does not block (the region checks at checkout).
		expect(couponValidOnline({ ...facts, totalLimit: 10, uses: null })).toBe(
			true,
		)
	})
	it('the button applies the coupon through /menu?coupon=', () => {
		expect(popupCouponHref('WELCOME')).toBe('/menu?coupon=WELCOME')
		expect(popupCouponHref('A B&C')).toBe('/menu?coupon=A%20B%26C')
	})
})

describe('popup input', () => {
	const base = { name: 'Welcome', title: 'Get 10% off' }
	it('takes sensible defaults', () => {
		const parsed = sitePopupInputSchema.parse(base)
		expect(parsed).toMatchObject({
			trigger: 'delay',
			frequency: 'day',
			pages: ['all'],
			captureContact: 'none',
		})
	})
	it('needs consent wording for a signup and a sane end', () => {
		expect(
			sitePopupInputSchema.safeParse({ ...base, captureContact: 'email' })
				.success,
		).toBe(false)
		expect(
			sitePopupInputSchema.safeParse({
				...base,
				captureContact: 'email',
				consentText: 'Email me offers',
			}).success,
		).toBe(true)
		expect(
			sitePopupInputSchema.safeParse({
				...base,
				startsAt: '2026-11-20T10:00:00Z',
				endsAt: '2026-11-19T10:00:00Z',
			}).success,
		).toBe(false)
		expect(sitePopupInputSchema.safeParse({ name: 'x' }).success).toBe(false)
	})
})
