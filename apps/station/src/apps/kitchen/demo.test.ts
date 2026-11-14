import 'fake-indexeddb/auto'
import {
	kdsConfigSchema,
	kdsFeedSchema,
	type KdsCommand,
	type KdsTicket,
} from '@repo/common/kds'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitchenError } from './api.ts'
import { createDemoKitchen, DEMO_KDS_CONFIG } from './demo.ts'
import { stationStage, visibleTickets } from './model.ts'
import { db } from '~/lib/db.ts'
import {
	createOrder,
	DEMO_ORIGIN,
	updateTab,
	voidTab,
	type OrderDraft,
} from '~/lib/orders.ts'

const T0 = Date.now()
let now = T0
const kitchen = () => createDemoKitchen(() => now)
const view = (tickets: KdsTicket[], v: 'active' | 'scheduled' | 'done') =>
	visibleTickets(
		tickets,
		DEMO_KDS_CONFIG,
		{ stationId: null, channel: 'all', view: v },
		now,
	)
const refusal = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(error: unknown) =>
			error instanceof KitchenError ? [error.status, error.code] : error,
	)
const stage = (
	ticket: KdsTicket,
	extra: Partial<KdsCommand> = {},
): KdsCommand => ({
	source: ticket.source,
	orderId: ticket.id,
	expectedVersion: ticket.version,
	action: 'stage',
	stationId: null,
	lineId: null,
	stage: 'ready',
	...extra,
})

const sale: OrderDraft = {
	terminalCode: 'T1',
	locationId: 'loc-1',
	currency: 'USD',
	taxRatePercent: 8.25,
	orderType: 'dine_in',
	customerName: '',
	tableLabel: '21',
	lines: [
		{
			id: 'l1',
			itemId: 'i-burger',
			name: 'Smash Burger',
			variantId: null,
			variantLabel: null,
			quantity: 1,
			baseCents: 1350,
			instructions: 'No pickles',
			options: [
				{
					groupId: 'g-temp',
					groupName: 'How would you like it cooked?',
					optionId: 'o-med',
					optionName: 'Medium',
					quantity: 1,
					unitCents: 0,
					taxable: true,
				},
			],
		},
	],
	adjustments: [],
	tipCents: 0,
	origin: DEMO_ORIGIN,
}

afterEach(() => {
	vi.useRealTimers()
})
beforeEach(async () => {
	now = T0
	await db.orders.clear()
	await db.meta.clear()
})

