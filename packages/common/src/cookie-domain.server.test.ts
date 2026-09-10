import { afterEach, describe, expect, it } from 'vitest'

import { getBrandDomain } from '@repo/config/brand'

import {
	getOperatorAdminUrl,
	getOperatorAppUrl,
	isAdminOperatorHost,
	isAppOperatorHost,
	isStagingOperatorHost,
	operatorCookieName,
	operatorThemeCookieName,
	shouldApplyImpersonationToUserId,
	operatorSessionCookieDomain,
	sharedCookieDomain,
	sharedCookieDomainFromHost,
} from './cookie-domain.server.ts'

describe('sharedCookieDomainFromHost', () => {
	it('strips the app/admin label from a two-label apex', () => {
		expect(sharedCookieDomainFromHost('app.epic-startup.dev')).toBe(
			'.epic-startup.dev',
		)
		expect(sharedCookieDomainFromHost('app.preview.example.dev:2999')).toBe(
			'.preview.example.dev',
		)
		expect(sharedCookieDomainFromHost(`admin.${getBrandDomain()}`)).toBe(
			`.${getBrandDomain()}`,
		)
	})

	it('shares cookies across flat staging operator hosts on the production apex', () => {
		expect(sharedCookieDomainFromHost('app-staging.lighteninggroup.com')).toBe(
			'.lighteninggroup.com',
		)
		expect(
			sharedCookieDomainFromHost('admin-staging.lighteninggroup.com'),
		).toBe('.lighteninggroup.com')
	})

	it('omits domain on localhost and opaque Workers hosts', () => {
		expect(sharedCookieDomainFromHost('localhost:3001')).toBeUndefined()
		expect(sharedCookieDomainFromHost('127.0.0.1')).toBeUndefined()
		expect(
			sharedCookieDomainFromHost('example-app.example.workers.dev'),
		).toBeUndefined()
	})

	it('shares cookies across *.localhost subdomains', () => {
		expect(sharedCookieDomainFromHost('app.localhost:3001')).toBe('.localhost')
	})
})

describe('operatorCookieName', () => {
	it('suffixes cookie names for flat staging operator origins', () => {
		expect(
			operatorCookieName('en_session', 'https://app-staging.example.com'),
		).toBe('en_session_staging')
		expect(
			operatorCookieName('en_theme', 'https://admin-staging.example.com'),
		).toBe('en_theme_staging')
		expect(operatorCookieName('en_session', 'https://app.example.com')).toBe(
			'en_session',
		)
	})

	it('derives the theme cookie name from the operator app URL', () => {
		expect(operatorThemeCookieName('https://app-staging.example.com')).toBe(
			'en_theme_staging',
		)
		expect(operatorThemeCookieName('https://app.example.com')).toBe('en_theme')
	})
})

describe('isStagingOperatorHost', () => {
	it('detects flat staging operator hosts', () => {
		expect(isStagingOperatorHost('app-staging.example.com')).toBe(true)
		expect(isStagingOperatorHost('admin-staging.example.com')).toBe(true)
		expect(isStagingOperatorHost('app.example.com')).toBe(false)
	})
})

describe('operator cross-origin URLs', () => {
	it('builds app and admin URLs from ROOT_APP and the current origin', () => {
		expect(
			getOperatorAppUrl(
				'https://admin.epic-startup.test:2999',
				'epic-startup.test',
			),
		).toBe('https://app.epic-startup.test:2999')
		expect(
			getOperatorAdminUrl(
				'https://app.epic-startup.test:2999',
				'epic-startup.test',
			),
		).toBe('https://admin.epic-startup.test:2999')
	})

	it('uses staging host labels when the reference origin is staging', () => {
		expect(
			getOperatorAppUrl('https://admin-staging.example.com', 'example.com'),
		).toBe('https://app-staging.example.com')
		expect(
			getOperatorAdminUrl('https://app-staging.example.com', 'example.com'),
		).toBe('https://admin-staging.example.com')
	})
})

describe('shouldApplyImpersonationToUserId', () => {
	it('applies on app hosts but not admin hosts', () => {
		expect(
			shouldApplyImpersonationToUserId(
				new Request('https://app.epic-startup.test:2999/'),
			),
		).toBe(true)
		expect(
			shouldApplyImpersonationToUserId(
				new Request('https://admin.epic-startup.test:2999/users'),
			),
		).toBe(false)
		expect(
			shouldApplyImpersonationToUserId(new Request('http://localhost:3001/')),
		).toBe(true)
	})
})

describe('operator host labels', () => {
	it('detects app and admin operator hosts', () => {
		expect(isAppOperatorHost('app.epic-startup.test:2999')).toBe(true)
		expect(isAppOperatorHost('admin.epic-startup.test')).toBe(false)
		expect(isAdminOperatorHost('admin.epic-startup.test')).toBe(true)
		expect(isAdminOperatorHost('app.epic-startup.test')).toBe(false)
	})
})

describe('sharedCookieDomain', () => {
	const previousBaseUrl = process.env.BASE_URL

	afterEach(() => {
		if (previousBaseUrl === undefined) delete process.env.BASE_URL
		else process.env.BASE_URL = previousBaseUrl
	})

	it('reads the apex from BASE_URL', () => {
		expect(sharedCookieDomain('https://app.epic-startup.dev')).toBe(
			'.epic-startup.dev',
		)
		expect(sharedCookieDomain('https://app-staging.lighteninggroup.com')).toBe(
			'.lighteninggroup.com',
		)
		expect(sharedCookieDomain('http://localhost:3001')).toBeUndefined()
	})

	it('prefers the runtime BASE_URL when no origin is passed', () => {
		process.env.BASE_URL = 'https://app.lighteninggroup.com'
		expect(sharedCookieDomain()).toBe('.lighteninggroup.com')
	})
})

describe('operatorSessionCookieDomain', () => {
	const previousMocks = process.env.MOCKS

	afterEach(() => {
		if (previousMocks === undefined) delete process.env.MOCKS
		else process.env.MOCKS = previousMocks
	})

	it('keeps production apex domains when MOCKS is unset', () => {
		delete process.env.MOCKS
		expect(operatorSessionCookieDomain('https://app.epic-startup.dev')).toBe(
			'.epic-startup.dev',
		)
	})

	it('uses host-only cookies for localhost BASE_URL in mocks mode', () => {
		process.env.MOCKS = 'true'
		expect(operatorSessionCookieDomain('http://localhost:3001')).toBeUndefined()
	})

	it('uses host-only cookies when MOCKS is on but BASE_URL is a dev hostname', () => {
		process.env.MOCKS = 'true'
		expect(
			operatorSessionCookieDomain('https://app.epic-startup.test:2999'),
		).toBeUndefined()
	})

	it('keeps .localhost sharing when BASE_URL is app.localhost', () => {
		process.env.MOCKS = 'true'
		expect(operatorSessionCookieDomain('http://app.localhost:3001')).toBe(
			'.localhost',
		)
	})
})
