import { describe, expect, it, vi } from 'vitest'
import { createGiftCardApi, GiftCardApiError } from './gift-cards.ts'

const settings = () =>
	({ tenantApiUrl: 'https://region.example', deviceToken: 'pdv1.org.dev.secret' }) as never

function api(fetchImpl: typeof fetch, session: unknown = null) {
	return createGiftCardApi({ settings, session: () => session as never }, fetchImpl)
}

describe('the till gift card client', () => {
	it('sends the device secret, the staff session and an idempotency key to the regional route', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({
				cardId: 'c1', last4: 'ABCD', redeemedMinor: 500, balanceMinor: 1500, currency: 'USD', reference: 'ref_1',
			}),
		)
		const redeemed = await api(fetchImpl as never, { serverSession: { token: 'staff-session-token' } }).redeem({
			code: 'ABCD-EFGH-JKMN-PQRS', amountMinor: 500, saleId: 'sale-12345678', clientRequestId: 'req-12345678',
		})
		expect(redeemed.reference).toBe('ref_1')
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://region.example/pos/gift-cards/redeem')
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer pdv1.org.dev.secret')
		expect(headers['Idempotency-Key']).toBe('redeem-req-12345678')
		expect(Object.values(headers)).toContain('staff-session-token')
		expect(init.credentials).toBe('omit')
	})

	it('refuses offline instead of queueing: a network failure is an offline error', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError('network')
		})
		const error = await api(fetchImpl as never).lookup('ABCD-EFGH-JKMN-PQRS').catch((e) => e)
		expect(error).toBeInstanceOf(GiftCardApiError)
		expect((error as GiftCardApiError).offline).toBe(true)
	})

	it('carries the balance of a refusal that is too low', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({ error: 'gift_card_balance_low', code: 'gift_card_balance_low', balanceMinor: 300 }, { status: 409 }),
		)
		const error = (await api(fetchImpl as never)
			.redeem({ code: 'ABCD-EFGH-JKMN-PQRS', amountMinor: 500, saleId: 'sale-12345678', clientRequestId: 'req-12345678' })
			.catch((e) => e)) as GiftCardApiError
		expect(error.code).toBe('gift_card_balance_low')
		expect(error.balanceMinor).toBe(300)
	})

	it('treats an answer that is not the region’s as malformed, never as money moved', async () => {
		const fetchImpl = vi.fn(async () => Response.json({ hello: 'portal' }))
		const error = (await api(fetchImpl as never)
			.sell({ amountMinor: 1000, paymentMethod: 'cash', clientRequestId: 'req-12345678' })
			.catch((e) => e)) as GiftCardApiError
		expect(error.code).toBe('malformed_response')
	})

	it('never queues: there is no offline path in the client', () => {
		const source = createGiftCardApi.toString()
		expect(source).not.toMatch(/outbox|indexedDB|dexie/i)
	})
})
