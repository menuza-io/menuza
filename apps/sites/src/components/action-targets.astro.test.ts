/**
 * #318: with Order online sent to another site, every Order button changes,
 * the menu leaves the navigation, and switching back restores them all.
 * Run with `vitest -c vitest.astro.config.ts`.
 */
import { type PublicActionTargets } from '@repo/common/action-targets'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it, vi } from 'vitest'
import { createSiteI18n } from '~/lib/i18n'
import SiteAnchor from './SiteAnchor.astro'
import SiteFooter from './SiteFooter.astro'
import SiteHeader from './SiteHeader.astro'
import ReservationBlock from './blocks/ReservationBlock.astro'

const org = vi.hoisted(() => ({
	fetchPublishedReservations: vi.fn(),
	fetchPublishedSitePage: vi.fn(),
}))
vi.mock('~/lib/org', () => org)
vi.mock('varlock/env', () => ({ ENV: {} }))

const ORDER_URL = 'https://order.toast.example/acme'
const elsewhere: PublicActionTargets = {
	organization: { order: { mode: 'external', url: ORDER_URL } },
	locations: {},
}
const menuza: PublicActionTargets = {
	organization: { order: { mode: 'menuza' } },
	locations: {},
}

function organizationWith(actionTargets?: PublicActionTargets) {
	return {
		id: 'org_1',
		name: 'Acme',
		slug: 'acme',
		locales: ['en', 'ar'],
		defaultLocale: 'en',
		siteIcon: null,
		actionTargets,
	}
}

async function render(
	component: unknown,
	props: Record<string, unknown>,
	targets?: PublicActionTargets,
	slots: Record<string, string> = {},
	locale = 'en',
) {
	const container = await AstroContainer.create()
	return container.renderToString(component as never, {
		props,
		slots,
		locals: {
			organization: organizationWith(targets),
			i18n: createSiteI18n(locale),
			requestedLocale: locale,
			defaultLocale: 'en',
		} as never,
	})
}

const anchors = (html: string) =>
	[...html.matchAll(/<a\b[^>]*>/gu)].map((match) => match[0])

describe('SiteAnchor follows the setting (#318)', () => {
	it('sends an Order button to the other site, in a new tab, marked for the count', async () => {
		const html = await render(SiteAnchor, { link: '/menu' }, elsewhere, {
			default: 'Order online',
		})
		expect(html).toContain(`href="${ORDER_URL}"`)
		expect(html).toContain('target="_blank"')
		expect(html).toContain('rel="noopener noreferrer"')
		expect(html).toContain('data-outbound="order"')
	})

	it('does the same for a structured link object and a menu path with a query', async () => {
		for (const link of [
			{ type: 'url', url: '/menu?location=l1' },
			{ type: 'url', url: '/ar/menu' },
			'/menu/margherita',
		]) {
			const html = await render(SiteAnchor, { link }, elsewhere, {
				default: 'Order',
			})
			expect(html).toContain(`href="${ORDER_URL}"`)
		}
	})

	it('keeps our page, with the visitor language, while ordering is on Menuza', async () => {
		for (const targets of [undefined, menuza]) {
			const html = await render(
				SiteAnchor,
				{ link: '/menu' },
				targets,
				{ default: 'Order' },
				'ar',
			)
			expect(html).toContain('href="/ar/menu"')
			expect(html).not.toContain('data-outbound')
			expect(html).not.toContain('target="_blank"')
		}
	})

	it('leaves the other actions and pages alone', async () => {
		for (const link of ['/reserve', '/gift-cards', '/about']) {
			const html = await render(SiteAnchor, { link }, elsewhere, {
				default: 'Go',
			})
			expect(html).not.toContain(ORDER_URL)
			expect(html).not.toContain('data-outbound')
		}
	})
})

describe('the header and footer (#318)', () => {
	const config = {
		navLinks: [
			{ label: 'Menu', url: '/menu' },
			{ label: 'About', url: '/about' },
			{ label: 'Book', url: '/reserve' },
		],
		ctaLabel: 'Order online',
		ctaUrl: '/menu',
		showCta: true,
	}
	const props = (extra: Record<string, unknown> = {}) => ({
		config,
		organization: organizationWith(),
		locales: [],
		...extra,
	})

	it('drops the menu from the navigation and sends the Order button elsewhere', async () => {
		const html = await render(SiteHeader, props(), elsewhere)
		const links = anchors(html)
		expect(html).not.toContain('>Menu<')
		expect(html).toContain('About')
		expect(html).toContain('Book')
		expect(links.some((tag) => tag.includes('href="/about"'))).toBe(true)
		// The call to action is now the other site.
		expect(html).toContain(`href="${ORDER_URL}"`)
		expect(html).toContain('data-outbound="order"')
		// No link to our own menu is left in the header.
		expect(
			links.some((tag) => /href="\/(?:ar\/)?menu(?:[/?"])/u.test(tag)),
		).toBe(false)
	})

	it('switching back restores the menu link and the Order button', async () => {
		for (const targets of [undefined, menuza]) {
			const html = await render(SiteHeader, props(), targets)
			expect(html).toContain('>Menu<')
			expect(anchors(html).some((tag) => tag.includes('href="/menu"'))).toBe(
				true,
			)
			expect(html).not.toContain(ORDER_URL)
			expect(html).not.toContain('data-outbound')
		}
	})

	it('drops the menu from footer columns while ordering is elsewhere', async () => {
		const footer = {
			columns: [
				{
					title: 'Eat',
					links: [
						{ label: 'Our menu', url: '/menu' },
						{ label: 'Careers', url: '/careers' },
					],
				},
			],
		}
		const html = await render(
			SiteFooter,
			{ config: footer, organization: organizationWith() },
			elsewhere,
		)
		expect(html).not.toContain('Our menu')
		expect(html).toContain('Careers')
		const back = await render(
			SiteFooter,
			{ config: footer, organization: organizationWith() },
			menuza,
		)
		expect(back).toContain('Our menu')
	})
})

describe('the reservation section (#318)', () => {
	const bookElsewhere: PublicActionTargets = {
		organization: {
			reservations: { mode: 'external', url: 'https://book.example/acme' },
		},
		locations: {},
	}

	it('is a button to the other booking site, even while our own booking is off', async () => {
		org.fetchPublishedReservations.mockResolvedValue(null)
		const html = await render(
			ReservationBlock,
			{
				config: {
					heading: 'Reserve',
					buttonLabel: 'Book a table',
					layout: 'inline',
				},
			},
			bookElsewhere,
		)
		expect(html).toContain('href="https://book.example/acme"')
		expect(html).toContain('target="_blank"')
		expect(html).toContain('data-outbound="reservations"')
		// Our own booking form is not used.
		expect(html).not.toContain('data-reservation-bar')
	})

	it('shows nothing while our booking is off and nothing is set', async () => {
		org.fetchPublishedReservations.mockResolvedValue(null)
		const html = await render(ReservationBlock, {
			config: { heading: 'Reserve' },
		})
		expect(html).not.toContain('data-reservation-block')
	})
})
