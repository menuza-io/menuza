import { describe, expect, it, vi } from 'vitest'
import {
	checkoutOrderPayload,
	checkoutOrderRequest,
} from './checkout-payload.ts'
import { checkoutAttemptKey } from './order-client.ts'

const contact = { name: 'Ada', phone: '+15550100', email: 'a@x.test' }

describe('checkoutOrderPayload', () => {
	it('places exactly the order the reward was priced against', () => {
		const priced = {
			locale: 'en',
			fulfillment: 'pickup',
			tipPercent: 10,
			lines: [{ itemId: 'i1', quantity: 2 }],
		}
		const reward = { rewardId: 'rwd_coffee', lineId: 'l1' }
		expect(checkoutOrderPayload(priced, { contact, reward })).toEqual({
			...priced,
			contact,
			loyalty: reward,
		})
	})

	it('adds delivery notes to the priced address without touching the quote', () => {
		const priced = {
			fulfillment: 'delivery',
			delivery: { address: '1 Main Street', quoteToken: 'q1' },
		}
		const payload = checkoutOrderPayload(priced, {
			contact,
			deliveryNotes: '  Ring twice ',
			reward: null,
		})
		expect(payload.delivery).toEqual({
			address: '1 Main Street',
			quoteToken: 'q1',
			notes: 'Ring twice',
		})
		expect(priced.delivery).toEqual({
			address: '1 Main Street',
			quoteToken: 'q1',
		})
		expect(payload).not.toHaveProperty('loyalty')
	})

	it('sends no notes for a pickup', () => {
		const payload = checkoutOrderPayload(
			{ fulfillment: 'pickup' },
			{ contact, deliveryNotes: 'Ring twice', reward: null },
		)
		expect(payload).not.toHaveProperty('delivery')
	})

	it('keeps marketing consent out of the core payload the attempt key hashes', () => {
		const priced = { fulfillment: 'pickup', lines: [] }
		const core = checkoutOrderPayload(priced, { contact, reward: null })
		expect(core).not.toHaveProperty('marketingConsent')
	})
})

describe('checkoutOrderRequest', () => {
	const core = { fulfillment: 'pickup', contact }
	const key = '11111111-1111-4111-8111-111111111111'

	it('adds the attempt key and the ticked boxes to the body', () => {
		const consent = { sms: true, textVersion: 'guest-boxes-us-2026-11' }
		expect(checkoutOrderRequest(core, key, consent)).toEqual({
			...core,
			marketingConsent: consent,
			idempotencyKey: key,
		})
	})

	it('omits the field when nothing is ticked, and never changes the core', () => {
		expect(checkoutOrderRequest(core, key, undefined)).toEqual({
			...core,
			idempotencyKey: key,
		})
		expect(core).toEqual({ fulfillment: 'pickup', contact })
	})

	it('derives the same attempt key whatever boxes change between retries', async () => {
		const store = new Map<string, string>()
		vi.stubGlobal('sessionStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		})
		try {
			const first = await checkoutAttemptKey('org_1', core)
			const retry = await checkoutAttemptKey('org_1', core)
			expect(retry).toBe(first)
			const a = checkoutOrderRequest(core, first, {
				email: true,
				textVersion: 'v',
			})
			const b = checkoutOrderRequest(core, retry, {
				sms: true,
				textVersion: 'v',
			})
			expect(a.idempotencyKey).toBe(b.idempotencyKey)
			expect(a.marketingConsent).not.toEqual(b.marketingConsent)
		} finally {
			vi.unstubAllGlobals()
		}
	})
})

describe('checkoutOrderPayload smsUpdates', () => {
	const pickup = { fulfillment: 'pickup', lines: [] }
	const build = (
		priced: Record<string, unknown>,
		smsUpdates?: { offered: boolean; ticked: boolean },
		phone = contact.phone,
	) =>
		checkoutOrderPayload(priced, {
			contact: { ...contact, phone },
			reward: null,
			smsUpdates,
		})

	it('sends true only when offered, ticked and a phone is entered', () => {
		expect(build(pickup, { offered: true, ticked: true }).smsUpdates).toBe(true)
	})

	it('omits the key when the box is unticked', () => {
		expect(
			'smsUpdates' in build(pickup, { offered: true, ticked: false }),
		).toBe(false)
	})

	it('omits the key when the box is hidden, even if it was ticked', () => {
		expect(
			'smsUpdates' in build(pickup, { offered: false, ticked: true }),
		).toBe(false)
	})

	it('omits the key when no choice is passed', () => {
		expect('smsUpdates' in build(pickup)).toBe(false)
	})

	it('omits the key without a phone', () => {
		expect(
			'smsUpdates' in build(pickup, { offered: true, ticked: true }, '  '),
		).toBe(false)
	})

	it('never sends it for a dine-in table round', () => {
		expect(
			'smsUpdates' in
				build(
					{ fulfillment: 'dine_in', lines: [] },
					{ offered: true, ticked: true },
				),
		).toBe(false)
	})

	it('still sends it for delivery', () => {
		expect(
			build({ fulfillment: 'delivery' }, { offered: true, ticked: true })
				.smsUpdates,
		).toBe(true)
	})

	it('never touches marketingConsent', () => {
		const core = build(pickup, { offered: true, ticked: true })
		expect('marketingConsent' in core).toBe(false)
		const consent = { email: true }
		const request = checkoutOrderRequest(core, 'key', consent)
		expect(request.marketingConsent).toBe(consent)
		expect(request.smsUpdates).toBe(true)
		expect(
			checkoutOrderRequest(build(pickup), 'key', consent).marketingConsent,
		).toBe(consent)
	})

	it('keeps the attempt key tied to the ticked box', async () => {
		const store = new Map<string, string>()
		vi.stubGlobal('sessionStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		})
		const off = await checkoutAttemptKey('org', build(pickup))
		const on = await checkoutAttemptKey(
			'org',
			build(pickup, { offered: true, ticked: true }),
		)
		expect(on).not.toBe(off)
		vi.unstubAllGlobals()
	})
})
