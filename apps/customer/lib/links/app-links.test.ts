import { buildLink, type GuestLinkType } from '@repo/common/links'
import {
	resolveIncomingLink,
	routerTarget,
	shouldOpenResolvedWebInBrowser,
} from './app-links'

const bound = {
	siteAddress: {
		slug: 'acme',
		host: 'acme.menuza.io',
		origin: 'https://acme.menuza.io',
	},
}
const unbound = { siteAddress: { slug: null, host: null, origin: null } }
const HEX = 'c'.repeat(64)
const link = (
	type: GuestLinkType,
	params: Record<string, string>,
	origin = 'https://acme.menuza.io',
) => buildLink(type, params, { origin })!

describe('incoming links in the customer app (#195)', () => {
	it('an order link opens the order screen, with its token held in memory only', () => {
		const resolved = resolveIncomingLink(
			link('order', { order: 'ord_1', link: HEX }),
			bound,
			'ios',
		)
		expect(resolved.kind).toBe('app')
		const target = routerTarget(resolved)
		expect(target).toEqual({ pathname: '/orders/ord_1', params: { link: HEX } })
	})

	it('maps menu, dish, coupon, booking, rewards and gift card links to screens', () => {
		const cases: Array<[string, string]> = [
			[link('menu_home', {}), '/menu'],
			[link('dish', { item: 'i1' }), '/menu'],
			[link('coupon', { coupon: 'WELCOME' }), '/menu'],
			[link('reserve', {}), '/reservations'],
			[link('reservation', { token: 'tok-ABCDEFGH' }), '/reservations'],
			[link('waitlist', { token: 'tok-ABCDEFGH' }), '/reservations/waitlist'],
			[link('loyalty', {}), '/rewards'],
			[link('gift_cards', {}), '/gift-cards'],
		]
		for (const [url, path] of cases) {
			expect(
				routerTarget(resolveIncomingLink(url, bound, 'android'))?.pathname,
			).toBe(path)
		}
		expect(
			routerTarget(
				resolveIncomingLink(link('dish', { item: 'i1' }), bound, 'ios'),
			)?.params,
		).toEqual({ item: 'i1' })
	})

	it('opens the website for another organization, for web-only types and in the shared app', () => {
		const other = link('order', { order: 'o1' }, 'https://other.menuza.io')
		expect(routerTarget(resolveIncomingLink(other, bound, 'ios'))).toBeNull()
		expect(resolveIncomingLink(other, bound, 'ios')).toMatchObject({
			kind: 'web',
			reason: 'other_host',
		})
		expect(
			resolveIncomingLink(
				link('cart', { cart: '1700000000000.c1.' + HEX }),
				bound,
				'ios',
			),
		).toMatchObject({ kind: 'web', reason: 'not_in_app' })
		expect(
			resolveIncomingLink(link('order', { order: 'o1' }), unbound, 'ios'),
		).toMatchObject({ kind: 'web', reason: 'other_host' })
	})

	it('opens the in-app browser only for safe fallback reasons on this host', () => {
		const cart = resolveIncomingLink(
			link('cart', { cart: '1700000000000.c1.' + HEX }),
			bound,
			'ios',
		)
		expect(shouldOpenResolvedWebInBrowser(cart)).toBe(true)
		const foreign = resolveIncomingLink(
			link('order', { order: 'o1' }, 'https://other.menuza.io'),
			bound,
			'ios',
		)
		expect(shouldOpenResolvedWebInBrowser(foreign)).toBe(false)
	})
})
