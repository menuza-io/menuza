import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alertPhoneHash } from '@repo/common/operator-alerts'
import { forwardAlertKeyword } from './alert-keyword.ts'

const TOKEN = 'test-internal-token-very-long-12345'
const HASH_SECRET = 'test-order-alert-hash-secret-0123456789abcdef'

describe('forwarding STOP and START to the App (#241)', () => {
	const fetchMock = vi.fn()
	beforeEach(() => {
		fetchMock.mockReset().mockResolvedValue(Response.json({ changed: 1 }))
		vi.stubGlobal('fetch', fetchMock)
		vi.stubEnv('APP_URL', 'https://app.example.test')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', TOKEN)
		vi.stubEnv('ORDER_ALERT_HASH_SECRET', HASH_SECRET)
		vi.stubEnv('DATA_REGION', 'us')
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('sends the keyword and a hash of the sender, never the number', async () => {
		const ok = await forwardAlertKeyword({
			keyword: 'stop',
			from: '(415) 555-0100',
			providerMessageId: 'SM123',
		})
		expect(ok).toBe(true)
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe('https://app.example.test/resources/orders/alert-keyword')
		expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
		const body = JSON.parse(init.body) as Record<string, string>
		expect(body).toEqual({
			keyword: 'stop',
			phoneHash: await alertPhoneHash('+14155550100', HASH_SECRET),
			providerMessageId: 'SM123',
		})
		expect(init.body).not.toContain('4155550100')
	})

	it('does not forward HELP, an unreadable number, or without a token', async () => {
		expect(
			await forwardAlertKeyword({
				keyword: 'help',
				from: '+14155550100',
				providerMessageId: 'a',
			}),
		).toBe(false)
		expect(
			await forwardAlertKeyword({
				keyword: 'stop',
				from: 'not a number',
				providerMessageId: 'a',
			}),
		).toBe(false)
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', '')
		expect(
			await forwardAlertKeyword({
				keyword: 'stop',
				from: '+14155550100',
				providerMessageId: 'a',
			}),
		).toBe(false)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('reports a failure without throwing', async () => {
		fetchMock.mockRejectedValue(new Error('down'))
		expect(
			await forwardAlertKeyword({
				keyword: 'start',
				from: '+14155550100',
				providerMessageId: 'a',
			}),
		).toBe(false)
	})

	it('keys the hash by its own secret, so rotating the command token changes nothing', async () => {
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'a-rotated-internal-token-very-long-6789',
		)
		await forwardAlertKeyword({
			keyword: 'stop',
			from: '+14155550100',
			providerMessageId: 'SM1',
		})
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as {
			phoneHash: string
		}
		expect(body.phoneHash).toBe(
			await alertPhoneHash('+14155550100', HASH_SECRET),
		)
	})

	it('forwards nothing without a usable hash secret: missing, short, or the command token', async () => {
		for (const bad of ['', 'too-short', TOKEN]) {
			vi.stubEnv('ORDER_ALERT_HASH_SECRET', bad)
			expect(
				await forwardAlertKeyword({
					keyword: 'stop',
					from: '+14155550100',
					providerMessageId: 'a',
				}),
			).toBe(false)
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
