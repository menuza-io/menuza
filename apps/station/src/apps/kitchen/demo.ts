import {
	DEFAULT_KDS_CONFIG,
	kdsConfigSchema,
	kdsStationFor,
	kdsTicketStage,
	type KdsCommand,
	type KdsConfig,
	type KdsFeed,
	type KdsLine,
	type KdsStage,
	type KdsTicket,
} from '@repo/common/kds'
import { KitchenError } from './api.ts'
import { db, type PosOrder } from '~/lib/db.ts'
import { DEMO_ORIGIN } from '~/lib/orders.ts'

/**
 * Demo mode's kitchen: sample tickets for the demo menu, plus the sales rung up
 * on this tablet in demo mode. It lives in this tab's memory and keeps the
 * regional server's rules (a stale version is refused, Done needs every dish
 * ready, only a done ticket can be recalled), so the screen behaves as it does
 * in service. Nothing is ever sent.
 */

const MINUTE = 60_000
const DAY = 86_400_000
/** As on the server: done tickets stay for recall 4 hours, cancelled ones 30 minutes. */
const RECALL_MS = 4 * 3_600_000
const CANCELLED_MS = 30 * MINUTE

type DemoLine = Omit<KdsLine, 'id' | 'stationId' | 'stage' | 'servedAt'>
type DemoOrder = Omit<KdsTicket, 'version' | 'completedAt' | 'lines'> & {
	lines: DemoLine[]
	/** A cancelled sample leaves the screen then, like a voided sale. */
	hiddenAt?: number
	/** What the till recorded as served, by line (a sale's only). */
	servedOnTill?: Array<number | null>
	/** The till's id for each line (a sale's only): the dish's key, as on the server. */
	lineKeys?: string[]
}
type Progress = {
	revision: number
	stages: Record<string, KdsStage>
	completedAt: number | null
	/** As on the server: when a dish left the pass, until it is made again. */
	served?: Record<string, number>
}

/** Stations for the demo menu (`demo-catalog.ts`); anything else goes to the kitchen. */
export const DEMO_KDS_CONFIG: KdsConfig = {
	...DEFAULT_KDS_CONFIG,
	stations: [
		{ id: 'kitchen', name: 'Kitchen', itemIds: [] },
		{
			id: 'grill',
			name: 'Grill',
			itemIds: ['i-burger', 'i-chicken', 'i-salmon', 'i-steak', 'i-ribs'],
		},
		{ id: 'fryer', name: 'Fryer', itemIds: ['i-fries', 'i-wings'] },
		{ id: 'pizza', name: 'Pizza oven', itemIds: ['i-marg', 'i-pep'] },
		{ id: 'pastry', name: 'Pastry', itemIds: ['i-brownie', 'i-cheese'] },
		{
			id: 'bar',
			name: 'Bar',
			itemIds: [
				'i-water',
				'i-tap',
				'i-latte',
				'i-tea',
				'i-cola',
				'i-oj',
				'i-apple',
				'i-lemon',
			],
		},
	],
	defaultStationId: 'kitchen',
}

/** A 64-hex fingerprint shaped like the server's SHA-256 versions. Not a security hash. */
function fingerprint(value: unknown) {
	const text = JSON.stringify(value)
	let hex = ''
	for (let seed = 0; seed < 8; seed++) {
		let hash = 0x811c9dc5 ^ seed
		for (let i = 0; i < text.length; i++)
			hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
		hex += (hash >>> 0).toString(16).padStart(8, '0')
	}
	return hex
}

const keyOf = (order: Pick<DemoOrder, 'source' | 'id'>) =>
	`${order.source}:${order.id}`

