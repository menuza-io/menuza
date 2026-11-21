import { type PublicActionTargets } from '@repo/common/action-targets'
import { describe, expect, it } from 'vitest'
import {
	actionAnchor,
	actionAttrs,
	actionLink,
	externalFor,
	navLinkIsReplaced,
	pageReplaced,
} from './action-targets'

const org = (actionTargets?: PublicActionTargets) => ({
	locales: ['en', 'ar'],
	actionTargets,
})
const orderElsewhere = org({
	organization: {
		order: { mode: 'external', url: 'https://order.toast.example/acme' },
	},
	locations: {},
})

describe('Sites: every button follows the setting (#318)', () => {
	it('leaves every link alone while the site has no setting', () => {
		for (const organization of [
			org(),
			null,
			undefined,
			org({ organization: {}, locations: {} }),
		]) {
			for (const href of ['/menu', '/gift-cards', '/reserve', '/about']) {
				expect(actionLink(organization, href)).toMatchObject({
					href,
					external: false,
				})
			}
		}
	})

	it('changes the Order button everywhere the site builds one, in any language', () => {
		const localize = (path: string) => `/ar${path}`
		for (const path of [
			'/menu',
			'/menu?location=l1',
			'/menu?item=dish1',
			'/menu/margherita',
			'/ar/menu',
			'/delivery/downtown',
		]) {
			const anchor = actionAnchor(orderElsewhere, path, localize)
			expect(anchor.href).toBe('https://order.toast.example/acme')
			expect(anchor.attrs).toEqual({
				target: '_blank',
				rel: 'noopener noreferrer',
				'data-outbound': 'order',
			})
		}
	})

	it('keeps our pages, with the visitor language, for the other actions', () => {
		const anchor = actionAnchor(
			orderElsewhere,
			'/reserve',
			(path) => `/ar${path}`,
		)
		expect(anchor).toEqual({ href: '/ar/reserve', attrs: {}, external: false })
	})

	it('switching back restores the Menuza links', () => {
		const back = org({
			organization: { order: { mode: 'menuza' } },
			locations: {},
		})
		expect(actionAnchor(back, '/menu?item=1', (path) => path).href).toBe(
			'/menu?item=1',
		)
		expect(actionAttrs(actionLink(back, '/menu'))).toEqual({})
	})

	it('marks the link for the outbound count and nothing else', () => {
		expect(actionAttrs(actionLink(orderElsewhere, '/menu'))).toEqual({
			target: '_blank',
			rel: 'noopener noreferrer',
			'data-outbound': 'order',
		})
	})

	it('never sends an order in progress away', () => {
		expect(actionLink(orderElsewhere, '/menu/checkout').external).toBe(false)
		expect(actionLink(orderElsewhere, '/menu/success?order=1').external).toBe(
			false,
		)
	})

	it("uses a location's own choice for a button that names it", () => {
		const mixed = org({
			organization: { order: { mode: 'menuza' } },
			locations: {
				l2: { order: { mode: 'external', url: 'https://l2.example/order' } },
			},
		})
		expect(actionLink(mixed, '/menu?location=l2').href).toBe(
			'https://l2.example/order',
		)
		expect(actionLink(mixed, '/menu?location=l1').external).toBe(false)
		expect(externalFor(mixed, 'order')).toBe(true)
		expect(externalFor(mixed, 'gift_cards')).toBe(false)
	})
})

describe('Sites: our own pages for a replaced action (#318)', () => {
	it('drops the menu from the navigation and the footer, not other links', () => {
		expect(navLinkIsReplaced(orderElsewhere, '/menu')).toBe(true)
		expect(
			navLinkIsReplaced(orderElsewhere, { type: 'url', url: '/menu' }),
		).toBe(true)
		expect(
			navLinkIsReplaced(orderElsewhere, { type: 'page', pageSlug: 'about' }),
		).toBe(false)
		expect(navLinkIsReplaced(orderElsewhere, '/reserve')).toBe(false)
		expect(navLinkIsReplaced(orderElsewhere, 'https://example.org/menu')).toBe(
			false,
		)
		expect(navLinkIsReplaced(orderElsewhere, 'mailto:hello@acme.example')).toBe(
			false,
		)
	})

	it('restores the navigation when ordering is on Menuza again', () => {
		expect(navLinkIsReplaced(org(), '/menu')).toBe(false)
		expect(
			navLinkIsReplaced(
				org({ organization: { order: { mode: 'menuza' } }, locations: {} }),
				'/menu',
			),
		).toBe(false)
	})

	it('keeps the menu in the navigation while one location still orders through Menuza', () => {
		const exception = org({
			organization: {
				order: { mode: 'external', url: 'https://order.example/x' },
			},
			locations: { l2: { order: { mode: 'menuza' } } },
		})
		expect(navLinkIsReplaced(exception, '/menu')).toBe(false)
		expect(pageReplaced(exception, '/menu')).toBe(false)
	})

	it('marks the menu and dish pages noindex, not checkout', () => {
		expect(pageReplaced(orderElsewhere, '/menu')).toBe(true)
		expect(pageReplaced(orderElsewhere, '/ar/menu/margherita')).toBe(true)
		expect(pageReplaced(orderElsewhere, '/menu/checkout')).toBe(false)
		expect(pageReplaced(orderElsewhere, '/about')).toBe(false)
		expect(pageReplaced(org(), '/menu')).toBe(false)
	})
})
