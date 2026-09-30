import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleBusinessProfileProvider } from '../../src/providers/google-business-profile/provider'
import { googleBusinessSchedule } from '../../src/providers/google-business-profile/service'

describe('Google Business Profile OAuth', () => {
	beforeEach(() => {
		vi.stubEnv('GBP_CLIENT_ID', 'client-id')
		vi.stubEnv('GBP_CLIENT_SECRET', 'client-secret')
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it('requests offline business access and preserves the signed flow state', async () => {
		const provider = new GoogleBusinessProfileProvider()
		const url = new URL(
			await provider.getAuthUrl(
				'org',
				'https://menuza.test/api/integrations/oauth/callback',
				{ state: 'signed-state' },
			),
		)
		expect(url.origin).toBe('https://accounts.google.com')
		expect(url.searchParams.get('scope')).toBe(
			'https://www.googleapis.com/auth/business.manage',
		)
		expect(url.searchParams.get('access_type')).toBe('offline')
		expect(url.searchParams.get('state')).toBe('signed-state')
	})

	it('exchanges the authorization code with the exact callback URI', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'access',
				refresh_token: 'refresh',
				expires_in: 3600,
			}),
		})
		vi.stubGlobal('fetch', fetchMock)
		const provider = new GoogleBusinessProfileProvider()
		const result = await provider.handleCallback({
			organizationId: 'org',
			code: 'code',
			state: 'state',
			redirectUri: 'https://menuza.test/api/integrations/oauth/callback',
		})
		expect(result.refreshToken).toBe('refresh')
		const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
		expect(body.get('redirect_uri')).toBe(
			'https://menuza.test/api/integrations/oauth/callback',
		)
	})
})

it('keeps Google closing hours that cross midnight', () => {
	const schedule = googleBusinessSchedule({
		name: 'locations/123',
		title: 'Restaurant',
		regularHours: {
			periods: [
				{
					openDay: 'MONDAY',
					closeDay: 'TUESDAY',
					openTime: { hours: 18, minutes: 0 },
					closeTime: { hours: 2, minutes: 30 },
				},
			],
		},
	})
	expect(schedule?.find((day) => day.day === 'monday')?.slots).toEqual([
		{ start: '18:00', end: '23:59' },
	])
	expect(schedule?.find((day) => day.day === 'tuesday')?.slots).toEqual([
		{ start: '00:00', end: '02:30' },
	])
})