/** The server's projection: a line's id follows its content, so a changed dish is new work. */
function project(
	order: DemoOrder,
	saved: Progress | undefined,
	config: KdsConfig,
	configVersion: number,
): KdsTicket {
	const lines = order.lines.map((line, index): KdsLine => {
		const id = fingerprint({
			key: order.lineKeys?.[index] ?? String(index),
			...line,
		})
		// A sale this kitchen has no record of starts from the till: what it
		// recorded as served went out.
		const tillServed = saved ? null : (order.servedOnTill?.[index] ?? null)
		const stage = saved?.stages[id] ?? (tillServed ? 'ready' : 'new')
		const servedAt =
			stage === 'ready' ? (saved?.served?.[id] ?? tillServed) : null
		return {
			...line,
			id,
			stationId: kdsStationFor(config, line.itemId),
			stage,
			...(servedAt ? { servedAt } : {}),
		}
	})
	const complete =
		lines.length > 0 && lines.every((line) => line.stage === 'ready')
	return {
		id: order.id,
		source: order.source,
		number: order.number,
		channel: order.channel,
		fulfillment: order.fulfillment,
		tableLabel: order.tableLabel,
		createdAt: order.createdAt,
		dueAt: order.dueAt,
		version: fingerprint([order, configVersion, saved?.revision ?? 0]),
		completedAt: complete ? (saved?.completedAt ?? null) : null,
		cancelled: order.cancelled,
		lines,
	}
}

type SampleLine = DemoLine & { stage?: KdsStage }
type Sample = Omit<DemoOrder, 'lines'> & {
	lines: SampleLine[]
	/** Done samples: every dish is ready. */
	completedAt?: number
}

const dish = (
	itemId: string,
	name: string,
	quantity = 1,
	extra: Partial<SampleLine> = {},
): SampleLine => ({
	itemId,
	name,
	quantity,
	variant: null,
	variantId: null,
	options: [],
	instructions: '',
	...extra,
})
const option = (name: string) => ({ name, quantity: 1, half: null })

