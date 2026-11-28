import { z } from 'zod'
import { promisedDelayMinutesSchema } from './promised-time.ts'

/** Kitchen-only contract. No contacts, prices, payment credentials or staff names. */
const id = z.string().min(1).max(100)
export const kdsStageSchema = z.enum(['new', 'preparing', 'ready'])
export type KdsStage = z.infer<typeof kdsStageSchema>
export const kdsSourceSchema = z.enum(['pos', 'online'])
export type KdsSource = z.infer<typeof kdsSourceSchema>

/**
 * Order types a station can accept. `drive_through` is a till order type
 * (#404). Omitted on a station means every type, so a config saved before
 * this field existed still takes every order.
 */
export const KDS_FULFILLMENTS = [
	'dine_in',
	'takeaway',
	'delivery',
	'drive_through',
] as const
export type KdsFulfillment = (typeof KDS_FULFILLMENTS)[number]

/**
 * Where an order came from. QR table rounds stay `channel: 'online'` on the
 * wire (an older kitchen screen rejects a new channel value and would hide
 * the whole feed). Routing treats `service: 'qr'` as this `qr` row.
 * Omitted on a station means every channel.
 */
export const KDS_CHANNELS = ['counter', 'phone', 'online', 'qr'] as const
export type KdsChannel = (typeof KDS_CHANNELS)[number]

/** Fixed kitchen emphasis. Operators choose which applies; the meaning is not a colour. */
export const KITCHEN_HIGHLIGHTS = [
	'none',
	'allergy',
	'attention',
	'long_prep',
] as const
export type KitchenHighlight = (typeof KITCHEN_HIGHLIGHTS)[number]
export const kitchenHighlightSchema = z.enum(KITCHEN_HIGHLIGHTS)

const stationFulfillments = z.array(z.enum(KDS_FULFILLMENTS)).max(4).optional()
const stationChannels = z.array(z.enum(KDS_CHANNELS)).max(4).optional()

export const kdsConfigSchema = z
	.strictObject({
		stations: z
			.array(
				z.strictObject({
					id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
					name: z.string().trim().min(1).max(60),
					itemIds: z.array(id).max(1000),
					/** Omitted: every order type. An empty list accepts none. */
					fulfillments: stationFulfillments,
					/** Omitted: every channel. An empty list accepts none. */
					channels: stationChannels,
					/** The whole ticket, not only dishes routed by item. */
					allItems: z.boolean().optional(),
				}),
			)
			.min(1)
			.max(12),
		defaultStationId: id,
		workflow: z.enum(['ticket', 'item']),
		showPreparing: z.boolean(),
		warningMinutes: z.number().int().min(1).max(180),
		lateMinutes: z.number().int().min(2).max(240),
		fireAheadMinutes: z.number().int().min(0).max(240),
		/** Paid or unpaid on the ticket. Omitted means off. */
		showPaymentStatus: z.boolean().optional(),
		/** Header colour by order type. The words stay either way. Omitted means off. */
		showOrderTypeColor: z.boolean().optional(),
		/** Modifier group name beside each option. Omitted means off. */
		showModifierGroups: z.boolean().optional(),
	})
	.superRefine((config, ctx) => {
		const ids = config.stations.map((station) => station.id)
		if (
			new Set(ids).size !== ids.length ||
			!ids.includes(config.defaultStationId)
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Choose unique stations and a default station.',
			})
		const items = config.stations.flatMap((station) => station.itemIds)
		if (new Set(items).size !== items.length)
			ctx.addIssue({
				code: 'custom',
				message: 'Route each item to one station only.',
			})
		if (config.lateMinutes <= config.warningMinutes)
			ctx.addIssue({
				code: 'custom',
				message: 'The late threshold must follow the warning threshold.',
			})
	})
export type KdsConfig = z.infer<typeof kdsConfigSchema>
export const DEFAULT_KDS_CONFIG: KdsConfig = {
	stations: [{ id: 'kitchen', name: 'Kitchen', itemIds: [] }],
	defaultStationId: 'kitchen',
	workflow: 'ticket',
	showPreparing: true,
	warningMinutes: 10,
	lateMinutes: 20,
	fireAheadMinutes: 30,
}

export const kdsConfigRequestSchema = z.strictObject({
	expectedVersion: z.number().int().nonnegative(),
	config: kdsConfigSchema,
})
/**
 * A kitchen command. `delay` pushes an online ticket's promised time back by
 * `minutes` (5, 10 or 15) and names the `promisedVersion` it saw in
 * `expectedPromisedVersion`; that version, not the ticket fingerprint, guards
 * it (a replay after it applied is 409 `stale_version`, so it never pushes
 * twice). Walk-in tickets have no promised time (409 `no_promised_time`).
 */
