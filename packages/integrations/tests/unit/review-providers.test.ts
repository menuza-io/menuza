import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { YelpProvider } from '../../src/providers/yelp/provider'
import { TripAdvisorProvider } from '../../src/providers/tripadvisor/provider'
import { DeliverooProvider } from '../../src/providers/deliveroo/provider'
import { JustEatProvider } from '../../src/providers/just-eat/provider'
import { OpenTableProvider } from '../../src/providers/opentable/provider'
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

	it('returns all 6 review providers in getAvailableReviewProviders', () => {
		const providers = getAvailableReviewProviders()
		expect(providers).toHaveLength(6)
		const names = providers.map((p) => p.name)
		expect(names).toEqual([
			'google-business-profile',
			'yelp',
			'tripadvisor',
			'deliveroo',
			'just-eat',
			'opentable',
		])
	})
})
