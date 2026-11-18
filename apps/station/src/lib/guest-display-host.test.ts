// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import {
	createGuestHost,
	useGuestCheckout,
	type ChannelLike,
	type HostSnapshot,
} from './guest-display-host.ts'
import { type GuestState } from './guest-display.ts'
import { type CartLine } from './pricing.ts'

const line: CartLine = {
	id: 'l1',
	itemId: 'a',
	name: 'Latte',
	variantId: null,
	variantLabel: null,
	quantity: 1,
	baseCents: 400,
	instructions: '',
	options: [],
}

function setup(over: Partial<HostSnapshot> = {}) {
	const sent: GuestState[] = []
	const channel: ChannelLike = {
		postMessage: (m) => sent.push(m as GuestState),
		onmessage: null,
		close: vi.fn(),
	}
	let snapshot: HostSnapshot = {
		businessName: 'Cafe',
		currency: 'USD',
		locale: 'en',
		rtl: false,
		idleImageUrl: null,
		lines: [line],
		taxRatePercent: 0,
		taxInclusive: false,
		adjustments: [],
		loyaltyOffered: true,
		member: null,
		checkout: useGuestCheckout.getState(),
		...over,
	}
	const loyalty = {
		sendCode: vi.fn(async () => ({ sent: true })),
		verify: vi.fn(async () => ({}) as never),
	}
	const host = createGuestHost({ channel, snapshot: () => snapshot, loyalty })
	const hear = async (data: unknown) => {
		channel.onmessage?.({ data })
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	return {
		sent,
		loyalty,
		host,
		hear,
		set: (patch: Partial<HostSnapshot>) =>
			(snapshot = { ...snapshot, ...patch }),
		last: () => sent[sent.length - 1]!,
	}
}

describe('the till’s side of the guest screen', () => {
	it('answers a screen that has just opened with the order as it is now', async () => {
		const t = setup()
		await t.hear({ type: 'hello' })
		expect(t.last()).toMatchObject({ view: 'order', totalCents: 400 })
	})

	it('numbers its messages so an old one never replaces a new one', async () => {
		const t = setup()
		t.host.publish()
		t.host.publish()
		expect(t.sent.map((s) => s.seq)).toEqual([1, 2])
	})

	it('walks a guest through signing in with their phone', async () => {
		const t = setup()
		await t.hear({ type: 'loyalty-start' })
		expect(t.last().loyalty).toEqual({ stage: 'phone', error: null })
		await t.hear({ type: 'loyalty-phone', phone: '+1 555 123 4567' })
		expect(t.loyalty.sendCode).toHaveBeenCalledWith('+15551234567')
		expect(t.last().loyalty).toEqual({
			stage: 'code',
			maskedPhone: '••••4567',
			error: null,
		})
		await t.hear({ type: 'loyalty-code', code: '123 456' })
		expect(t.loyalty.verify).toHaveBeenCalledWith('+15551234567', '123456')
	})

	it('says so on a phone that cannot be right, a refused code, and a failing region', async () => {
		const t = setup()
		await t.hear({ type: 'loyalty-phone', phone: '12' })
		expect(t.last().loyalty).toEqual({ stage: 'phone', error: 'invalid_phone' })
		t.loyalty.sendCode.mockRejectedValueOnce(new Error('down'))
		await t.hear({ type: 'loyalty-phone', phone: '+15551234567' })
		expect(t.last().loyalty).toEqual({ stage: 'phone', error: 'failed' })
		await t.hear({ type: 'loyalty-phone', phone: '+15551234567' })
		t.loyalty.verify.mockRejectedValueOnce(new Error('nope'))
		await t.hear({ type: 'loyalty-code', code: '000000' })
		expect(t.last().loyalty).toMatchObject({ stage: 'code', error: 'bad_code' })
	})

	it('shows a signed-in member only their own name and points, and offers nothing where loyalty is off', async () => {
		const t = setup({
			member: { firstName: 'Dana', unitLabel: 'points', available: 120 },
		})
		await t.hear({ type: 'hello' })
		expect(t.last().loyalty).toEqual({
			stage: 'member',
			firstName: 'Dana',
			points: 120,
			unitLabel: 'points',
		})
		const off = setup({ loyaltyOffered: false })
		await off.hear({ type: 'hello' })
		expect(off.last().loyalty).toBeNull()
	})

	it('starts the next guest at the invitation when the order is cleared', async () => {
		const t = setup()
		await t.hear({ type: 'loyalty-start' })
		expect(t.last().loyalty?.stage).toBe('phone')
		t.set({ lines: [] })
		await t.hear({ type: 'hello' })
		expect(t.last().view).toBe('idle')
		t.set({ lines: [line] })
		await t.hear({ type: 'hello' })
		expect(t.last().loyalty).toEqual({ stage: 'invite' })
	})

	it('hears nothing after it is stopped, and ignores messages it does not know', async () => {
		const t = setup()
		await t.hear({ type: 'format-the-till' })
		expect(t.sent).toHaveLength(0)
		t.host.dispose()
		t.host.publish()
		expect(t.sent).toHaveLength(0)
	})
})
