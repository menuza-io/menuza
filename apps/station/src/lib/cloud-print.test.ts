import { describe, expect, it, vi } from 'vitest'
import { reprintToCloud } from './cloud-print.ts'

const settings = {
	deviceToken: 'pdv1.org.device.token',
	tenantApiUrl: 'https://api.example.com',
	demo: false,
}

describe('reprint to a cloud printer (#117)', () => {
	it('sends the order with one request id per press and says whether a printer took it', async () => {
		const bodies: Array<Record<string, string>> = []
		const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)))
			return Response.json({ cloudPrinted: true })
		}) as unknown as typeof fetch
		const order = { orderId: 'a1b2', kind: 'receipt' as const }
		expect(await reprintToCloud(settings, order, fetchImpl)).toBe(true)
		expect(await reprintToCloud(settings, order, fetchImpl)).toBe(true)
		expect(bodies[0]).toMatchObject({ orderId: 'a1b2', kind: 'receipt' })
		expect(bodies[0]!.requestId).not.toBe(bodies[1]!.requestId)
		const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
		expect(url).toBe('https://api.example.com/pos/print/reprint')
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${settings.deviceToken}`,
		)
	})

	it('answers false when no printer takes it, on a failure and in demo, so the tablet prints itself', async () => {
		const input = { orderId: 'a1b2', kind: 'kitchen' as const }
		const none = vi.fn(async () => Response.json({ cloudPrinted: false })) as unknown as typeof fetch
		expect(await reprintToCloud(settings, input, none)).toBe(false)
		const failing = vi.fn(async () => {
			throw new Error('offline')
		}) as unknown as typeof fetch
		expect(await reprintToCloud(settings, input, failing)).toBe(false)
		const refused = vi.fn(async () => new Response('no', { status: 401 })) as unknown as typeof fetch
		expect(await reprintToCloud(settings, input, refused)).toBe(false)
		expect(await reprintToCloud({ ...settings, demo: true }, input, none)).toBe(false)
		expect(none).toHaveBeenCalledTimes(1)
	})
})
