import { describe, expect, it } from 'vitest'
import {
	actionForPath,
	actionReplacedEverywhere,
	hasExternalTarget,
	kindFromOutboundEvent,
	outboundEventFor,
	pageIsReplaced,
	parseActionTargets,
	resolveActionHref,
	serializeActionTargets,
	stripLocale,
	targetFor,
	validateActionUrl,
	type PublicActionTargets,
} from './action-targets.ts'

const OWN = ['acme.menuza.app', 'www.acme.com']

const menuza: PublicActionTargets = { organization: {}, locations: {} }
const orderElsewhere: PublicActionTargets = {
	organization: {
		order: { mode: 'external', url: 'https://order.toast.example/acme' },
	},
	locations: {},
}

describe('validateActionUrl', () => {
	it('accepts an https link and normalizes it', () => {
		expect(
			validateActionUrl('  https://order.toast.example/acme  ', OWN),
		).toEqual({
			ok: true,
			url: 'https://order.toast.example/acme',
		})
	})
	it('refuses http, javascript, relative and empty links', () => {
		expect(validateActionUrl('http://order.toast.example/acme', OWN)).toEqual({
			ok: false,
			error: 'https_required',
		})
		for (const value of [
			'javascript:alert(1)',
			'data:text/html,x',
			'/menu',
			'order.example',
			'',
			'   ',
			42,
			null,
		]) {
			const result = validateActionUrl(value, OWN)
			expect(result.ok).toBe(false)
		}
		expect(validateActionUrl('https://user:pw@order.example/x', OWN)).toEqual({
			ok: false,
			error: 'invalid_url',
		})
		expect(validateActionUrl('https://localhost/x', OWN)).toEqual({
			ok: false,
			error: 'invalid_url',
		})
	})
	it("refuses the site's own domains and their sub-domains, not look-alikes", () => {
		for (const url of [
			'https://acme.menuza.app/menu',
			'https://www.acme.com/order',
			'https://shop.www.acme.com/order',
			'https://WWW.ACME.COM./order',
		]) {
			expect(validateActionUrl(url, OWN)).toEqual({
				ok: false,
				error: 'own_domain',
			})
		}
		expect(validateActionUrl('https://notacme.com/order', OWN).ok).toBe(true)
		expect(
			validateActionUrl('https://acme.com.evil.example/order', OWN).ok,
		).toBe(true)
	})
})

describe('stored targets', () => {
	it('round-trips and ignores anything unreadable', () => {
		const stored = serializeActionTargets({
			order: { mode: 'external', url: 'https://order.example/x' },
			reservations: { mode: 'menuza' },
		})
		expect(parseActionTargets(stored)).toEqual({
			order: { mode: 'external', url: 'https://order.example/x' },
			reservations: { mode: 'menuza' },
		})
		expect(serializeActionTargets({})).toBeNull()
		expect(parseActionTargets('not json')).toEqual({})
		expect(parseActionTargets(null)).toEqual({})
		// A stored http or javascript address never reaches a visitor.
		expect(
			parseActionTargets({
				order: { mode: 'external', url: 'javascript:alert(1)' },
			}),
		).toEqual({})
		expect(
			parseActionTargets({
				order: { mode: 'external', url: 'http://x.example' },
			}),
		).toEqual({})
	})
})

describe('actionForPath', () => {
	it('maps our own pages to their action, in any language', () => {
		expect(actionForPath('/menu')).toBe('order')
		expect(actionForPath('/ar/menu')).toBe('order')
		expect(actionForPath('/menu/margherita')).toBe('order')
		expect(actionForPath('/drops')).toBe('order')
		expect(actionForPath('/delivery/downtown')).toBe('order')
		expect(actionForPath('/gift-cards')).toBe('gift_cards')
		expect(actionForPath('/fr/gift-cards/balance')).toBe('gift_cards')
		expect(actionForPath('/reserve')).toBe('reservations')
		expect(actionForPath('/reserve/manage')).toBe('reservations')
		expect(actionForPath('/experiences/brunch')).toBe('reservations')
	})
	it('leaves other pages and the order in progress alone', () => {
		for (const path of [
			'/',
			'/about',
			'/menu/checkout',
			'/menu/success',
			'/ar',
			'/events',
			'/careers',
		]) {
			expect(actionForPath(path)).toBeNull()
		}
	})
	it('only strips a language the site offers when given a list', () => {
		expect(stripLocale('/ar/menu', ['en', 'ar'])).toBe('/menu')
		expect(stripLocale('/zh/menu', ['en', 'ar'])).toBe('/zh/menu')
		expect(stripLocale('/ar', ['en', 'ar'])).toBe('/')
	})
})

