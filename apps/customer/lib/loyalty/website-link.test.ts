import { websiteOrderUrl } from './website-link'

const organization = { slug: 'acme', customDomain: null as string | null }
const brandDomain = 'menuza.com'

function link(
	overrides: {
		customDomain?: string | null
		origin?: string | null
		slug?: string
		brandDomain?: string
	} = {},
) {
	return websiteOrderUrl({
		organization: {
			slug: overrides.slug ?? organization.slug,
			customDomain:
				overrides.customDomain === undefined ? null : overrides.customDomain,
		},
		siteAddress: {
			slug: organization.slug,
			host: null,
			origin: overrides.origin === undefined ? null : overrides.origin,
		},
		brandDomain: overrides.brandDomain ?? brandDomain,
	})
}

describe('websiteOrderUrl', () => {
	it('prefers the custom domain', () => {
		expect(
			link({
				customDomain: 'order.acme.com',
				origin: 'https://acme.menuza.com',
			}),
		).toBe('https://order.acme.com/menu')
	})

	it('normalizes the custom domain casing and trailing dot', () => {
		expect(link({ customDomain: ' Order.Acme.com. ' })).toBe(
			'https://order.acme.com/menu',
		)
	})

	it('uses the site origin when it is transport-safe', () => {
		expect(link({ origin: 'https://acme.menuza.com' })).toBe(
			'https://acme.menuza.com/menu',
		)
		expect(link({ origin: 'http://localhost:3008' })).toBe(
			'http://localhost:3008/menu',
		)
	})

	it('refuses origins that are not transport-safe and falls back to the brand domain', () => {
		expect(link({ origin: 'http://acme.menuza.com' })).toBe(
			'https://acme.menuza.com/menu',
		)
		expect(link({ origin: 'not a url' })).toBe('https://acme.menuza.com/menu')
		expect(link({ origin: 'https://user:pass@acme.menuza.com' })).toBe(
			'https://acme.menuza.com/menu',
		)
	})

	it('builds the slug on the brand domain as the last resort', () => {
		expect(link()).toBe('https://acme.menuza.com/menu')
	})

	it('refuses a custom domain that is not a hostname', () => {
		expect(link({ customDomain: 'https://evil.example/x' })).toBe(
			'https://acme.menuza.com/menu',
		)
	})

	it('returns null when nothing usable remains', () => {
		expect(link({ slug: 'not a slug!' })).toBeNull()
		expect(link({ brandDomain: '' })).toBeNull()
	})

	it('never carries a query or fragment', () => {
		for (const url of [
			link({ customDomain: 'order.acme.com' }),
			link({ origin: 'https://acme.menuza.com' }),
			link(),
		]) {
			expect(url).toBeTruthy()
			expect(url).not.toMatch(/[?#]/)
			expect(url).not.toMatch(/token|phone|id=/i)
		}
	})
})
