import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { YelpProvider } from '../../src/providers/yelp/provider'
import { TripAdvisorProvider } from '../../src/providers/tripadvisor/provider'
import { DeliverooProvider } from '../../src/providers/deliveroo/provider'
import { JustEatProvider } from '../../src/providers/just-eat/provider'
import { OpenTableProvider } from '../../src/providers/opentable/provider'
import { ResyProvider } from '../../src/providers/resy/provider'
import {
	getAvailableReviewProviders,
	numberToStarRating,
} from '../../src/providers/unified-reviews'

describe('Review Providers Unit Tests', () => {
	beforeEach(() => {
		vi.stubEnv('YELP_CLIENT_ID', 'test-yelp-client')
		vi.stubEnv('YELP_CLIENT_SECRET', 'test-yelp-secret')
		vi.stubEnv('TRIPADVISOR_CLIENT_ID', 'test-ta-client')
		vi.stubEnv('TRIPADVISOR_CLIENT_SECRET', 'test-ta-secret')
		vi.stubEnv('DELIVEROO_CLIENT_ID', 'test-del-client')
		vi.stubEnv('DELIVEROO_CLIENT_SECRET', 'test-del-secret')
		vi.stubEnv('JUST_EAT_CLIENT_ID', 'test-jet-client')
		vi.stubEnv('JUST_EAT_CLIENT_SECRET', 'test-jet-secret')
		vi.stubEnv('OPENTABLE_CLIENT_ID', 'test-ot-client')
		vi.stubEnv('OPENTABLE_CLIENT_SECRET', 'test-ot-secret')
		vi.stubEnv('RESY_CLIENT_ID', 'test-resy-client')
		vi.stubEnv('RESY_CLIENT_SECRET', 'test-resy-secret')
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it('generates valid OAuth auth URLs for all review platforms', async () => {
		const redirectUri = 'https://menuza.test/api/integrations/oauth/callback'

		const yelp = new YelpProvider()
		const yelpUrl = new URL(
			await yelp.getAuthUrl('org-1', redirectUri, { state: 's1' }),
		)
		expect(yelpUrl.origin).toBe('https://www.yelp.com')
		expect(yelpUrl.pathname).toBe('/oauth2/authorize')
		expect(yelpUrl.searchParams.get('client_id')).toBe('test-yelp-client')

		const ta = new TripAdvisorProvider()
		const taUrl = new URL(
			await ta.getAuthUrl('org-1', redirectUri, { state: 's2' }),
		)
		expect(taUrl.origin).toBe('https://www.tripadvisor.com')
		expect(taUrl.searchParams.get('client_id')).toBe('test-ta-client')

		const del = new DeliverooProvider()
		const delUrl = new URL(
			await del.getAuthUrl('org-1', redirectUri, { state: 's3' }),
		)
		expect(delUrl.origin).toBe('https://api.deliveroo.com')
		expect(delUrl.searchParams.get('client_id')).toBe('test-del-client')

		const jet = new JustEatProvider()
		const jetUrl = new URL(
			await jet.getAuthUrl('org-1', redirectUri, { state: 's4' }),
		)
		expect(jetUrl.origin).toBe('https://identity.just-eat.com')
		expect(jetUrl.searchParams.get('client_id')).toBe('test-jet-client')

		const ot = new OpenTableProvider()
		const otUrl = new URL(
			await ot.getAuthUrl('org-1', redirectUri, { state: 's5' }),
		)
		expect(otUrl.origin).toBe('https://auth.opentable.com')
		expect(otUrl.searchParams.get('client_id')).toBe('test-ot-client')

		const resy = new ResyProvider()
		const resyUrl = new URL(
			await resy.getAuthUrl('org-1', redirectUri, { state: 's6' }),
		)
		expect(resyUrl.origin).toBe('https://os.resy.com')
		expect(resyUrl.pathname).toBe('/oauth/authorize')
		expect(resyUrl.searchParams.get('client_id')).toBe('test-resy-client')
		expect(resyUrl.searchParams.get('scope')).toBe('venue.reviews')
		expect(resyUrl.searchParams.get('state')).toBe('s6')
	})

	it('completes the Resy mock OAuth flow with MOCK_ credentials', async () => {
		vi.stubEnv('RESY_CLIENT_ID', 'MOCK_RESY_CLIENT_ID')
		vi.stubEnv('RESY_CLIENT_SECRET', 'MOCK_RESY_CLIENT_SECRET')
		const redirectUri = 'https://menuza.test/api/integrations/oauth/callback'

		const resy = new ResyProvider()
		const parsed = new URL(
			await resy.getAuthUrl('org-1', redirectUri, { state: 'resy-state' }),
		)
		expect(parsed.origin).toBe('https://menuza.test')
		expect(parsed.searchParams.get('code')).toBe('mock-resy-code')
		expect(parsed.searchParams.get('state')).toBe('resy-state')

		const tokens = await resy.handleCallback({
			organizationId: 'org-1',
			code: 'mock-resy-code',
			state: 'resy-state',
			redirectUri,
		})
		expect(tokens.accessToken).toBe('mock-resy-access-token')
		await expect(
			resy.handleCallback({
				organizationId: 'org-1',
				code: 'wrong-code',
				state: 'resy-state',
				redirectUri,
			}),
		).rejects.toThrow('Invalid mock Resy authorization code')

		const refreshed = await resy.refreshToken('mock-resy-refresh-token')
		expect(refreshed.accessToken).toBe('mock-resy-access-token')
	})

	it('rejects mismatched Resy mock credentials', async () => {
		vi.stubEnv('RESY_CLIENT_ID', 'MOCK_RESY_CLIENT_ID')
		vi.stubEnv('RESY_CLIENT_SECRET', 'real-resy-secret')
		const resy = new ResyProvider()
		await expect(
			resy.getAuthUrl('org-1', 'https://menuza.test/callback', {
				state: 's',
			}),
		).rejects.toThrow(/MOCK_ for both RESY_CLIENT_ID and RESY_CLIENT_SECRET/)
	})

	it('returns mock redirect URL when configured with MOCK_ credentials', async () => {
		vi.stubEnv('YELP_CLIENT_ID', 'MOCK_YELP_ID')
		vi.stubEnv('YELP_CLIENT_SECRET', 'MOCK_YELP_SECRET')
		const redirectUri = 'https://menuza.test/api/integrations/oauth/callback'

		const yelp = new YelpProvider()
		const authUrl = await yelp.getAuthUrl('org-1', redirectUri, {
			state: 'mock-state',
		})
		const parsed = new URL(authUrl)
		expect(parsed.origin).toBe('https://menuza.test')
		expect(parsed.searchParams.get('code')).toBe('mock-yelp-code')
		expect(parsed.searchParams.get('state')).toBe('mock-state')

		const tokens = await yelp.handleCallback({
			organizationId: 'org-1',
			code: 'mock-yelp-code',
			state: 'mock-state',
			redirectUri,
		})
		expect(tokens.accessToken).toBe('mock-yelp-access-token')
	})

	it('maps numerical ratings accurately to starRating enum', () => {
		expect(numberToStarRating(1)).toBe('ONE')
		expect(numberToStarRating(2)).toBe('TWO')
		expect(numberToStarRating(3.2)).toBe('THREE')
		expect(numberToStarRating(4)).toBe('FOUR')
		expect(numberToStarRating(4.8)).toBe('FIVE')
		expect(numberToStarRating(undefined)).toBeUndefined()
	})

	it('returns all 7 review providers in getAvailableReviewProviders', () => {
		const providers = getAvailableReviewProviders()
		expect(providers).toHaveLength(7)
		const names = providers.map((p) => p.name)
		expect(names).toEqual([
			'google-business-profile',
			'yelp',
			'tripadvisor',
			'deliveroo',
			'just-eat',
			'opentable',
			'resy',
		])
	})
})
