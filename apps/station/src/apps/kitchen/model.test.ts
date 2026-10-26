import { DEFAULT_KDS_CONFIG, type KdsTicket } from '@repo/common/kds'
import { describe, expect, it } from 'vitest'
import {
	allDayCounts,
	averageTicketMinutes,
	laterRound,
	nextKitchenStage,
	stationStage,
	visibleTickets,
	workFiredAt,
} from './model.ts'

const ticket = (patch: Partial<KdsTicket> = {}): KdsTicket => ({
	id: 'ticket',
	source: 'pos',
	number: 'T1-001',
	channel: 'counter',
	fulfillment: 'dine_in',
	tableLabel: '12',
	createdAt: 1000,
	dueAt: null,
	completedAt: null,
	cancelled: false,
	version: 'a',
	lines: [
		{
			id: 'line',
			itemId: 'burger',
			name: 'Burger',
			quantity: 1,
			variant: null,
			variantId: null,
			options: [],
			instructions: '',
			stationId: 'kitchen',
			stage: 'new',
		},
	],
	...patch,
})
const filter = { stationId: null, channel: 'all', view: 'active' as const }
describe('kitchen queue', () => {
	it('separates live, scheduled and recalled history without mixing locations', () => {
		const tickets = [
			ticket(),
			ticket({ id: 'later', dueAt: 10_000_000 }),
			ticket({ id: 'done', completedAt: 2000 }),
		]
		expect(
			visibleTickets(tickets, DEFAULT_KDS_CONFIG, filter, 5000).map(
				(entry) => entry.id,
			),
		).toEqual(['ticket'])
		expect(
			visibleTickets(
				tickets,
				DEFAULT_KDS_CONFIG,
				{ ...filter, view: 'scheduled' },
				5000,
			).map((entry) => entry.id),
		).toEqual(['later'])
		expect(
			visibleTickets(
				tickets,
				DEFAULT_KDS_CONFIG,
				{ ...filter, view: 'done' },
				5000,
			).map((entry) => entry.id),
		).toEqual(['done'])
	})
	it('filters source and station, with the pass seeing every line', () => {
		expect(
			visibleTickets(
				[ticket()],
				DEFAULT_KDS_CONFIG,
				{ ...filter, channel: 'online' },
				5000,
			),
		).toEqual([])
		expect(
			visibleTickets(
				[ticket()],
				DEFAULT_KDS_CONFIG,
				{ ...filter, stationId: 'bar' },
				5000,
			),
		).toEqual([])
		expect(stationStage(ticket(), null)).toBe('new')
	})
	it('supports two-stage quick service and three-stage preparation', () => {
		expect(nextKitchenStage('new', DEFAULT_KDS_CONFIG)).toBe('preparing')
		expect(
			nextKitchenStage('new', { ...DEFAULT_KDS_CONFIG, showPreparing: false }),
		).toBe('ready')
		expect(nextKitchenStage('preparing', DEFAULT_KDS_CONFIG)).toBe('ready')
		expect(nextKitchenStage('ready', DEFAULT_KDS_CONFIG)).toBe('new')
	})
})

describe('a round a table adds after the kitchen made the first', () => {
	const MINUTE = 60_000
	const dish = (
		id: string,
		stage: KdsTicket['lines'][number]['stage'],
		firedAt?: number,
	) => ({ ...ticket().lines[0]!, id, stage, firedAt })
	// The tab opened at 1000; its mains went out; dessert came 40 minutes later.
	const reopened = (dessert: 'new' | 'preparing' = 'new') =>
		ticket({
			id: 'tab',
			lines: [
				dish('mains', 'ready'),
				dish('dessert', dessert, 1000 + 40 * MINUTE),
			],
		})

	it('is new work, timed and queued from when it was added', () => {
		expect(laterRound(reopened(), null)?.map((line) => line.id)).toEqual([
			'dessert',
		])
		expect(stationStage(reopened(), null)).toBe('new')
		expect(stationStage(reopened('preparing'), null)).toBe('preparing')
		expect(workFiredAt(reopened(), DEFAULT_KDS_CONFIG, null)).toBe(
			1000 + 40 * MINUTE,
		)
		// A ticket that came in at minute 10 is made before the dessert.
		const waiting = ticket({ id: 'waiting', createdAt: 1000 + 10 * MINUTE })
		expect(
			visibleTickets(
				[reopened(), waiting],
				DEFAULT_KDS_CONFIG,
				filter,
				1000 + 41 * MINUTE,
			).map((entry) => entry.id),
		).toEqual(['waiting', 'tab'])
	})

	it('is not a later round when dishes of one round are made one by one', () => {
		const fired = 1000
		const oneRound = ticket({
			lines: [dish('fries', 'ready', fired), dish('burger', 'new', fired)],
		})
		expect(laterRound(oneRound, null)).toBeNull()
		expect(stationStage(oneRound, null)).toBe('preparing')
		expect(workFiredAt(oneRound, DEFAULT_KDS_CONFIG, null)).toBe(fired)
		// Without a time for the open dishes, nothing says they came later.
		const unknown = ticket({
			lines: [dish('fries', 'ready'), dish('burger', 'new')],
		})
		expect(laterRound(unknown, null)).toBeNull()
		expect(stationStage(unknown, null)).toBe('preparing')
	})
})