export const kdsCommandSchema = z
	.strictObject({
		source: kdsSourceSchema,
		orderId: id,
		expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
		action: z.enum(['stage', 'done', 'recall', 'delay']),
		stationId: id.nullable().default(null),
		lineId: id.nullable().default(null),
		stage: kdsStageSchema.optional(),
		minutes: promisedDelayMinutesSchema.optional(),
		expectedPromisedVersion: z.number().int().nonnegative().optional(),
		/**
		 * When the person tapped, for a command that sat in a queue (#243): the
		 * region records the step at that time and marks it offline, when it is a
		 * believable one. Omitted: the server's time.
		 */
		clientAt: z.string().datetime().optional(),
	})
	.superRefine((command, ctx) => {
		if (command.action === 'stage' && !command.stage)
			ctx.addIssue({ code: 'custom', message: 'Choose a preparation stage.' })
		if (
			command.action !== 'stage' &&
			(command.lineId || command.stationId || command.stage)
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Done and recall apply to the entire ticket.',
			})
		if (
			command.action === 'delay' &&
			(command.minutes === undefined ||
				command.expectedPromisedVersion === undefined)
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Choose how many minutes to add.',
			})
		if (
			command.action !== 'delay' &&
			(command.minutes !== undefined ||
				command.expectedPromisedVersion !== undefined)
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Only a delay adds minutes.',
			})
	})
export type KdsCommand = z.infer<typeof kdsCommandSchema>

export const kdsLineSchema = z.object({
	id,
	itemId: id,
	name: z.string(),
	quantity: z.number().int().positive(),
	variant: z.string().nullable(),
	variantId: z.string().nullable(),
	options: z.array(
		z.object({
			name: z.string(),
			quantity: z.number().int().positive(),
			half: z.enum(['whole', 'left', 'right']).nullable(),
			/** Guest-facing option name when `name` is the kitchen name. */
			guestName: z.string().optional(),
			/** Localized kitchen name (menu JSON map) or a plain string. */
			kitchenName: z.string().max(500).optional(),
			groupName: z.string().max(200).optional(),
			highlight: kitchenHighlightSchema.optional(),
		}),
	),
	instructions: z.string(),
	stationId: id,
	/** Every station that should show this dish. Omitted: just `stationId`. */
	stationIds: z.array(id).max(12).optional(),
	stage: kdsStageSchema,
	/** Localized kitchen name. The screen resolves it; `name` stays the guest name. */
	kitchenName: z.string().max(500).optional(),
	highlight: kitchenHighlightSchema.optional(),
	/** Set on dine-in courses. A held line is on the ticket and is not late. */
	courseId: z.string().max(40).optional(),
	courseName: z.string().max(60).optional(),
	coursePosition: z.number().int().nonnegative().optional(),
	held: z.boolean().optional(),
	/**
	 * When the till sent this dish (its round). Optional: a feed that does not
	 * know it leaves it out, and the kitchen then tells added dishes by their stage.
	 */
	firedAt: z.number().nullable().optional(),
	/**
	 * When the dish left the pass: the ticket was cleared while it was ready.
	 * Shown on a tab that ordered more since, so the kitchen sees what went out.
	 */
	servedAt: z.number().nullable().optional(),
})
export type KdsLine = z.infer<typeof kdsLineSchema>
export const kdsTicketSchema = z.object({
	id,
	source: kdsSourceSchema,
	number: z.string(),
	channel: z.enum(['counter', 'phone', 'online']),
	fulfillment: z.enum(['dine_in', 'takeaway', 'delivery']),
	tableLabel: z.string().nullable(),
	createdAt: z.number(),
	dueAt: z.number().nullable(),
	version: z.string(),
	completedAt: z.number().nullable(),
	cancelled: z.boolean(),
	lines: z.array(kdsLineSchema),
	/**
	 * Online tickets with a promised time only (absent otherwise): when the
	 * guest was told it is ready (pickup) or starts arriving (delivery), the
	 * end of a delivery range, and the version a `delay` command names.
	 */
	promisedAt: z.number().nullable().optional(),
	promisedUntil: z.number().nullable().optional(),
	promisedVersion: z.number().int().nonnegative().optional(),
	/** Guest utensils answer (#257). */
	utensilsRequested: z.boolean().nullable().optional(),
	/** Extra prep minutes snapshot (#355). */
	largeOrderExtraMinutes: z.number().int().nonnegative().optional(),
	/** Over the location's large-order alert threshold at placement (#300). */
	largeOrder: z.boolean().optional(),
	/**
	 * Till drive-through (#404). `fulfillment` stays `takeaway` so an older
	 * kitchen screen, which rejects an unknown fulfillment, still shows the
	 * ticket. The badge reads this flag.
	 */
	driveThrough: z.boolean().optional(),
	/** Lane or vehicle note. Not a guest name. */
	driveThroughNote: z.string().max(80).nullable().optional(),
	/** Whether the bill is paid. Shown only when the kitchen turns the switch on. */
	paid: z.boolean().optional(),
	/**
	 * QR table rounds. The ticket's `channel` stays `online` (what the feed
	 * reported before this field). Routing uses `qr` when this is set.
	 */
	service: z.enum(['qr']).optional(),
	/**
	 * The guest ticked "someone in my party has an allergy" at checkout (#294).
	 * Highlights the whole ticket header. Left out unless set.
	 */
	guestAllergy: z.boolean().optional(),
	/** The order has alcohol: the ticket says "Check ID" (#167). Left out unless set. */
	checkId: z.boolean().optional(),
	/**
	 * A free test order (#119): the kitchen screen badges it TEST and asks "Did
	 * the ticket print?". Left out unless set, so other tickets keep their
	 * fingerprints.
	 */
	isTest: z.boolean().optional(),
	/** The answer to that question, once given: `yes` or `no`. */
	testPrintAnswer: z.enum(['yes', 'no']).nullable().optional(),
})
export type KdsTicket = z.infer<typeof kdsTicketSchema>
export const kdsFeedSchema = z.object({
	config: kdsConfigSchema,
	configVersion: z.number().int(),
	tickets: z.array(kdsTicketSchema),
	serverNow: z.number(),
	truncated: z.boolean(),
})
export type KdsFeed = z.infer<typeof kdsFeedSchema>

