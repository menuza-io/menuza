import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getUptimeStatus } from './betterstack-client.js'

describe('getUptimeStatus', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('should return degraded status when API key is missing', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		const status = await getUptimeStatus('', undefined)

		expect(fetchMock).not.toHaveBeenCalled()
		expect(status.status).toBe('degraded')
		expect(status.message).toBe('Unable to fetch status')
		expect(status.upMonitors).toBe(0)
		expect(status.totalMonitors).toBe(0)
	})

	it('should handle API error gracefully', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: false,
				statusText: 'Unauthorized',
			}),
		)

		const status = await getUptimeStatus('test-key', undefined)

		expect(status.status).toBe('degraded')
		expect(status.message).toBe('Unable to fetch status')
	})

	it('should parse monitors response correctly', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: [
						{
							id: '1',
							type: 'monitor',
							attributes: {
								url: 'https://example.com',
								pronounceable_name: 'App',
								status: 'up',
							},
						},
					],
				}),
			}),
		)

		const status = await getUptimeStatus('valid-key', undefined)

		expect(status.status).toBe('operational')
		expect(status.message).toBe('All systems normal')
		expect(status.upMonitors).toBe(1)
		expect(status.totalMonitors).toBe(1)
	})
})
