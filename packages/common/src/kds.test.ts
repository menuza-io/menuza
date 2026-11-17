import { describe, expect, it } from 'vitest'
import {
	DEFAULT_KDS_CONFIG,
	kdsCommandSchema,
	kdsConfigSchema,
	kdsCoverageGaps,
	kdsFireAt,
	kdsStationFor,
	kdsStationsFor,
	kdsTicketStage,
	type KdsConfig,
} from './kds.ts'

describe('kitchen contract', () => {
	it('has a valid quick-start configuration', () => {
		expect(kdsConfigSchema.safeParse(DEFAULT_KDS_CONFIG).success).toBe(true)
	})
	it('routes unmatched items to the default and explicit items to their prep station', () => {
		const config = {
			...DEFAULT_KDS_CONFIG,
			stations: [
				...DEFAULT_KDS_CONFIG.stations,
				{ id: 'bar', name: 'Bar', itemIds: ['coffee'] },
			],
		}
		expect(kdsStationFor(config, 'coffee')).toBe('bar')
		expect(kdsStationFor(config, 'burger')).toBe('kitchen')
	})
	it('refuses duplicate routes, duplicate ids, missing defaults and inverted timing', () => {
		const config = { ...DEFAULT_KDS_CONFIG }
		expect(
			kdsConfigSchema.safeParse({
				...config,
				stations: [config.stations[0], config.stations[0]],
			}).success,
		).toBe(false)
		expect(
			kdsConfigSchema.safeParse({ ...config, defaultStationId: 'missing' })
				.success,
		).toBe(false)
		expect(
			kdsConfigSchema.safeParse({ ...config, lateMinutes: 5 }).success,
		).toBe(false)
		expect(
			kdsConfigSchema.safeParse({
				...config,
				stations: [
					{ id: 'one', name: 'One', itemIds: ['coffee'] },
					{ id: 'kitchen', name: 'Two', itemIds: ['coffee'] },
				],
			}).success,
		).toBe(false)
	})
	it('readies the pass only when every line is ready', () => {
		expect(kdsTicketStage([])).toBe('new')
		expect(kdsTicketStage([{ stage: 'new' }, { stage: 'ready' }])).toBe(
			'preparing',
		)
		expect(kdsTicketStage([{ stage: 'ready' }, { stage: 'ready' }])).toBe(
			'ready',
		)
	})
	it('reads a config saved before routing and ticket switches', () => {
		const legacy = {
			stations: [{ id: 'kitchen', name: 'Kitchen', itemIds: ['burger'] }],
			defaultStationId: 'kitchen',
			workflow: 'ticket',
			showPreparing: true,
			warningMinutes: 10,
			lateMinutes: 20,
			fireAheadMinutes: 30,
		}
		const parsed = kdsConfigSchema.parse(legacy)
		expect(parsed.showPaymentStatus).toBeUndefined()
		expect(parsed.stations[0]?.fulfillments).toBeUndefined()
		expect(kdsCoverageGaps(parsed)).toEqual([])
		expect(
			kdsStationsFor(parsed, {
				itemId: 'burger',
				fulfillment: 'dine_in',
				channel: 'counter',
			}),
		).toEqual(['kitchen'])
		expect(
			kdsStationsFor(parsed, {
				itemId: 'salad',
				fulfillment: 'drive_through',
				channel: 'qr',
			}),
		).toEqual(['kitchen'])
	})
	it('routes by order type and channel, and keeps an all-dishes station', () => {
		const config: KdsConfig = {
			...DEFAULT_KDS_CONFIG,
			stations: [
				{
					id: 'kitchen',
					name: 'Kitchen',
					itemIds: [],
					fulfillments: ['dine_in', 'takeaway'],
					channels: ['counter', 'phone', 'online', 'qr'],
				},
				{
					id: 'pack',
					name: 'Pack',
					itemIds: [],
					allItems: true,
					fulfillments: ['delivery'],
					channels: ['online'],
				},
				{
					id: 'grill',
					name: 'Grill',
					itemIds: ['burger'],
					fulfillments: ['dine_in', 'takeaway', 'delivery', 'drive_through'],
					channels: ['counter', 'phone', 'online', 'qr'],
				},
			],
			defaultStationId: 'kitchen',
		}
		expect(
			kdsStationsFor(config, {
				itemId: 'burger',
				fulfillment: 'dine_in',
				channel: 'counter',
			}),
		).toEqual(['grill'])
		expect(
			kdsStationsFor(config, {
				itemId: 'burger',
				fulfillment: 'delivery',
				channel: 'online',
			}),
		).toEqual(['pack', 'grill'])
		expect(
			kdsStationsFor(config, {
				itemId: 'salad',
				fulfillment: 'delivery',
				channel: 'counter',
			}),
		).toEqual(['kitchen'])
		expect(
			kdsCoverageGaps({
				stations: [
					{
						id: 'pack',
						itemIds: [],
						fulfillments: ['delivery'],
						channels: ['online'],
					},
				],
			}).some(
				(gap) => gap.fulfillment === 'dine_in' && gap.channel === 'counter',
			),
		).toBe(true)
	})
	it('starts scheduled-order timers when preparation is due', () => {
		expect(
			kdsFireAt({ createdAt: 1000, dueAt: 3_600_000 }, DEFAULT_KDS_CONFIG),
		).toBe(1_800_000)
		expect(
			kdsFireAt({ createdAt: 1000, dueAt: null }, DEFAULT_KDS_CONFIG),
		).toBe(1000)
	})
	it('requires an explicit stage and whole-ticket completion', () => {
		const input = {
			source: 'pos',
			orderId: 'one',
			expectedVersion: 'a'.repeat(64),
		}
		expect(
			kdsCommandSchema.safeParse({ ...input, action: 'stage' }).success,
		).toBe(false)
		expect(
			kdsCommandSchema.safeParse({
				...input,
				action: 'done',
				stationId: 'grill',
			}).success,
		).toBe(false)
		expect(
			kdsCommandSchema.safeParse({ ...input, action: 'recall' }).success,
		).toBe(true)
	})
	it('delays by 5, 10 or 15 minutes, naming the promised version it saw', () => {
		const input = {
			source: 'online',
			orderId: 'one',
			expectedVersion: 'a'.repeat(64),
			action: 'delay',
		}
		for (const minutes of [5, 10, 15])
			expect(
				kdsCommandSchema.safeParse({
					...input,
					minutes,
					expectedPromisedVersion: 0,
				}).success,
			).toBe(true)
		for (const minutes of [0, -5, 20, 7.5, '10'])
			expect(
				kdsCommandSchema.safeParse({
					...input,
					minutes,
					expectedPromisedVersion: 0,
				}).success,
			).toBe(false)
		// Both the minutes and the version are required.
		expect(kdsCommandSchema.safeParse({ ...input, minutes: 10 }).success).toBe(
			false,
		)
		expect(
			kdsCommandSchema.safeParse({ ...input, expectedPromisedVersion: 0 })
				.success,
		).toBe(false)
		// A delay is whole-ticket; other actions take no minutes.
		expect(
			kdsCommandSchema.safeParse({
				...input,
				minutes: 10,
				expectedPromisedVersion: 0,
				stationId: 'grill',
			}).success,
		).toBe(false)
		expect(
			kdsCommandSchema.safeParse({
				...input,
				action: 'done',
				minutes: 10,
			}).success,
		).toBe(false)
	})
})
