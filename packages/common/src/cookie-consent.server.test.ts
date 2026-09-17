import { describe, expect, it } from 'vitest'

import {
	getCookieConsentState,
	setCookieConsentState,
	verifyCookieConsentRequestOrigin,
} from './cookie-consent.server.ts'

describe('shared cookie consent', () => {
	it('serializes a production preference for the shared parent domain', async () => {
		const cookie = await setCookieConsentState(true, 'https://app.example.com')

		expect(cookie).toContain('cconsent=')
		expect(cookie).toContain('Domain=.example.com')
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('SameSite=Lax')
	})

	it('uses a separate shared cookie name for staging', async () => {
		const cookie = await setCookieConsentState(
			false,
			'https://app-staging.example.com',
		)

		expect(cookie).toContain('cconsent_staging=')
		expect(cookie).toContain('Domain=.example.com')
	})

	it('supports an explicit parent domain for the marketing site', async () => {
		const cookie = await setCookieConsentState(
			true,
			'https://app.example.com',
			'.example.test',
		)

		expect(cookie).toContain('cconsent=')
		expect(cookie).toContain('Domain=.example.test')
	})

	it('reads the same preference on another subdomain', async () => {
		const serialized = await setCookieConsentState(
			true,
			'https://app.example.com',
		)
		const cookieHeader = serialized.split(';', 1)[0]
		const request = new Request('https://example.com', {
			headers: { Cookie: cookieHeader },
		})

		await expect(
			getCookieConsentState(request, 'https://app.example.com'),
		).resolves.toBe(true)
	})

	it('rejects cross-origin cookie consent posts', () => {
		const request = new Request(
			'https://app.example.com/resources/cookie-consent',
			{
				method: 'POST',
				headers: { Origin: 'https://evil.example' },
			},
		)

		expect(verifyCookieConsentRequestOrigin(request)).toBe(false)
	})

	it('accepts same-origin cookie consent posts', () => {
		const request = new Request(
			'https://app.example.com/resources/cookie-consent',
			{
				method: 'POST',
				headers: { Origin: 'https://app.example.com' },
			},
		)

		expect(verifyCookieConsentRequestOrigin(request)).toBe(true)
	})

	it('accepts posts when Referer matches the public origin behind a proxy', () => {
		const request = new Request(
			'https://epic-startup.workers.dev/api/cookie-consent',
			{
				method: 'POST',
				headers: {
					Referer: 'https://www.example.com/pricing',
					Host: 'www.example.com',
					'X-Forwarded-Host': 'www.example.com',
					'X-Forwarded-Proto': 'https',
				},
			},
		)

		expect(verifyCookieConsentRequestOrigin(request)).toBe(true)
	})

	it('accepts same-origin form posts without Origin or Referer', () => {
		const request = new Request('https://www.example.com/api/cookie-consent', {
			method: 'POST',
			headers: { 'Sec-Fetch-Site': 'same-origin' },
		})

		expect(verifyCookieConsentRequestOrigin(request)).toBe(true)
	})
})