describe('resolveActionHref: every button follows the setting', () => {
	it('keeps our own pages while the action is Menuza', () => {
		for (const href of [
			'/menu',
			'/menu?item=1',
			'/gift-cards',
			'/reserve',
			'/about',
		]) {
			expect(resolveActionHref(href, menuza)).toMatchObject({
				href,
				external: false,
			})
		}
	})

	it('sends every Order link to the other site, in a new tab, marked as outbound', () => {
		for (const href of [
			'/menu',
			'/menu?location=l1',
			'/ar/menu',
			'/menu/margherita',
			'/delivery/downtown',
		]) {
			expect(resolveActionHref(href, orderElsewhere)).toEqual({
				href: 'https://order.toast.example/acme',
				target: '_blank',
				rel: 'noopener noreferrer',
				external: true,
				kind: 'order',
			})
		}
	})

	it('leaves the other actions, other pages and absolute links alone', () => {
		expect(resolveActionHref('/reserve', orderElsewhere)).toMatchObject({
			href: '/reserve',
			external: false,
		})
		expect(resolveActionHref('/gift-cards', orderElsewhere).external).toBe(
			false,
		)
		expect(resolveActionHref('/about', orderElsewhere).external).toBe(false)
		expect(
			resolveActionHref('https://example.org/menu', orderElsewhere).external,
		).toBe(false)
		expect(
			resolveActionHref('//evil.example/menu', orderElsewhere).external,
		).toBe(false)
		expect(resolveActionHref('mailto:a@b.co', orderElsewhere).external).toBe(
			false,
		)
	})

	it('never finishes an order in progress somewhere else', () => {
		expect(resolveActionHref('/menu/checkout', orderElsewhere).external).toBe(
			false,
		)
		expect(
			resolveActionHref('/menu/success?order=1', orderElsewhere).external,
		).toBe(false)
	})

	it('switching back to Menuza restores every button at once', () => {
		const back: PublicActionTargets = {
			organization: { order: { mode: 'menuza' } },
			locations: {},
		}
		for (const href of ['/menu', '/menu?location=l1', '/menu/margherita']) {
			expect(resolveActionHref(href, back)).toMatchObject({
				href,
				external: false,
			})
		}
	})

	it("a location's own choice wins for links that name it", () => {
		const targets: PublicActionTargets = {
			organization: { order: { mode: 'menuza' } },
			locations: {
				l2: { order: { mode: 'external', url: 'https://l2.example/order' } },
			},
		}
		expect(resolveActionHref('/menu?location=l2', targets)).toMatchObject({
			href: 'https://l2.example/order',
			external: true,
		})
		expect(resolveActionHref('/menu?location=l1', targets).external).toBe(false)
		expect(resolveActionHref('/menu', targets).external).toBe(false)
		expect(targetFor(targets, 'order', 'l2')).toEqual({
			mode: 'external',
			url: 'https://l2.example/order',
		})
		const reversed: PublicActionTargets = {
			organization: {
				order: { mode: 'external', url: 'https://all.example/order' },
			},
			locations: { l1: { order: { mode: 'menuza' } } },
		}
		expect(resolveActionHref('/menu?location=l1', reversed).external).toBe(
			false,
		)
		expect(resolveActionHref('/menu?location=l9', reversed).href).toBe(
			'https://all.example/order',
		)
	})
})

describe('replaced pages', () => {
	it('are replaced only while every place sends the action elsewhere', () => {
		expect(
			actionReplacedEverywhere(orderElsewhere, 'order', ['l1', 'l2']),
		).toBe(true)
		expect(actionReplacedEverywhere(menuza, 'order')).toBe(false)
		const exception: PublicActionTargets = {
			organization: orderElsewhere.organization,
			locations: { l2: { order: { mode: 'menuza' } } },
		}
		expect(actionReplacedEverywhere(exception, 'order', ['l1', 'l2'])).toBe(
			false,
		)
	})
	it('covers the menu and dish pages but not checkout', () => {
		expect(pageIsReplaced('/menu', orderElsewhere)).toBe(true)
		expect(pageIsReplaced('/menu/margherita', orderElsewhere)).toBe(true)
		expect(pageIsReplaced('/menu/checkout', orderElsewhere)).toBe(false)
		expect(pageIsReplaced('/reserve', orderElsewhere)).toBe(false)
		expect(pageIsReplaced('/menu', menuza)).toBe(false)
	})
	it('reports any external target', () => {
		expect(hasExternalTarget(menuza)).toBe(false)
		expect(hasExternalTarget(orderElsewhere)).toBe(true)
		expect(
			hasExternalTarget({
				organization: {},
				locations: {
					l1: {
						reservations: { mode: 'external', url: 'https://r.example/x' },
					},
				},
			}),
		).toBe(true)
	})
})

describe('outbound events', () => {
	it('names one count per action', () => {
		expect(outboundEventFor('order')).toBe('outbound_order')
		expect(outboundEventFor('gift_cards')).toBe('outbound_gift_cards')
		expect(kindFromOutboundEvent('outbound_reservations')).toBe('reservations')
		expect(kindFromOutboundEvent('visit')).toBeNull()
	})
})
