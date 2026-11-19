/**
 * #89, #260: the footer, checkout, booking, apply and sign-in screens link to
 * the restaurant's published legal pages (and only those), the footer offers
 * "Cookie settings" when the banner applies, and the banner renders as a
 * labelled, non-modal region. Run with `vitest -c vitest.astro.config.ts`.
 */
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it, vi } from 'vitest'
import { createSiteI18n } from '~/lib/i18n'
import ConsentBanner from '../components/ConsentBanner.astro'
import LegalLinks from '../components/LegalLinks.astro'
import SiteFooter from '../components/SiteFooter.astro'

vi.mock('~/lib/org', () => ({}))
vi.mock('varlock/env', () => ({ ENV: {} }))

const base = {
	id: 'org_1',
	name: 'Al Bait',
	slug: 'albait',
	locales: ['en', 'ar'],
	defaultLocale: 'en',
}

function locals(organization: Record<string, unknown>, locale = 'en') {
	return {
		organization: { ...base, ...organization },
		i18n: createSiteI18n(locale),
		requestedLocale: locale,
		defaultLocale: 'en',
	} as never
}

async function render(
	component: unknown,
	organization: Record<string, unknown>,
	props: Record<string, unknown> = {},
	locale = 'en',
) {
	const container = await AstroContainer.create()
	return container.renderToString(component as never, {
		props,
		locals: locals(organization, locale),
	})
}

describe('legal links on the site (#89, #260)', () => {
	const published = {
		legalPages: {
			privacy: '/privacy',
			terms: '/terms',
			cookies: '/cookies',
			accessibility: '/accessibility',
		},
	}

	it('the footer links every published legal page', async () => {
		const html = await render(SiteFooter, published, {
			config: {},
			organization: { name: 'Al Bait' },
		})
		for (const kind of ['privacy', 'terms', 'cookies', 'accessibility']) {
			expect(html).toContain(`data-legal-link="${kind}"`)
			expect(html).toContain(`href="/${kind}"`)
		}
		expect(html).toContain('Accessibility statement')
		expect(html).toContain('Privacy policy')
	})

	it('the footer shows no link for a page that is not published', async () => {
		const html = await render(
			SiteFooter,
			{ legalPages: { privacy: '/privacy' } },
			{ config: {}, organization: { name: 'Al Bait' } },
		)
		expect(html).toContain('data-legal-link="privacy"')
		expect(html).not.toContain('data-legal-link="accessibility"')
		expect(html).not.toContain('data-legal-link="terms"')
		const none = await render(
			SiteFooter,
			{},
			{
				config: {},
				organization: { name: 'Al Bait' },
			},
		)
		expect(none).not.toContain('data-legal-link')
	})

	it('the accessibility link appears only once that page is published', async () => {
		const without = await render(
			SiteFooter,
			{
				legalPages: { privacy: '/privacy', terms: '/terms' },
			},
			{ config: {}, organization: { name: 'Al Bait' } },
		)
		expect(without).not.toContain('/accessibility')
		const withIt = await render(SiteFooter, published, {
			config: {},
			organization: { name: 'Al Bait' },
		})
		expect(withIt).toContain('href="/accessibility"')
	})

	it('links are in the visitor’s language', async () => {
		const html = await render(
			LegalLinks,
			published,
			{ kinds: ['privacy'] },
			'ar',
		)
		expect(html).toContain('href="/ar/privacy"')
	})

	it('the footer offers Cookie settings only when the banner applies', async () => {
		const withBanner = await render(SiteFooter, published, {
			config: {},
			organization: { name: 'Al Bait' },
			showCookieSettings: true,
		})
		expect(withBanner).toContain('data-open-consent-settings')
		expect(withBanner).toContain('Cookie settings')
		const without = await render(SiteFooter, published, {
			config: {},
			organization: { name: 'Al Bait' },
		})
		expect(without).not.toContain('data-open-consent-settings')
	})

	it('checkout, booking, apply and sign-in render the same links component', async () => {
		// Each screen renders <LegalLinks kinds=...>; assert the wiring in source.
		const { readFileSync } = await import('node:fs')
		const read = (p: string) =>
			readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
		expect(read('pages/menu/checkout.astro')).toMatch(
			/<LegalLinks[\s\S]*?terms[\s\S]*?privacy/,
		)
		expect(read('pages/reserve/index.astro')).toMatch(
			/<LegalLinks[\s\S]*?terms[\s\S]*?privacy/,
		)
		expect(read('components/careers/ApplyPanel.astro')).toMatch(
			/<LegalLinks[\s\S]*?privacy/,
		)
		expect(read('pages/login.astro')).toMatch(
			/<LegalLinks[\s\S]*?terms[\s\S]*?privacy/,
		)
		// And the component renders the terms and privacy pair they ask for.
		const html = await render(LegalLinks, published, {
			kinds: ['terms', 'privacy'],
		})
		expect(html).toContain('data-legal-link="terms"')
		expect(html).toContain('data-legal-link="privacy"')
		expect(html).not.toContain('data-legal-link="cookies"')
	})
})

describe('the cookie banner markup (#89)', () => {
	it('is a labelled, hidden-until-needed region with the three choices, not a modal', async () => {
		const html = await render(ConsentBanner, {
			consent: { mode: 'required' },
			facebookPixelId: '1234567890',
			legalPages: { cookies: '/cookies' },
		})
		expect(html).toContain('data-consent-banner')
		expect(html).toContain('hidden')
		expect(html).toContain('role="region"')
		expect(html).toContain('aria-labelledby="consent-banner-heading"')
		expect(html).toContain('Accept all')
		expect(html).toContain('Reject non-essential')
		expect(html).toContain('Choose')
		expect(html).toContain('href="/cookies"')
		expect(html).not.toContain('aria-modal')
		// Never fixed or sticky: it cannot sit over the cart or checkout button.
		expect(html).not.toMatch(/class="[^"]*\b(fixed|sticky)\b/)
	})

	it('is translated into the site languages', async () => {
		for (const [locale, accept] of [
			['ar', 'قبول الكل'],
			['es', 'Aceptar todo'],
			['fr', 'Tout accepter'],
			['de', 'Alle akzeptieren'],
			['zh', '全部接受'],
		] as const) {
			const html = await render(
				ConsentBanner,
				{ consent: { mode: 'required' }, facebookPixelId: '1234567890' },
				{},
				locale,
			)
			expect(html, locale).toContain(accept)
		}
	})

	it('Notice mode words the banner as an opt-out', async () => {
		const html = await render(ConsentBanner, {
			consent: { mode: 'notice' },
			googleAnalyticsId: 'G-ABC123',
		})
		expect(html).toContain('opt out')
	})
})
