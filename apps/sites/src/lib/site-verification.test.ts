import { describe, expect, it } from 'vitest'
import { indexNowKeyFile } from './indexnow'
import { isSitesAppRoute, isSitesLandingRoute } from './site-headers'
import { verificationMetaTags } from './site-verification'

describe('verification meta tags (#138)', () => {
	it('renders the Google and Bing codes as meta tags', () => {
		expect(
			verificationMetaTags({
				google: ['abcDEF123_-xyz', 'mock-gsc-1a2b3c'],
				bing: '0123456789ABCDEF0123456789abcdef',
			}),
		).toEqual([
			{ name: 'google-site-verification', content: 'abcDEF123_-xyz' },
			{ name: 'google-site-verification', content: 'mock-gsc-1a2b3c' },
			{ name: 'msvalidate.01', content: '0123456789ABCDEF0123456789abcdef' },
		])
	})

	it('drops anything that is not a code', () => {
		expect(
			verificationMetaTags({ google: ['"><script>'], bing: 'nope' }),
		).toEqual([])
		expect(verificationMetaTags(null)).toEqual([])
	})
})

describe('IndexNow key file (#138)', () => {
	it('answers only the site key', () => {
		const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
		expect(indexNowKeyFile(key, key)).toBe(key)
		expect(indexNowKeyFile(key, 'other1234')).toBeNull()
		expect(indexNowKeyFile(null, key)).toBeNull()
	})
})

describe('generated page routes', () => {
	it('are app routes, not CMS lookups', () => {
		for (const path of [
			'/locations',
			'/locations/olaya',
			'/delivery/al-malqa',
			'/events',
			'/events/trivia',
		]) {
			expect(isSitesLandingRoute(path)).toBe(true)
			expect(isSitesAppRoute(path)).toBe(true)
		}
		expect(isSitesLandingRoute('/eventsx')).toBe(false)
	})
})