describe('demo kitchen', () => {
	it('opens on a rush: every column, scheduled pickups, history and a cancellation', async () => {
		const feed = await kitchen().feed()
		expect(kdsFeedSchema.parse(feed)).toEqual(feed)
		expect(kdsConfigSchema.parse(feed.config)).toEqual(DEMO_KDS_CONFIG)
		const live = view(feed.tickets, 'active')
		expect(new Set(live.map((ticket) => stationStage(ticket, null)))).toEqual(
			new Set(['new', 'preparing', 'ready']),
		)
		expect(live.some((ticket) => ticket.cancelled)).toBe(true)
		expect(new Set(live.map((ticket) => ticket.channel))).toEqual(
			new Set(['counter', 'phone', 'online']),
		)
		expect(view(feed.tickets, 'scheduled')).toHaveLength(2)
		expect(view(feed.tickets, 'done')).toHaveLength(2)
		// Lines go to the stations the demo menu is set up with.
		const stations = new Set(
			feed.tickets.flatMap((ticket) => ticket.lines.map((l) => l.stationId)),
		)
		expect(stations).toEqual(
			new Set(['grill', 'fryer', 'pizza', 'pastry', 'bar', 'kitchen']),
		)
	})

	it('keeps the server rules for stages, done and recall', async () => {
		const demo = kitchen()
		let feed = await demo.feed()
		const ticket = view(feed.tickets, 'active').find(
			(entry) => !entry.cancelled && stationStage(entry, null) === 'new',
		)!
		expect(
			await refusal(
				demo.command({ ...stage(ticket), action: 'done', stage: undefined }),
			),
		).toEqual([409, 'ticket_not_ready'])
		feed = await demo.command(stage(ticket))
		const ready = feed.tickets.find((entry) => entry.id === ticket.id)!
		expect(ready.version).not.toBe(ticket.version)
		expect(ready.lines.every((line) => line.stage === 'ready')).toBe(true)
		// The screen that still shows the old version is refused, not replayed.
		expect(await refusal(demo.command(stage(ticket)))).toEqual([
			409,
			'stale_ticket',
		])
		now += 60_000
		feed = await demo.command({
			...stage(ready),
			action: 'done',
			stage: undefined,
		})
		const done = feed.tickets.find((entry) => entry.id === ticket.id)!
		expect(done.completedAt).toBe(now)
		expect(
			await refusal(demo.command({ ...stage(done), stage: 'new' })),
		).toEqual([409, 'ticket_done'])
		feed = await demo.command({
			...stage(done),
			action: 'recall',
			stage: undefined,
		})
		const recalled = feed.tickets.find((entry) => entry.id === ticket.id)!
		expect(recalled.completedAt).toBeNull()
		expect(view([recalled], 'active')).toHaveLength(1)
		// A cancelled ticket cannot be worked on.
		const cancelled = feed.tickets.find((entry) => entry.cancelled)!
		expect(await refusal(demo.command(stage(cancelled)))).toEqual([
			404,
			'ticket_not_found',
		])
	})

	it('routes by the saved setup and refuses a stale one', async () => {
		const demo = kitchen()
		const before = await demo.feed()
		const config = {
			...before.config,
			stations: before.config.stations.map((station) =>
				station.id === 'grill'
					? { ...station, itemIds: [] }
					: station.id === 'fryer'
						? { ...station, itemIds: [...station.itemIds, 'i-burger'] }
						: station,
			),
		}
		const after = await demo.configure(before.configVersion, config)
		expect(after.configVersion).toBe(before.configVersion + 1)
		const burger = after.tickets
			.flatMap((ticket) => ticket.lines)
			.find((line) => line.itemId === 'i-burger')!
		expect(burger.stationId).toBe('fryer')
		// Every open screen must re-read before it changes a ticket.
		expect(after.tickets[0]!.version).not.toBe(before.tickets[0]!.version)
		expect(await refusal(demo.configure(before.configVersion, config))).toEqual(
			[409, 'stale_settings'],
		)
	})

	it('shows sales rung up in demo mode, never a real restaurant’s', async () => {
		const demoSale = await createOrder(sale)
		await createOrder({ ...sale, origin: 'joes' })
		const demo = kitchen()
		let feed = await demo.feed()
		const ticket = feed.tickets.find((entry) => entry.id === demoSale.id)!
		expect(ticket).toMatchObject({
			source: 'pos',
			number: demoSale.number,
			channel: 'counter',
			fulfillment: 'dine_in',
			tableLabel: '21',
			cancelled: false,
		})
		expect(ticket.lines[0]).toMatchObject({
			name: 'Smash Burger',
			instructions: 'No pickles',
			options: [{ name: 'Medium', quantity: 1, half: null }],
			stationId: 'grill',
			stage: 'new',
		})
		expect(
			feed.tickets.filter((entry) => entry.tableLabel === '21'),
		).toHaveLength(1)
		feed = await demo.command(stage(ticket))
		expect(
			feed.tickets.find((entry) => entry.id === demoSale.id)!.lines[0]!.stage,
		).toBe('ready')
		await voidTab(demoSale.id, {
			reason: 'mistake',
			by: null,
			approvedBy: null,
		})
		feed = await demo.feed()
		expect(
			feed.tickets.find((entry) => entry.id === demoSale.id)!.cancelled,
		).toBe(true)
	})

	it('lets cancelled samples go after half an hour and done ones after four', async () => {
		const demo = kitchen()
		const first = await demo.feed()
		now += 29 * 60_000
		expect((await demo.feed()).tickets.some((t) => t.cancelled)).toBe(false)
		now = T0 + 5 * 3_600_000
		const later = await demo.feed()
		expect(view(later.tickets, 'done')).toHaveLength(0)
		expect(later.tickets.length).toBeLessThan(first.tickets.length)
	})

	it('brings a finished tab back as new work when the table adds a round', async () => {
		// The till stamps each round with its own clock.
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(T0)
		const tab = await createOrder(sale)
		const demo = kitchen()
		const find = (feed: { tickets: KdsTicket[] }) =>
			feed.tickets.find((entry) => entry.id === tab.id)!
		let feed = await demo.command(stage(find(await demo.feed())))
		feed = await demo.command({
			...stage(find(feed)),
			action: 'done',
		})
		expect(find(feed).completedAt).not.toBeNull()

		now = T0 + 40 * 60_000
		vi.setSystemTime(now)
		const saved = (await db.orders.get(tab.id))!
		await updateTab(tab.id, {
			...sale,
			lines: [...saved.lines, { ...sale.lines[0]!, id: 'l2', quantity: 2 }],
		})
		feed = await demo.feed()
		const reopened = find(feed)
		expect(reopened.completedAt).toBeNull()
		expect(reopened.lines.map((line) => line.stage)).toEqual(['ready', 'new'])
		expect(reopened.lines[1]!.firedAt).toBe(now)
		// The burger went out when the ticket was cleared.
		expect(reopened.lines.map((line) => line.servedAt)).toEqual([T0, undefined])
		// It waits in New, not half-done in Preparing.
		expect(view(feed.tickets, 'active')).toContainEqual(reopened)
		expect(stationStage(reopened, null)).toBe('new')
		// Starting it leaves the burger already made ready.
		feed = await demo.command({ ...stage(reopened), stage: 'preparing' })
		expect(find(feed).lines.map((line) => line.stage)).toEqual([
			'ready',
			'preparing',
		])
		expect(find(feed).lines[0]!.servedAt).toBe(T0)
	})

	it('keeps the kitchen’s work through a reload, and otherwise starts from the till', async () => {
		let kept: string | null = null
		const memory = {
			read: () => kept,
			write: (value: string) => {
				kept = value
			},
		}
		const tab = await createOrder(sale)
		const first = createDemoKitchen(() => now, undefined, memory)
		const find = (feed: { tickets: KdsTicket[] }) =>
			feed.tickets.find((entry) => entry.id === tab.id)!
		await first.command(stage(find(await first.feed())))
		const reloaded = createDemoKitchen(() => now, undefined, memory)
		expect(find(await reloaded.feed()).lines[0]!.stage).toBe('ready')

		// No record at all (an older tab): what the till marked served went out.
		const saved = (await db.orders.get(tab.id))!
		await db.orders.update(tab.id, {
			lines: saved.lines.map((line) => ({ ...line, servedAt: T0 + 1 })),
		})
		const line = find(await kitchen().feed()).lines[0]!
		expect(line.stage).toBe('ready')
		expect(line.servedAt).toBe(T0 + 1)
	})

	it('gives online tickets a promised time and pushes it back with the server rules', async () => {
		const k = kitchen()
		const feed = await k.feed()
		const promised = feed.tickets.filter((ticket) => ticket.promisedAt != null)
		expect(promised.length).toBeGreaterThan(0)
		expect(promised.every((ticket) => ticket.source === 'online')).toBe(true)
		for (const ticket of feed.tickets.filter((x) => x.source === 'pos'))
			expect('promisedAt' in ticket).toBe(false)
		const ticket = promised.find((entry) => entry.promisedUntil != null)!
		const delay = (
			from: KdsTicket,
			minutes: 5 | 10 | 15,
			version = from.promisedVersion!,
		): KdsCommand => ({
			source: from.source,
			orderId: from.id,
			expectedVersion: from.version,
			action: 'delay',
			stationId: null,
			lineId: null,
			minutes,
			expectedPromisedVersion: version,
		})
		const after = (await k.command(delay(ticket, 10))).tickets.find(
			(entry) => entry.id === ticket.id,
		)!
		expect(after.promisedAt).toBe(ticket.promisedAt! + 10 * 60_000)
		expect(after.promisedUntil).toBe(ticket.promisedUntil! + 10 * 60_000)
		expect(after.promisedVersion).toBe(ticket.promisedVersion! + 1)
		// A replay of the same tap names the old version.
		expect(
			await refusal(k.command(delay(after, 10, ticket.promisedVersion!))),
		).toEqual([409, 'stale_version'])
		// 10 + 15 * 5 = 85; one more 10 passes 90.
		let current = after
		for (let i = 0; i < 5; i++)
			current = (await k.command(delay(current, 15))).tickets.find(
				(entry) => entry.id === ticket.id,
			)!
		expect(await refusal(k.command(delay(current, 10)))).toEqual([
			409,
			'delay_limit',
		])
		// Walk-in tickets have no promised time.
		const walkIn = feed.tickets.find(
			(entry) =>
				entry.source === 'pos' && !entry.cancelled && !entry.completedAt,
		)!
		expect(await refusal(k.command(delay(walkIn, 5, 0)))).toEqual([
			409,
			'no_promised_time',
		])
		// A finished ticket is closed.
		const done = feed.tickets.find(
			(entry) => entry.source === 'online' && entry.completedAt,
		)!
		expect(await refusal(k.command(delay(done, 5, 0)))).toEqual([
			409,
			'order_closed',
		])
	})

	it('keeps contacts, addresses and prices out of the kitchen contract', async () => {
		const feed = await kitchen().feed()
		const keys = new Set<string>()
		for (const ticket of feed.tickets) {
			Object.keys(ticket).forEach((key) => keys.add(key))
			ticket.lines.forEach((line) =>
				Object.keys(line).forEach((key) => keys.add(key)),
			)
		}
		expect(
			[...keys].filter((key) =>
				/phone|email|address|name$|price|total|cents|tip|customer|staff/i.test(
					key,
				),
			),
		).toEqual(['name'])
	})
})
