import { describe, expect, it } from 'vitest'
import {
	buildGuestState,
	guestChannelName,
	guestDisplayChannel,
	guestDisplayUrl,
	lineDetail,
	readGuestMessage,
	readGuestState,
	type GuestInputs,
} from './guest-display.ts'
import { type CartLine } from './pricing.ts'

const line: CartLine = {
	id: 'l1',
	itemId: 'a',
	name: 'Latte',
	variantId: 'v',
	variantLabel: 'Large',
	quantity: 2,
	baseCents: 400,
	instructions: 'for Dana, she is allergic to nuts',
	options: [
		{
			groupId: 'g',
			groupName: 'Milk',
			optionId: 'o',
			optionName: 'Oat',
			quantity: 1,
			unitCents: 50,
			taxable: true,
		},
	],
}
const totals = {
	subtotalCents: 900,
	adjustmentCents: 0,
	taxCents: 90,
	tipCents: 0,
	totalCents: 990,
}
const input = (over: Partial<GuestInputs> = {}): GuestInputs => ({
	seq: 1,
	checkout: false,
	businessName: 'Cafe',
	currency: 'USD',
	locale: 'en',
	rtl: false,
	lines: [line],
	totals,
	taxInclusive: false,
	tip: { choices: [0, 10, 15, 20], selected: 10 },
	loyalty: { stage: 'invite' },
	idleImageUrl: 'https://cdn.test/idle.png',
	...over,
})

describe('buildGuestState', () => {
	it('is idle, with the picture, when there is no order and no payment', () => {
		const state = buildGuestState(input({ lines: [] }))
		expect(state).toMatchObject({
			view: 'idle',
			lines: [],
			idleImageUrl: 'https://cdn.test/idle.png',
			loyalty: null,
		})
	})

	it('mirrors the order with size and options but never the dish note', () => {
		const state = buildGuestState(input())
		expect(state.view).toBe('order')
		expect(state.lines).toEqual([
			{
				id: 'l1',
				name: 'Latte',
				detail: 'Large, Oat',
				quantity: 2,
				totalCents: 900,
			},
		])
		expect(JSON.stringify(state)).not.toContain('Dana')
		expect(JSON.stringify(state)).not.toContain('allergic')
		// No tip prompt until the guest is about to pay.
		expect(state.tip).toBeNull()
	})

	it('asks for the tip once the bill is being paid', () => {
		const state = buildGuestState(input({ checkout: true }))
		expect(state.view).toBe('checkout')
		expect(state.tip).toEqual({ choices: [0, 10, 15, 20], selected: 10 })
	})

	it('drops an image address that is not plain https', () => {
		for (const bad of [
			'http://x.test/a.png',
			'data:image/png;base64,AAAA',
			null,
		])
			expect(
				buildGuestState(input({ idleImageUrl: bad })).idleImageUrl,
			).toBeNull()
	})

	it('carries nothing that names the staff, the guest or the table', () => {
		const keys = Object.keys(buildGuestState(input({ checkout: true }))).sort()
		expect(keys).toEqual(
			[
				'v',
				'seq',
				'view',
				'businessName',
				'currency',
				'locale',
				'rtl',
				'lines',
				'subtotalCents',
				'discountCents',
				'taxCents',
				'tipCents',
				'totalCents',
				'taxInclusive',
				'tip',
				'loyalty',
				'idleImageUrl',
			].sort(),
		)
	})
})

describe('what crosses the channel', () => {
	it('reads a state it built, and refuses anything else', () => {
		const state = buildGuestState(input({ checkout: true }))
		expect(readGuestState(JSON.parse(JSON.stringify(state)))).toEqual(state)
		for (const bad of [
			null,
			'x',
			{},
			{ ...state, v: 2 },
			{ ...state, view: 'admin' },
			{ ...state, lines: 'nope' },
			{ ...state, totalCents: 'a lot' },
		])
			expect(readGuestState(bad)).toBeNull()
	})

	it('reads only the messages the screen may send', () => {
		expect(readGuestMessage({ type: 'tip', percent: 15 })).toEqual({
			type: 'tip',
			percent: 15,
		})
		for (const bad of [
			{ type: 'tip', percent: 101 },
			{ type: 'tip', percent: -1 },
			{ type: 'tip', percent: 'x' },
			{ type: 'loyalty-phone', phone: 'x'.repeat(40) },
			{ type: 'refund' },
			null,
		])
			expect(readGuestMessage(bad)).toBeNull()
	})

	it('names one channel per restaurant and terminal and reads it back from the address', () => {
		const url = guestDisplayUrl('Joes', 'T1', 'https://pos.example.com')
		const channel = new URL(url).searchParams.get('guest-display')
		expect(channel).toBe(guestChannelName('joes', 'T1'))
		expect(guestDisplayChannel(new URL(url).search)).toBe(channel)
		expect(guestDisplayChannel('')).toBeNull()
		expect(guestDisplayChannel('?guest-display=anything')).toBeNull()
		expect(lineDetail({ ...line, variantLabel: null, options: [] })).toBeNull()
	})
})
