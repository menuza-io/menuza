import { getBrandDomain, getLocalDomain } from '@repo/config/brand'
import { describe, expect, it } from 'vitest'
import { resolveSitesOrigin } from './sites-origin.server.ts'

describe('resolveSitesOrigin', () => {
	it('uses the custom domain when the organization has one', () => {
		expect(
			resolveSitesOrigin({
				slug: 'acme',
				customDomain: 'book.acme.example',
				baseUrl: 'https://app.menuza.test:2999',
			}),
		).toBe('https://book.acme.example')
	})

	it('points a localhost App at the local Sites dev host, never the App origin', () => {
		const origin = resolveSitesOrigin({
			slug: 'Acme',
			customDomain: null,
			baseUrl: 'http://localhost:3001',
		})
		expect(origin).toBe(`http://acme.${getLocalDomain()}:3008`)
		expect(origin).not.toContain('3001')
	})

	it('swaps the app subdomain for the org slug behind the dev proxy and in production', () => {
		expect(
			resolveSitesOrigin({
				slug: 'acme',
				customDomain: null,
				baseUrl: 'https://app.menuza.test:2999',
			}),
		).toBe('https://acme.menuza.test:2999')
		expect(
			resolveSitesOrigin({
				slug: 'acme',
				customDomain: null,
				baseUrl: 'https://app.example.com',
			}),
		).toBe('https://acme.example.com')
	})

	it('falls back to the brand apex when the App host has no app. prefix', () => {
		expect(
			resolveSitesOrigin({
				slug: 'acme',
				customDomain: null,
				baseUrl: 'https://console.example.com',
			}),
		).toBe(`https://acme.${getBrandDomain()}`)
	})

	it('honors PUBLIC_SITE_HOST_SUFFIXES first', () => {
		expect(
			resolveSitesOrigin({
				slug: 'acme',
				customDomain: null,
				baseUrl: 'https://app.example.com',
				hostSuffixes: 'preview.example.dev, other.dev',
			}),
		).toBe('https://acme.preview.example.dev')
		expect(
			resolveSitesOrigin({
				slug: 'acme',
				customDomain: null,
				baseUrl: 'https://app.example.com',
				hostSuffixes: 'localhost:3008',
			}),
		).toBe('http://acme.localhost:3008')
	})
})
