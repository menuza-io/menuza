import { describe, expect, it } from 'vitest'
import { redirectsWithUnpublishedFallback } from '#app/utils/sites/public-org.server.ts'
import {
	checkRedirectDestination,
	isValidRedirectDestination,
	siteHostsOf,
} from './redirect-destination.ts'

const siteHosts = ['acme.menuza.io', 'www.acme-eats.com']

describe('isValidRedirectDestination', () => {
	it.each(['/page', '/', '/menu?item=1', 'https://example.com/a'])(
		'accepts %s',
		(value) => {
			expect(isValidRedirectDestination(value)).toBe(true)
		},
	)

	it.each([
		'',
		'javascript:alert(1)',
		'data:text/html,hi',
		'//evil.com',
		'/\\evil.com',
		'page',
		'/\t/evil.com',
		'/\n/evil.com',
		'/\r/evil.com',
	])('rejects %s', (value) => {
		expect(isValidRedirectDestination(value)).toBe(false)
	})
})

describe('checkRedirectDestination (#248)', () => {
	it('refuses a destination with credentials', () => {
		for (const value of [
			'https://user:pass@example.com/x',
			'https://user@example.com',
			'https://:secret@example.com',
		]) {
			expect(checkRedirectDestination(value)).toEqual({
				ok: false,
				code: 'credentials',
			})
		}
	})

	it('refuses plain http except for an internal path', () => {
		expect(checkRedirectDestination('http://example.com/a')).toEqual({
			ok: false,
			code: 'not_https',
		})
		expect(checkRedirectDestination('/menu')).toMatchObject({
			ok: true,
			kind: 'internal',
		})
		expect(checkRedirectDestination('https://example.com/a')).toMatchObject({
			ok: true,
			kind: 'external',
		})
	})

	it('refuses an address on the site’s own domain and offers the path', () => {
		expect(
			checkRedirectDestination('https://acme.menuza.io/menu?x=1#top', {
				siteHosts,
			}),
		).toEqual({ ok: false, code: 'own_domain', suggestedPath: '/menu?x=1#top' })
		// Either name of the custom domain, any case.
		expect(
			checkRedirectDestination('https://ACME-EATS.com', { siteHosts }),
		).toEqual({ ok: false, code: 'own_domain', suggestedPath: '/' })
		expect(
			checkRedirectDestination('https://www.acme-eats.com/book', { siteHosts }),
		).toEqual({ ok: false, code: 'own_domain', suggestedPath: '/book' })
		// Plain http on the own domain is still "use the path".
		expect(
			checkRedirectDestination('http://acme.menuza.io/menu', { siteHosts }),
		).toMatchObject({ ok: false, code: 'own_domain', suggestedPath: '/menu' })
		// Somebody else's site is fine.
		expect(
			checkRedirectDestination('https://example.com/menu', { siteHosts }),
		).toMatchObject({ ok: true })
		// Look-alike hosts are not the site's own.
		expect(
			checkRedirectDestination('https://acme.menuza.io.evil.com/', {
				siteHosts,
			}),
		).toMatchObject({ ok: true })
	})

	it('refuses internal paths that target system paths', () => {
		for (const value of [
			'/api',
			'/api/orders',
			'/login',
			'/login?next=/x',
			'/profile',
			'/profile/settings',
			'/API/x',
			'/resources/images',
		]) {
			expect(checkRedirectDestination(value)).toEqual({
				ok: false,
				code: 'system_path',
			})
		}
		// A page that merely starts with the same letters is fine.
		expect(checkRedirectDestination('/apiary')).toMatchObject({ ok: true })
		expect(checkRedirectDestination('/profiles')).toMatchObject({ ok: true })
		expect(checkRedirectDestination('/login-help')).toMatchObject({ ok: true })
	})

	it('keeps the structural rules', () => {
		expect(checkRedirectDestination('')).toEqual({ ok: false, code: 'empty' })
		expect(checkRedirectDestination('//evil.com')).toEqual({
			ok: false,
			code: 'invalid',
		})
		expect(checkRedirectDestination('ftp://example.com')).toEqual({
			ok: false,
			code: 'invalid',
		})
		expect(checkRedirectDestination('/\\evil.com')).toEqual({
			ok: false,
			code: 'invalid',
		})
	})

	it('builds the own hosts from the platform address and custom domain', () => {
		expect(
			siteHostsOf({
				slug: 'acme',
				customDomain: 'Acme-Eats.com',
				platformHost: 'acme.menuza.io',
			}),
		).toEqual(['acme-eats.com', 'acme.menuza.io'])
		expect(
			siteHostsOf({ slug: 'acme', customDomain: null, platformHost: null }),
		).toEqual([])
	})
})

describe('redirects to an unpublished page (#248)', () => {
	const rows = [
		{ id: '1', fromPath: '/a', toPath: '/brunch', statusCode: 301 },
		{ id: '2', fromPath: '/b', toPath: '/brunch/?x=1', statusCode: 301 },
		{ id: '3', fromPath: '/c', toPath: '/about', statusCode: 301 },
		{
			id: '4',
			fromPath: '/d',
			toPath: 'https://example.com/brunch',
			statusCode: 301,
		},
	]

	it('sends them to the home page with a 302 and leaves the others alone', () => {
		const out = redirectsWithUnpublishedFallback(rows, ['/brunch'])
		expect(out[0]).toMatchObject({ toPath: '/', statusCode: 302 })
		expect(out[1]).toMatchObject({ toPath: '/', statusCode: 302 })
		expect(out[2]).toEqual(rows[2])
		expect(out[3]).toEqual(rows[3])
	})

	it('is the identity once the page is published again', () => {
		expect(redirectsWithUnpublishedFallback(rows, [])).toEqual(rows)
	})
})