/** A lunch rush a few minutes in: something in every column, scheduled pickups and recent history. */
function samples(t0: number): Sample[] {
	const ago = (minutes: number) => t0 - minutes * MINUTE
	const ahead = (minutes: number) => t0 + minutes * MINUTE
	// The other register at the counter; this one numbers its own sales.
	const till = (n: number) => `T2-${String(n).padStart(4, '0')}`
	const day = new Date(t0).toISOString().slice(0, 10).replace(/-/g, '')
	const web = (n: number) => `${day}-${String(n).padStart(4, '0')}`
	const pos = {
		source: 'pos',
		channel: 'counter',
		tableLabel: null,
		dueAt: null,
		cancelled: false,
	} as const
	const online = { ...pos, source: 'online', channel: 'online' } as const
	return [
		{
			...pos,
			id: 'demo-till-47',
			number: till(47),
			fulfillment: 'dine_in',
			tableLabel: '12',
			createdAt: ago(1),
			lines: [
				dish('i-burger', 'Smash Burger', 2, {
					options: [option('Medium'), option('Bacon')],
				}),
				dish('i-fries', 'Truffle Fries'),
				dish('i-cola', 'Cola', 2),
			],
		},
		{
			...online,
			id: 'demo-web-18',
			number: web(18),
			fulfillment: 'takeaway',
			createdAt: ago(4),
			lines: [
				dish('i-marg', 'Margherita', 1, {
					variant: 'Large',
					variantId: 'v-lg',
					options: [option('Extra cheese')],
				}),
				dish('i-salad', 'Little Gem Caesar', 1, {
					instructions: 'No croutons',
				}),
			],
		},
		{
			...pos,
			id: 'demo-till-44',
			number: till(44),
			fulfillment: 'takeaway',
			createdAt: ago(6),
			cancelled: true,
			hiddenAt: ahead(28),
			lines: [
				dish('i-burger', 'Smash Burger', 1, {
					options: [option('Well done')],
				}),
				dish('i-water', 'Sparkling Water'),
			],
		},
		{
			...pos,
			id: 'demo-till-46',
			number: till(46),
			channel: 'phone',
			fulfillment: 'takeaway',
			createdAt: ago(8),
			dueAt: ahead(10),
			lines: [
				dish('i-steak', 'Steak Frites', 1, {
					options: [option('Medium rare')],
					stage: 'preparing',
				}),
				dish('i-soup', 'Tomato Soup'),
			],
		},
		{
			...pos,
			id: 'demo-till-45',
			number: till(45),
			fulfillment: 'dine_in',
			tableLabel: '4',
			createdAt: ago(13),
			lines: [
				dish('i-salmon', 'Seared Salmon', 1, {
					options: [option('Well done')],
					instructions: 'Sauce on the side',
					stage: 'preparing',
				}),
				dish('i-pasta', 'Fresh Pasta', 1, {
					options: [option('Pesto')],
					stage: 'preparing',
				}),
				dish('i-wings', 'Buffalo Wings', 1, { stage: 'ready' }),
				// Dessert ordered at the table after the mains went out: a later round.
				dish('i-brownie', 'Warm Brownie', 2, { firedAt: ago(2) }),
			],
		},
		{
			...online,
			id: 'demo-web-16',
			number: web(16),
			fulfillment: 'delivery',
			createdAt: ago(16),
			lines: [
				dish('i-chicken', 'Crispy Chicken Sandwich', 1, {
					options: [option('Avocado')],
					stage: 'ready',
				}),
				dish('i-fries', 'Truffle Fries', 2, { stage: 'ready' }),
				dish('i-brownie', 'Warm Brownie', 1, { stage: 'ready' }),
			],
		},
		{
			...pos,
			id: 'demo-till-43',
			number: till(43),
			fulfillment: 'dine_in',
			tableLabel: '9',
			createdAt: ago(24),
			lines: [
				dish('i-pep', 'Pepperoni', 2, {
					variant: 'Regular',
					variantId: 'v-sm',
					stage: 'ready',
				}),
				dish('i-veg', 'Roasted Veg Bowl', 1, {
					instructions: 'Nut allergy',
					stage: 'preparing',
				}),
			],
		},
		{
			...pos,
			id: 'demo-till-48',
			number: till(48),
			channel: 'phone',
			fulfillment: 'takeaway',
			createdAt: ago(3),
			dueAt: ahead(70),
			lines: [
				dish('i-chicken', 'Crispy Chicken Sandwich', 2),
				dish('i-fries', 'Truffle Fries', 2),
				dish('i-lemon', 'Fresh Lemonade', 1, {
					variant: 'Large',
					variantId: 'v-lg',
				}),
			],
		},
		{
			...online,
			id: 'demo-web-19',
			number: web(19),
			fulfillment: 'delivery',
			createdAt: ago(10),
			dueAt: ahead(95),
			lines: [
				dish('i-steak', 'Steak Frites', 1, { options: [option('Medium')] }),
				dish('i-cheese', 'Basque Cheesecake'),
			],
		},
		{
			...pos,
			id: 'demo-till-41',
			number: till(41),
			fulfillment: 'dine_in',
			tableLabel: '7',
			createdAt: ago(38),
			completedAt: ago(12),
			lines: [
				dish('i-veg', 'Roasted Veg Bowl'),
				dish('i-latte', 'Latte', 1, { variant: 'Large', variantId: 'v-lg' }),
			],
		},
		{
			...online,
			id: 'demo-web-15',
			number: web(15),
			fulfillment: 'takeaway',
			createdAt: ago(31),
			completedAt: ago(5),
			lines: [
				dish('i-marg', 'Margherita', 2, {
					variant: 'Regular',
					variantId: 'v-sm',
				}),
				dish('i-water', 'Sparkling Water'),
			],
		},
	]
}

