import { type KdsTicket } from '@repo/common/kds'
import { describe, expect, it } from 'vitest'
import { dishStatus, dishStatuses } from './kitchen-status.ts'
import { type CartLine } from './pricing.ts'

const ticket = (over: Partial<KdsTicket> = {}): KdsTicket => ({
	id: 'order-1',
	source: 'pos',
	number: 'T1-0001',
	channel: 'counter',
	fulfillment: 'dine_in',
	tableLabel: '12',
	createdAt: 0,
	dueAt: null,
	version: 'v1',
	completedAt: null,
	cancelled: false,
	lines: (['new', 'preparing', 'ready'] as const).map((stage, index) => ({
		id: `line-${index}`,
		itemId: `item-${index}`,
		name: `Dish ${index}`,
		quantity: 1,
		variant: null,
		variantId: null,
		options: [],
		instructions: '',
		stationId: 'kitchen',
		stage,
	})),
	...over,
})

describe('a dish on the register, as the kitchen sees it', () => {
	it('follows its line on the ticket by position', () => {
		expect([0, 1, 2].map((index) => dishStatus(ticket(), index))).toEqual([
			'queued',
			'preparing',
			'ready',
		])
	})

	it('is served once the ticket is cleared from the pass', () => {
		expect(dishStatus(ticket({ completedAt: 5 }), 0)).toBe('served')
	})

	it('says nothing without a ticket, for a cancelled one, or past its lines', () => {
		expect(dishStatus(undefined, 0)).toBeNull()
		expect(dishStatus(ticket({ cancelled: true }), 0)).toBeNull()
		expect(dishStatus(ticket(), 7)).toBeNull()
	})
})

describe('the lines of a tab, matched to the kitchen ticket', () => {
	const line = (id: string, itemId: string, sentAt?: number): CartLine => ({
		id,
		itemId,
		name: id,
		variantId: null,
		variantLabel: null,
		quantity: 1,
		baseCents: 100,
		instructions: '',
		options: [],
		sentAt,
	})
	it('matches by what a dish is, not where it sits, and skips lines not sent', () => {
		const statuses = dishStatuses(
			[line('b', 'item-2', 1), line('a', 'item-0', 1), line('new', 'item-1')],
			ticket(),
		)
		expect(Object.fromEntries(statuses)).toEqual({ a: 'queued', b: 'ready' })
	})
})

describe('a dish a server brought to the table', () => {
	it('is served, whatever the pass shows, and keeps the others matched', () => {
		const sent = (id: string, itemId: string, servedAt?: number): CartLine => ({
			id,
			itemId,
			name: id,
			variantId: null,
			variantLabel: null,
			quantity: 1,
			baseCents: 100,
			instructions: '',
			options: [],
			sentAt: 1,
			servedAt,
		})
		const statuses = dishStatuses(
			[sent('a', 'item-0', 9), sent('b', 'item-1')],
			ticket(),
		)
		expect(Object.fromEntries(statuses)).toEqual({
			a: 'served',
			b: 'preparing',
		})
		expect(
			Object.fromEntries(dishStatuses([sent('a', 'item-0', 9)], undefined)),
		).toEqual({ a: 'served' })
	})

	it('tells two of a dish apart by their choices', () => {
		const sent = (id: string, itemId: string): CartLine => ({
			id,
			itemId,
			name: id,
			variantId: null,
			variantLabel: null,
			quantity: 1,
			baseCents: 100,
			instructions: '',
			options: [],
			sentAt: 1,
		})
		const choice = (optionName: string) => ({
			groupId: 'g',
			groupName: 'Cooked',
			optionId: optionName,
			optionName,
			quantity: 1,
			unitCents: 0,
			taxable: true,
		})
		const dish = (stage: 'new' | 'ready', option: string) => ({
			...ticket().lines[0]!,
			id: option,
			stage,
			options: [{ name: option, quantity: 1, half: null }],
		})
		const statuses = dishStatuses(
			[
				{ ...sent('a', 'item-0'), options: [choice('Well done')] },
				{ ...sent('b', 'item-0'), options: [choice('Medium')] },
			],
			ticket({ lines: [dish('ready', 'Medium'), dish('new', 'Well done')] }),
		)
		expect(Object.fromEntries(statuses)).toEqual({ a: 'queued', b: 'ready' })
	})
})