export function kdsStationFor(config: KdsConfig, itemId: string): string {
	return (
		config.stations.find((station) => station.itemIds.includes(itemId))?.id ??
		config.defaultStationId
	)
}

export function kdsTicketStage(
	lines: readonly Pick<KdsLine, 'stage'>[],
): KdsStage {
	if (lines.length && lines.every((line) => line.stage === 'ready'))
		return 'ready'
	if (lines.some((line) => line.stage !== 'new')) return 'preparing'
	return 'new'
}

/** Scheduled food starts aging when it is released, not when it was ordered. */
export function kdsFireAt(
	ticket: Pick<KdsTicket, 'createdAt' | 'dueAt'>,
	config: KdsConfig,
): number {
	return Math.max(
		ticket.createdAt,
		(ticket.dueAt ?? ticket.createdAt) - config.fireAheadMinutes * 60_000,
	)
}

export type KdsRouteLine = {
	itemId: string
	fulfillment: KdsFulfillment
	channel: KdsChannel
}

type RouteStation = {
	id: string
	itemIds: readonly string[]
	fulfillments?: readonly KdsFulfillment[]
	channels?: readonly KdsChannel[]
	allItems?: boolean
}

function listed<T extends string>(
	selected: readonly T[] | undefined,
	value: T,
): boolean {
	if (!selected) return true
	return selected.includes(value)
}

function stationAccepts(station: RouteStation, line: KdsRouteLine): boolean {
	return (
		listed(station.fulfillments, line.fulfillment) &&
		listed(station.channels, line.channel)
	)
}

/**
 * Stations that should show this dish. An item station matches when the dish
 * is routed to it and the order type and channel are ticked. An all-dishes
 * station matches the whole ticket for its order types. The default station
 * takes a dish no other station lists. If nothing matches, the default still
 * receives it so an order cannot vanish.
 */
export function kdsStationsFor(
	config: {
		stations: readonly RouteStation[]
		defaultStationId: string
	},
	line: KdsRouteLine,
): string[] {
	const claimed = config.stations.some(
		(station) => !station.allItems && station.itemIds.includes(line.itemId),
	)
	const matches = config.stations.filter((station) => {
		if (!stationAccepts(station, line)) return false
		if (station.allItems) return true
		if (station.itemIds.includes(line.itemId)) return true
		return station.id === config.defaultStationId && !claimed
	})
	if (matches.length === 0) return [config.defaultStationId]
	return matches.map((station) => station.id)
}

/** The prep station an older screen filters on: not an all-dishes extra. */
export function kdsPrimaryStation(
	config: { stations: readonly RouteStation[]; defaultStationId: string },
	stationIds: readonly string[],
): string {
	const prep = stationIds.find((stationId) => {
		const station = config.stations.find((entry) => entry.id === stationId)
		return station && !station.allItems
	})
	return prep ?? stationIds[0] ?? config.defaultStationId
}

/** Order type and channel pairs no station has ticked. */
export function kdsCoverageGaps(config: {
	stations: readonly RouteStation[]
}): Array<{ fulfillment: KdsFulfillment; channel: KdsChannel }> {
	const gaps: Array<{ fulfillment: KdsFulfillment; channel: KdsChannel }> = []
	for (const fulfillment of KDS_FULFILLMENTS) {
		for (const channel of KDS_CHANNELS) {
			const covered = config.stations.some((station) =>
				stationAccepts(station, { itemId: '', fulfillment, channel }),
			)
			if (!covered) gaps.push({ fulfillment, channel })
		}
	}
	return gaps
}

export function lineOnStation(
	line: { stationId: string; stationIds?: readonly string[] },
	stationId: string | null,
): boolean {
	if (!stationId) return true
	return (line.stationIds ?? [line.stationId]).includes(stationId)
}