/** A sale rung up in demo mode, read as the server reads an uploaded one. */
function fromSale(order: PosOrder): DemoOrder {
	return {
		id: order.id,
		source: 'pos',
		number: order.serverNumber ?? order.number,
		channel: order.orderSource ?? 'counter',
		fulfillment: order.orderType,
		tableLabel: order.tableLabel || null,
		createdAt: order.createdAt,
		dueAt: order.pickupAt ?? null,
		cancelled: order.status === 'void' || order.status === 'refunded',
		servedOnTill: order.lines.map((line) => line.servedAt ?? null),
		lineKeys: order.lines.map((line) => line.id),
		lines: order.lines.map((line) => ({
			itemId: line.itemId,
			name: line.name,
			// When the till sent it: a tab's later rounds show as added dishes.
			firedAt: line.sentAt ?? null,
			variant: line.variantLabel,
			variantId: line.variantId,
			quantity: line.quantity,
			instructions: line.instructions,
			options: line.options.map((choice) => ({
				name: choice.optionName,
				quantity: choice.quantity,
				half: null,
			})),
		})),
	}
}

/** Open tabs, today's sales, and sales cancelled in the last half hour. */
async function demoSales(now: number): Promise<DemoOrder[]> {
	const [recent, open] = await Promise.all([
		db.orders
			.where('createdAt')
			.aboveOrEqual(now - DAY)
			.toArray(),
		db.orders.where('status').equals('open').toArray(),
	])
	const cancelledAt = (order: PosOrder) =>
		order.status === 'void'
			? (order.voidedAt ?? 0)
			: Math.max(0, ...(order.refunds ?? []).map((refund) => refund.at))
	return [...new Map([...recent, ...open].map((o) => [o.id, o])).values()]
		.filter(
			(order) =>
				order.origin === DEMO_ORIGIN &&
				!order.transferredTo &&
				(order.status === 'open' ||
					order.status === 'paid' ||
					cancelledAt(order) >= now - CANCELLED_MS),
		)
		.map(fromSale)
}

/** Where the demo keeps the kitchen's work on this tab's sales, so a reload does not lose it. */
type Memory = { read: () => string | null; write: (value: string) => void }
const MEMORY_KEY = 'station.demo.kitchen.v1'
const tabMemory: Memory = {
	read: () => {
		try {
			return sessionStorage.getItem(MEMORY_KEY)
		} catch {
			return null
		}
	},
	write: (value) => {
		try {
			sessionStorage.setItem(MEMORY_KEY, value)
		} catch {
			/* the demo still works, it forgets on reload */
		}
	},
}

