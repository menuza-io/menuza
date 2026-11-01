import { describe, expect, it, vi } from 'vitest'
import { createDiscountUsageClient } from './usage-client.ts'

const TOKEN = {
	jwt: 'jwt-1',
	tenantApiUrl: 'https://us.example.test/',
	expiresAt: 10_000_000,
}
const ENTRY = {
	discountId: 'd1',
	uses: 3,
	reserved: 1,
	consumed: 2,
	refunded: 0,
	discountMinor: 450,
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status })
}

describe('discount usage client', () => {
	it('mints a token once and reads counts with a bearer token', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json(TOKEN))
			.mockResolvedValue(json({ usage: [ENTRY] }))
		const client = createDiscountUsageClient({
			orgSlug: 'acme',
			fetchImpl,
			now: () => 0,
		})
		expect(await client.fetchUsage(['d1', 'd1'])).toEqual({ d1: ENTRY })
		await client.fetchUsage(['d1'])
		expect(fetchImpl).toHaveBeenCalledTimes(3)
		expect(fetchImpl.mock.calls[0]![0]).toBe('/acme/discounts-token')
		const [url, init] = fetchImpl.mock.calls[1]!
		expect(url).toBe('https://us.example.test/operator/discounts/usage?ids=d1')
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			'Bearer jwt-1',
		)
	})

	it('resolves to null when the token or the region fails', async () => {
		const noToken = createDiscountUsageClient({
			orgSlug: 'acme',
			fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(json({}, 403)),
		})
		expect(await noToken.fetchUsage(['d1'])).toBeNull()

		const regionDown = createDiscountUsageClient({
			orgSlug: 'acme',
			now: () => 0,
			fetchImpl: vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(json(TOKEN))
				.mockRejectedValueOnce(new TypeError('network')),
		})
		expect(await regionDown.fetchUsage(['d1'])).toBeNull()
	})

	it('resolves to null for an answer that is not usage counts', async () => {
		const client = createDiscountUsageClient({
			orgSlug: 'acme',
			now: () => 0,
			fetchImpl: vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(json(TOKEN))
				.mockResolvedValueOnce(json({ usage: [{ discountId: 'd1' }] })),
		})
		expect(await client.fetchUsage(['d1'])).toBeNull()
	})

	it('does not call anything for no ids', async () => {
		const fetchImpl = vi.fn<typeof fetch>()
		const client = createDiscountUsageClient({ orgSlug: 'acme', fetchImpl })
		expect(await client.fetchUsage([])).toEqual({})
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})