describe('the all day count', () => {
	const line = (
		id: string,
		itemId: string,
		quantity: number,
		stage: 'new' | 'preparing' | 'ready',
		stationId = 'kitchen',
	) => ({
		id,
		itemId,
		name: itemId,
		quantity,
		variant: null,
		variantId: null,
		options: [],
		instructions: '',
		stationId,
		stage,
	})
	it('adds up what is still to make, most first, and skips ready, done and cancelled', () => {
		const counts = allDayCounts(
			[
				ticket({
					lines: [
						line('a', 'burger', 2, 'new'),
						line('b', 'fries', 1, 'preparing'),
						line('c', 'cola', 3, 'ready'),
					],
				}),
				ticket({ id: 't2', lines: [line('d', 'burger', 1, 'preparing')] }),
				ticket({
					id: 'done',
					completedAt: 5,
					lines: [line('e', 'fries', 4, 'new')],
				}),
				ticket({
					id: 'void',
					cancelled: true,
					lines: [line('f', 'fries', 4, 'new')],
				}),
			],
			null,
		)
		expect(counts.map((c) => [c.itemId, c.quantity])).toEqual([
			['burger', 3],
			['fries', 1],
		])
	})
	it('counts one station only when one is chosen', () => {
		const counts = allDayCounts(
			[
				ticket({
					lines: [
						line('a', 'burger', 2, 'new', 'grill'),
						line('b', 'salad', 1, 'new', 'cold'),
					],
				}),
			],
			'grill',
		)
		expect(counts.map((c) => c.itemId)).toEqual(['burger'])
	})
})

describe('the average ticket time', () => {
	const done = (id: string, minutes: number, completedAt = 10_000_000) =>
		ticket({
			id,
			createdAt: completedAt - minutes * 60_000,
			completedAt,
		})
	it('averages recent cleared tickets from firing to cleared', () => {
		const now = 10_000_000
		expect(
			averageTicketMinutes(
				[done('a', 10), done('b', 14), done('c', 12), ticket({ id: 'open' })],
				DEFAULT_KDS_CONFIG,
				now,
			),
		).toBe(12)
	})
	it('measures a tab from its last round, not from when it opened', () => {
		const now = 10_000_000
		const later = ticket({
			id: 'tab',
			createdAt: now - 60 * 60_000,
			completedAt: now,
			lines: [
				{ ...ticket().lines[0]!, id: 'a' },
				{ ...ticket().lines[0]!, id: 'b', firedAt: now - 8 * 60_000 },
			],
		})
		expect(
			averageTicketMinutes([later, later, later], DEFAULT_KDS_CONFIG, now),
		).toBe(8)
	})
	it('says nothing with too few tickets, or only old ones', () => {
		const now = 10_000_000
		expect(
			averageTicketMinutes(
				[done('a', 10), done('b', 14)],
				DEFAULT_KDS_CONFIG,
				now,
			),
		).toBeNull()
		expect(
			averageTicketMinutes(
				[done('a', 10, 1), done('b', 10, 1), done('c', 10, 1)],
				DEFAULT_KDS_CONFIG,
				now,
			),
		).toBeNull()
	})
})
