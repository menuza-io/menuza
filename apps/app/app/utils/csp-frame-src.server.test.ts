import { getBrandDomain } from '@repo/config/brand'
import { describe, expect, it } from 'vitest'

import {
	parentDomainFromHost,
	sitePreviewFrameSrc,
	sitePreviewHostSuffixes,
	tenantApiConnectSrc,
} from './csp-frame-src.server.ts'

describe('site preview frame-src', () => {
	it('derives the parent domain from the App host', () => {
		expect(parentDomainFromHost('app.preview.example.dev')).toBe(
			'preview.example.dev',
		)
		expect(parentDomainFromHost(`app.${getBrandDomain()}:2999`)).toBe(
			getBrandDomain(),
		)
		expect(parentDomainFromHost('localhost:3001')).toBeNull()
	})

	it('allows tenant Sites on the live brand domain from the request host', () => {
		expect(sitePreviewFrameSrc({}, 'app.preview.example.dev')).toEqual(
			expect.arrayContaining([
				"'self'",
				'*.preview.example.dev',
				'*.preview.example.dev:*',
				`*.${getBrandDomain()}`,
			]),
		)
	})

	it('includes PUBLIC_SITE_HOST_SUFFIXES from env', () => {
		expect(
			sitePreviewHostSuffixes({
				PUBLIC_SITE_HOST_SUFFIXES: 'preview.example.dev',
			}),
		).toEqual(expect.arrayContaining([getBrandDomain(), 'preview.example.dev']))
	})
})

describe('tenant API connect-src', () => {
	it('allows browser-facing US and KSA tenant-api origins', () => {
		expect(
			tenantApiConnectSrc({
				TENANT_API_URL: 'https://api.menuza.io:2999',
				TENANT_API_URL_KSA: 'https://api-ksa.menuza.io:2999',
			}),
		).toEqual(['https://api.menuza.io:2999', 'https://api-ksa.menuza.io:2999'])
	})

	it('dedupes public and internal URLs that share an origin', () => {
		expect(
			tenantApiConnectSrc({
				TENANT_API_URL: 'https://api.example.com',
			}),
		).toEqual(['https://api.example.com'])
	})
})