/** Same shape as `createKitchenApi`, answered on this tablet. */
export function createDemoKitchen(
	clock: () => number = Date.now,
	sales: (now: number) => Promise<DemoOrder[]> = demoSales,
	memory: Memory | null = null,
) {
	let state: {
		samples: DemoOrder[]
		progress: Map<string, Progress>
		config: KdsConfig
		configVersion: number
	} | null = null
	// Seeded when the kitchen first opens, so the rush is minutes old, not hours.
	const kitchen = () => {
		if (state) return state
		const progress = new Map<string, Progress>()
		const config = structuredClone(DEMO_KDS_CONFIG)
		const seeded = samples(clock()).map(({ lines, completedAt, ...rest }) => {
			const order: DemoOrder = {
				...rest,
				lines: lines.map(({ stage: ignoredStage, ...line }) => line),
			}
			const ticket = project(order, undefined, config, 1)
			progress.set(keyOf(order), {
				revision: 1,
				stages: Object.fromEntries(
					ticket.lines.map((line, index) => [
						line.id,
						completedAt ? 'ready' : (lines[index]?.stage ?? 'new'),
					]),
				),
				completedAt: completedAt ?? null,
			})
			return order
		})
		// The samples start over; the tab's own sales keep what the kitchen did.
		try {
			const kept = JSON.parse(memory?.read() ?? '[]') as Array<
				[string, Progress]
			>
			for (const [key, value] of kept)
				if (!progress.has(key)) progress.set(key, value)
		} catch {
			/* unreadable: start over */
		}
		state = { samples: seeded, progress, config, configVersion: 1 }
		return state
	}
	const remember = () => {
		if (!memory || !state) return
		const samples = new Set(state.samples.map(keyOf))
		memory.write(
			JSON.stringify([...state.progress].filter(([key]) => !samples.has(key))),
		)
	}
	const orders = async (now: number) => [
		...kitchen().samples.filter(
			(order) => order.hiddenAt === undefined || order.hiddenAt > now,
		),
		// The samples still show if this browser's storage cannot be read.
		...(await sales(now).catch(() => [])),
	]

	async function feed(): Promise<KdsFeed> {
		const now = clock()
		const { progress, config, configVersion } = kitchen()
		const tickets = (await orders(now))
			.map((order) =>
				project(order, progress.get(keyOf(order)), config, configVersion),
			)
			.filter(
				(ticket) =>
					ticket.lines.length > 0 &&
					(ticket.completedAt === null ||
						ticket.completedAt >= now - RECALL_MS ||
						ticket.cancelled),
			)
		return {
			config: structuredClone(config),
			configVersion,
			tickets,
			serverNow: now,
			truncated: false,
		}
	}

	async function command(command: KdsCommand): Promise<KdsFeed> {
		const now = clock()
		const current = kitchen()
		const order = (await orders(now)).find(
			(entry) =>
				entry.source === command.source &&
				entry.id === command.orderId &&
				!entry.cancelled,
		)
		if (!order) throw new KitchenError('ticket_not_found', 404)
		const saved = current.progress.get(keyOf(order))
		const ticket = project(order, saved, current.config, current.configVersion)
		if (ticket.version !== command.expectedVersion)
			throw new KitchenError('stale_ticket', 409)
		if (command.action === 'stage') {
			if (ticket.completedAt !== null)
				throw new KitchenError('ticket_done', 409)
			const selected = ticket.lines.filter(
				(line) =>
					(!command.stationId || line.stationId === command.stationId) &&
					(!command.lineId || line.id === command.lineId),
			)
			if (!command.stage) throw new KitchenError('invalid_request', 400)
			if (!selected.length) throw new KitchenError('line_not_found', 404)
			// Starting a later round leaves the dishes already made ready.
			const keepReady = command.stage === 'preparing' && !command.lineId
			for (const line of selected)
				if (!keepReady || line.stage !== 'ready') line.stage = command.stage
		} else if (command.action === 'done') {
			if (ticket.completedAt !== null)
				throw new KitchenError('ticket_done', 409)
			if (kdsTicketStage(ticket.lines) !== 'ready')
				throw new KitchenError('ticket_not_ready', 409)
		} else if (ticket.completedAt === null) {
			throw new KitchenError('ticket_not_done', 409)
		}
		// Clearing serves every dish. A recall takes back that clearing; a dish
		// made again is no longer the one that went out.
		const served: Record<string, number> = {}
		for (const line of ticket.lines) {
			// A tab's earlier round keeps the time it went out.
			const at =
				command.action === 'done'
					? (line.servedAt ?? now)
					: command.action === 'recall' && line.servedAt === ticket.completedAt
						? null
						: (line.servedAt ?? null)
			if (at && line.stage === 'ready') served[line.id] = at
		}
		current.progress.set(keyOf(order), {
			revision: (saved?.revision ?? 0) + 1,
			stages: Object.fromEntries(
				ticket.lines.map((line) => [line.id, line.stage]),
			),
			completedAt: command.action === 'done' ? now : null,
			served,
		})
		remember()
		return feed()
	}

	async function configure(
		expectedVersion: number,
		config: KdsConfig,
	): Promise<KdsFeed> {
		const current = kitchen()
		const parsed = kdsConfigSchema.safeParse(config)
		if (!parsed.success) throw new KitchenError('invalid_request', 400)
		if (current.configVersion !== expectedVersion)
			throw new KitchenError('stale_settings', 409)
		current.config = parsed.data
		current.configVersion += 1
		return feed()
	}

	return { feed, command, configure }
}

/** One per tab, so the demo keeps its progress while staff move between apps. */
export const demoKitchen = createDemoKitchen(Date.now, demoSales, tabMemory)
