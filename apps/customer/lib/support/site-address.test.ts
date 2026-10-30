import {
	authOriginHeader,
	isSiteBound,
	makeSiteAddress,
	parseSiteAddress,
	resolveSiteAddress,
	siteQuery,
	UNBOUND_SITE,
} from './site-address'

describe('parseSiteAddress', () => {
	it('turns a bare slug into the brand subdomain', () => {
		const address = parseSiteAddress('acme', 'epic-startup.com')

		expect(address).toEqual({
			slug: 'acme',
			host: null,
			origin: 'https://acme.epic-startup.com',
		})
		expect(address && authOriginHeader(address)).toBe(
			'https://acme.epic-startup.com',
		)
	})

	it('reads brand subdomains and custom domains', () => {
		const branded = parseSiteAddress(
			'ACME.Epic-Startup.com',
			'epic-startup.com',
		)
		expect(branded?.slug).toBe('acme')
		expect(branded?.host).toBeNull()

		const custom = parseSiteAddress(
			'https://www.acme.com/pricing',
			'epic-startup.com',
		)
		expect(custom?.slug).toBeNull()
		expect(custom?.host).toBe('www.acme.com')
		expect(custom?.origin).toBe('https://www.acme.com')
	})

	it('keeps local development origins insecure', () => {
		const address = parseSiteAddress(
			'http://acme.epic-startup.test:3010',
			'epic-startup.test',
		)

		expect(address?.slug).toBe('acme')
		expect(address?.origin).toBe('http://acme.epic-startup.test:3010')
		// tenant-api only accepts the Origin binding for https origins.
		expect(address && authOriginHeader(address)).toBeNull()
	})

	it('treats a nested brand subdomain as a host', () => {
		const address = parseSiteAddress(
			'www.acme.epic-startup.com',
			'epic-startup.com',
		)
		expect(address).toEqual({
			slug: null,
			host: 'www.acme.epic-startup.com',
			origin: 'https://www.acme.epic-startup.com',
		})
	})

	it('drops queries and fragments', () => {
		expect(parseSiteAddress('acme.com?ref=1', 'epic-startup.com')?.host).toBe(
			'acme.com',
		)
		expect(parseSiteAddress('acme.com#menu', 'epic-startup.com')?.host).toBe(
			'acme.com',
		)
	})

	it('rejects empty and malformed addresses', () => {
		expect(parseSiteAddress('   ', 'epic-startup.com')).toBeNull()
		expect(parseSiteAddress('https://', 'epic-startup.com')).toBeNull()
		expect(parseSiteAddress('acme coffee', 'epic-startup.com')).toBeNull()
		expect(parseSiteAddress('user@acme.com', 'epic-startup.com')).toBeNull()
		expect(parseSiteAddress('ftp://acme.com', 'epic-startup.com')).toBeNull()
	})

	it('forces https for a typed address in a build that requires TLS', () => {
		const tls = { requireTls: true }
		expect(
			parseSiteAddress('http://www.acme.com/menu', 'epic-startup.com', tls),
		).toEqual({
			slug: null,
			host: 'www.acme.com',
			origin: 'https://www.acme.com',
		})
		expect(
			parseSiteAddress('http://acme.epic-startup.com', 'epic-startup.com', tls),
		).toEqual({
			slug: 'acme',
			host: null,
			origin: 'https://acme.epic-startup.com',
		})
		// Development builds keep the scheme that was typed.
		expect(
			parseSiteAddress('http://www.acme.com', 'epic-startup.com')?.origin,
		).toBe('http://www.acme.com')
	})
})

describe('resolveSiteAddress', () => {
	it('lets a white-label binding win over a stored address', () => {
		const build = makeSiteAddress({
			slug: 'acme',
			origin: 'https://acme.epic-startup.com',
		})
		const stored = makeSiteAddress({
			slug: 'other',
			origin: 'https://other.epic-startup.com',
		})

		// A branded build must not be re-pointed by an earlier un-branded install.
		expect(resolveSiteAddress(build, stored)).toBe(build)
		// An un-branded build keeps whatever the customer chose.
		expect(resolveSiteAddress(UNBOUND_SITE, stored)).toBe(stored)
		expect(resolveSiteAddress(UNBOUND_SITE, null)).toBe(UNBOUND_SITE)
	})
})

describe('siteQuery', () => {
	it('prefers the host over the slug', () => {
		expect(siteQuery(makeSiteAddress({ slug: 'acme' }))?.name).toBe('slug')
		expect(
			siteQuery(makeSiteAddress({ slug: 'acme', host: 'www.acme.com' }))?.name,
		).toBe('host')
		expect(siteQuery(UNBOUND_SITE)).toBeNull()
		expect(isSiteBound(UNBOUND_SITE)).toBe(false)
		expect(isSiteBound(makeSiteAddress({ host: 'www.acme.com' }))).toBe(true)
	})
})
