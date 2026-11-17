import { createHash } from 'node:crypto'
import { and, asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { localDateAndTimeToUtc } from '@repo/common/location-availability'
import {
	DEFAULT_KDS_CONFIG,
	KDS_STATION_PIN,
	kdsConfigSchema,
	kdsCoverageGaps,
	kdsPinnedStations,
	kdsPrimaryStation,
	kdsStationsFor,
	kdsTicketStage,
	type KdsChannel,
	type KdsCommand,
	type KdsConfig,
	type KdsFeed,
	type KdsFulfillment,
	type KdsLine,
	type KdsSource,
	type KdsTicket,
} from '@repo/common/kds'
import { effectiveHighlight } from '@repo/common/kitchen-ticket'
import {
	kdsEvents,
	kdsLocationSettings,
	kdsTickets,
	posOrderRevisions,
	posOrders,
	restaurantOrders,
	runTenantTransaction,
	type TenantDatabase,
} from '@repo/tenant-db'
import { queryInChunks } from '../lib/chunked-in.ts'
import { runExclusive } from '../lib/concurrency.ts'
import { HttpError } from '../lib/http.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { payableOrderCondition } from './order-payable.ts'
import {
	orderMessageBatch,
	queueOrderStatusMessages,
	type OrderMessageTx,
} from './order-messages.ts'
import { applyPromisedDelay } from './order-promised-time.ts'

const hash = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex')
const DAY = 86_400_000
const LIMIT = 500
const highlightSchema = z
	.enum(['none', 'allergy', 'attention', 'long_prep'])
	.optional()
const optionSchema = z.object({
	optionName: z.string(),
	name: z.string().optional(),
	quantity: z.number().optional(),
	half: z.enum(['whole', 'left', 'right']).nullable().optional(),
	groupName: z.string().optional(),
	kitchenName: z.string().optional(),
	kitchenHighlight: highlightSchema,
	highlight: highlightSchema,
})
const sourceLineSchema = z.object({
	id: z.string().optional(),
	itemId: z.string(),
	name: z.string().optional(),
	itemName: z.string().optional(),
	kitchenName: z.string().optional(),
	kitchenHighlight: highlightSchema,
	variantLabel: z.string().nullable().optional(),
	/** The variant's value names ("Large"), on lines priced by the website. */
	variantNames: z.array(z.string()).optional(),
	variantId: z.string().nullable().optional(),
	quantity: z.number().int().positive(),
	instructions: z.string().nullable().optional(),
	options: z.array(optionSchema).default([]),
	/** When the till sent it (contract 4): its round on a tab, by the till's clock. */
	sentAt: z.string().optional(),
	courseId: z.string().optional(),
	courseName: z.string().optional(),
	coursePosition: z.number().int().optional(),
	courseHeld: z.boolean().optional(),
	held: z.boolean().optional(),
	courseFiredAt: z.string().optional(),
})

type KitchenDb = TenantDatabase
type StoredTicket = typeof kdsTickets.$inferSelect
type SourceLine = z.infer<typeof sourceLineSchema>
/**
 * A ticket's stored progress: each dish's stage under its id, and, under
 * `served:<id>`, when a dish left the pass (the ticket was cleared while it was
 * ready). Kept until the dish is made again, so a tab that orders more still
 * shows what already went out.
 */
type Progress = StoredTicket['progress']
const SERVED = 'served:'
const STAGES = new Set(['new', 'preparing', 'ready'])
const stageIn = (progress: Progress, id: string) => {
	const value = progress[id]
	return typeof value === 'string' && STAGES.has(value)
		? (value as KdsLine['stage'])
		: undefined
}
const servedIn = (progress: Progress, id: string) => {
	const value = progress[SERVED + id]
	return typeof value === 'number' ? value : undefined
}

/** A dish's id follows its content (never its price), so a changed dish is new work. */
function lineContent(line: SourceLine, index: number) {
	const content = {
		key: line.id ?? String(index),
		itemId: line.itemId,
		name: line.name ?? line.itemName ?? '',
		// A web order has no label, only the names; an id means nothing to a cook.
		variant:
			line.variantLabel ??
			(line.variantNames?.length ? line.variantNames.join(' · ') : null) ??
			line.variantId ??
			null,
		quantity: line.quantity,
		instructions: line.instructions ?? '',
		options: line.options,
	}
	return { content, id: hash(content) }
}
type SourceOrder = {
	id: string
	source: KdsSource
	number: string
	channel: KdsTicket['channel']
	fulfillment: KdsTicket['fulfillment']
	/** Routing order type. Drive-through stays `takeaway` on `fulfillment`. */
	routeFulfillment: KdsFulfillment
	/** Routing channel. QR table rounds stay `online` on `channel`. */
	routeChannel: KdsChannel
	tableLabel: string | null
	paid?: boolean
	driveThrough?: boolean
	driveThroughNote?: string | null
	service?: 'qr'
	createdAt: number
	dueAt: number | null
	/** When the source last changed: the latest dishes arrived by then. */
	updatedAt: number
	initialStage: KdsLine['stage']
	cancelled: boolean
	lines: unknown
	/**
	 * Online orders with a promised time only (left out otherwise, so other
	 * tickets keep their fingerprints). A push-back changes the fingerprint.
	 */
	promised?: { at: number; until: number | null; version: number }
	utensilsRequested?: boolean | null
	largeOrderExtraMinutes?: number
}

async function settings(db: KitchenDb, locationId: string) {
	const [row] = await db
		.select()
		.from(kdsLocationSettings)
		.where(eq(kdsLocationSettings.locationId, locationId))
		.limit(1)
	return {
		config: row
			? kdsConfigSchema.parse(row.config)
			: structuredClone(DEFAULT_KDS_CONFIG),
		version: row?.version ?? 0,
	}
}

/** Fingerprints ignore money and guest details, but include every preparation instruction.
 * A changed or added line is new work; unchanged dishes keep their progress.
 * Each dish says when it was sent (`firstSeen`: the first revision that held
 * it), so a tab's later round shows as one, not as food waiting since the tab
 * opened. Without that history, a dish the kitchen had not seen when it last
 * worked the ticket counts from when the order last changed.
 */
function project(
	order: SourceOrder,
	saved: StoredTicket | null,
	config: KdsConfig,
	configVersion: number,
	firstSeen?: ReadonlyMap<string, number>,
): KdsTicket {
	// One unreadable order (an old or damaged row) shows no dishes; it never
	// takes the whole kitchen's feed down. Its id is logged, never its contents.
	const parsed = z.array(sourceLineSchema).safeParse(order.lines)
	if (!parsed.success)
		console.error('Kitchen could not read an order', order.source, order.id)
	const sourceLines = parsed.success ? parsed.data : []
	const courses =
		order.fulfillment === 'dine_in' && !order.driveThrough && order.service !== 'qr'
	const lines: KdsLine[] = sourceLines.map((line, index) => {
		const { content, id } = lineContent(line, index)
		const stage =
			(saved && stageIn(saved.progress, id)) ??
			(saved ? 'new' : order.initialStage)
		const routed = kdsStationsFor(config, {
			itemId: line.itemId,
			fulfillment: order.routeFulfillment,
			channel: order.routeChannel,
		})
		const pinned =
			stage !== 'new' && saved ? kdsPinnedStations(saved.progress, id) : null
		const stationIds = pinned ?? routed
		const stationId = kdsPrimaryStation(config, stationIds)
		const received =
			firstSeen?.get(id) ??
			(saved && stageIn(saved.progress, id) === undefined
				? Math.max(order.updatedAt, saved.updatedAt)
				: undefined)
		// The till's own time for the round (rounds saved offline stay apart), but
		// never later than the server had it: a fast till clock is not the future.
		const sentAt = line.sentAt ? Date.parse(line.sentAt) : Number.NaN
		const courseFired = line.courseFiredAt
			? Date.parse(line.courseFiredAt)
			: Number.NaN
		const held = courses && (line.courseHeld === true || line.held === true)
		const started = Number.isFinite(courseFired)
			? courseFired
			: Number.isFinite(sentAt)
				? sentAt
				: undefined
		const firedAt = held
			? undefined
			: started !== undefined
				? Math.min(started, received ?? order.updatedAt)
				: received
		const servedAt =
			saved && stage === 'ready' ? servedIn(saved.progress, id) : undefined
		const guestName = content.name
		const highlight = effectiveHighlight(line.kitchenHighlight, guestName)
		return {
			id,
			...(firedAt !== undefined ? { firedAt } : {}),
			...(servedAt !== undefined ? { servedAt } : {}),
			itemId: line.itemId,
			name: guestName,
			...(line.kitchenName ? { kitchenName: line.kitchenName } : {}),
			...(highlight ? { highlight } : {}),
			variant: line.variantLabel ?? null,
			variantId: line.variantId ?? null,
			quantity: line.quantity,
			instructions: content.instructions,
			options: line.options.map((option) => {
				const optionGuest = option.optionName || option.name || ''
				const optionHighlight = effectiveHighlight(
					option.kitchenHighlight ?? option.highlight,
					optionGuest,
				)
				return {
					name: optionGuest,
					...(option.kitchenName ? { kitchenName: option.kitchenName } : {}),
					...(option.groupName ? { groupName: option.groupName } : {}),
					...(optionHighlight ? { highlight: optionHighlight } : {}),
					quantity: option.quantity ?? 1,
					half: option.half ?? null,
				}
			}),
			stationId,
			...(stationIds.length > 1 ? { stationIds } : {}),
			stage,
			...(courses && line.courseId
				? {
						courseId: line.courseId,
						...(line.courseName ? { courseName: line.courseName } : {}),
						...(line.coursePosition != null
							? { coursePosition: line.coursePosition }
							: {}),
						held,
					}
				: {}),
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
		// A bill paid or renumbered is not new cooking, but invalidates a stale screen.
		version: hash([order, configVersion, saved?.version ?? 0]),
		completedAt: complete ? (saved?.completedAt ?? null) : null,
		cancelled: order.cancelled,
		lines,
		...(order.promised
			? {
					promisedAt: order.promised.at,
					promisedUntil: order.promised.until,
					promisedVersion: order.promised.version,
				}
			: {}),
		...(order.utensilsRequested !== undefined
			? { utensilsRequested: order.utensilsRequested }
			: {}),
		...(order.largeOrderExtraMinutes
			? { largeOrderExtraMinutes: order.largeOrderExtraMinutes }
			: {}),
		...(order.driveThrough ? { driveThrough: true } : {}),
		...(order.driveThroughNote
			? { driveThroughNote: order.driveThroughNote }
			: {}),
		...(order.paid !== undefined ? { paid: order.paid } : {}),
		...(order.service ? { service: order.service } : {}),
	}
}

async function loadSource(
	db: KitchenDb,
	orgId: string,
	locationId: string,
	source: KdsSource,
	orderId: string,
): Promise<SourceOrder> {
	if (source === 'pos') {
		const [row] = await db
			.select()
			.from(posOrders)
			.where(
				and(
					eq(posOrders.id, orderId),
					eq(posOrders.locationId, locationId),
					inArray(posOrders.status, ['open', 'paid']),
				),
			)
			.limit(1)
		if (row) return posSource(row)
	} else {
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.id, orderId),
					eq(restaurantOrders.orgId, orgId),
					eq(restaurantOrders.locationId, locationId),
					inArray(restaurantOrders.status, ['accepted', 'preparing', 'ready']),
					payableOrderCondition(),
				),
			)
			.limit(1)
		if (row) return onlineSource(row)
	}
	throw new HttpError(404, 'ticket_not_found')
}

function posSource(row: typeof posOrders.$inferSelect): SourceOrder {
	return {
		id: row.id,
		source: 'pos',
		number: row.number,
		channel: row.orderSource,
		fulfillment: row.orderType === 'drive_through' ? 'takeaway' : row.orderType,
		routeFulfillment:
			row.orderType === 'drive_through' ? 'drive_through' : row.orderType,
		routeChannel: row.orderSource,
		tableLabel: row.tableLabel,
		paid: row.status === 'paid' || row.status === 'refunded',
		driveThrough: row.orderType === 'drive_through',
		driveThroughNote: row.driveThroughNote,
		createdAt: row.rungUpAt,
		dueAt: row.pickupAt,
		updatedAt: row.updatedAt,
		lines: row.lines,
		initialStage: 'new',
		cancelled: row.status === 'void' || row.status === 'refunded',
	}
}
function onlineSource(row: typeof restaurantOrders.$inferSelect): SourceOrder {
	return {
		id: row.id,
		source: 'online',
		number: row.number,
		channel: 'online',
		// A QR table round is cooked for the table it came from. It stays
		// channel `online` on the wire; routing reads `service: 'qr'`.
		fulfillment:
			row.fulfillment === 'delivery'
				? 'delivery'
				: row.fulfillment === 'dine_in'
					? 'dine_in'
					: 'takeaway',
		routeFulfillment:
			row.fulfillment === 'delivery'
				? 'delivery'
				: row.fulfillment === 'dine_in'
					? 'dine_in'
					: 'takeaway',
		routeChannel: row.source === 'qr_table' ? 'qr' : 'online',
		service: row.source === 'qr_table' ? 'qr' : undefined,
		tableLabel: row.fulfillment === 'dine_in' ? (row.tableLabel ?? null) : null,
		paid: row.paymentStatus === 'paid' || row.paymentStatus === 'not_required',
		createdAt: row.createdAt?.getTime() ?? 0,
		updatedAt: row.updatedAt?.getTime() ?? row.createdAt?.getTime() ?? 0,
		dueAt:
			row.scheduledFor?.getTime() ??
			(row.pickupDate && row.pickupTime && row.pickupTimezone
				? localDateAndTimeToUtc(
						row.pickupDate,
						row.pickupTime,
						row.pickupTimezone,
					).getTime()
				: null),
		lines: row.lines,
		initialStage:
			row.status === 'ready'
				? 'ready'
				: row.status === 'preparing'
					? 'preparing'
					: 'new',
		cancelled: row.status === 'cancelled',
		...(row.promisedAt
			? {
					promised: {
						at: row.promisedAt.getTime(),
						until: row.promisedUntil?.getTime() ?? null,
						version: row.promisedVersion,
					},
				}
			: {}),
		utensilsRequested: row.utensilsRequested ?? null,
		largeOrderExtraMinutes: row.largeOrderExtraMinutes ?? 0,
	}
}

/**
 * When each dish of these orders was first sent: the time the server received
 * the first revision that held it (by the same content id the kitchen uses).
 */
async function dishesFirstSeen(db: KitchenDb, orderIds: string[]) {
	const seen = new Map<string, Map<string, number>>()
	if (!orderIds.length) return seen
	const revisions = await queryInChunks(orderIds, (chunk) =>
		db
			.select({
				orderId: posOrderRevisions.orderId,
				snapshot: posOrderRevisions.snapshot,
				receivedAt: posOrderRevisions.receivedAt,
			})
			.from(posOrderRevisions)
			.where(inArray(posOrderRevisions.orderId, chunk))
			.orderBy(asc(posOrderRevisions.revision)),
	)
	for (const revision of revisions) {
		const lines = z
			.array(sourceLineSchema)
			.safeParse((revision.snapshot as { lines?: unknown } | null)?.lines)
		if (!lines.success) continue
		const dishes = seen.get(revision.orderId) ?? new Map<string, number>()
		seen.set(revision.orderId, dishes)
		lines.data.forEach((line, index) => {
			const { id } = lineContent(line, index)
			if (!dishes.has(id)) dishes.set(id, revision.receivedAt)
		})
	}
	return seen
}

export async function kitchenFeed(
	db: KitchenDb,
	orgId: string,
	locationId: string,
	now = Date.now(),
): Promise<KdsFeed> {
	const { config, version } = await settings(db, locationId)
	// Old paid sales are not a new kitchen backlog. Open tabs and future pickups
	// remain visible. Completed kitchen tickets are available for recall for 4h.
	const recent = now - DAY
	const [pos, online] = await Promise.all([
		db
			.select({ order: posOrders, saved: kdsTickets })
			.from(posOrders)
			.leftJoin(
				kdsTickets,
				and(eq(kdsTickets.source, 'pos'), eq(kdsTickets.orderId, posOrders.id)),
			)
			.where(
				and(
					eq(posOrders.locationId, locationId),
					or(
						inArray(posOrders.status, ['open', 'paid']),
						and(
							inArray(posOrders.status, ['void', 'refunded']),
							or(
								gte(posOrders.voidedAt, now - 30 * 60_000),
								gte(posOrders.refundedAt, now - 30 * 60_000),
							),
						),
					),
					or(
						eq(posOrders.status, 'open'),
						gte(posOrders.rungUpAt, recent),
						gte(posOrders.receivedAt, recent),
						gte(posOrders.pickupAt, recent),
						and(
							sql`${kdsTickets.orderId} is not null`,
							isNull(kdsTickets.completedAt),
						),
					),
					or(
						isNull(kdsTickets.completedAt),
						gte(kdsTickets.completedAt, now - 4 * 3_600_000),
						sql`${posOrders.updatedAt} > ${kdsTickets.updatedAt}`,
					),
				),
			)
			.orderBy(
				sql`case when ${kdsTickets.completedAt} is null then 0 when ${posOrders.updatedAt} > ${kdsTickets.updatedAt} then 1 else 2 end`,
				asc(posOrders.rungUpAt),
			)
			.limit(LIMIT + 1),
		db
			.select({ order: restaurantOrders, saved: kdsTickets })
			.from(restaurantOrders)
			.leftJoin(
				kdsTickets,
				and(
					eq(kdsTickets.source, 'online'),
					eq(kdsTickets.orderId, restaurantOrders.id),
				),
			)
			.where(
				and(
					eq(restaurantOrders.orgId, orgId),
					eq(restaurantOrders.locationId, locationId),
					// Never `pending_acceptance` (#107): a waiting order is not a
					// ticket until a person accepts it.
					or(
						inArray(restaurantOrders.status, [
							'accepted',
							'preparing',
							'ready',
						]),
						and(
							eq(restaurantOrders.status, 'cancelled'),
							gte(restaurantOrders.cancelledAt, new Date(now - 30 * 60_000)),
							// One turned down (or cancelled by the guest) while it waited
							// never reached the kitchen: no cancelled ticket either.
							sql`not (${restaurantOrders.acceptanceDeadlineAt} is not null and ${restaurantOrders.acceptedAt} is null)`,
						),
					),
					payableOrderCondition(),
					or(
						isNull(kdsTickets.completedAt),
						gte(kdsTickets.completedAt, now - 4 * 3_600_000),
					),
				),
			)
			.orderBy(
				sql`case when ${kdsTickets.completedAt} is null then 0 else 1 end`,
				asc(restaurantOrders.createdAt),
			)
			.limit(LIMIT + 1),
	])
	// Tabs the kitchen already worked that changed since: when each dish was sent.
	const firstSeen = await dishesFirstSeen(
		db,
		pos
			.slice(0, LIMIT)
			.filter(
				({ order, saved }) =>
					order.revision > 1 &&
					(order.status === 'open' ||
						(saved !== null &&
							(saved.completedAt === null ||
								order.updatedAt > saved.updatedAt))),
			)
			.map(({ order }) => order.id),
	)
	const tickets = [
		...pos
			.slice(0, LIMIT)
			.map(({ order, saved }) =>
				project(
					posSource(order),
					saved,
					config,
					version,
					firstSeen.get(order.id),
				),
			),
		...online
			.slice(0, LIMIT)
			.map(({ order, saved }) =>
				project(onlineSource(order), saved, config, version),
			),
	].filter(
		(ticket) =>
			ticket.lines.length > 0 &&
			(ticket.completedAt === null ||
				ticket.completedAt >= now - 4 * 3_600_000 ||
				ticket.cancelled),
	)
	return {
		config,
		configVersion: version,
		tickets,
		serverNow: now,
		truncated: pos.length > LIMIT || online.length > LIMIT,
	}
}

type Actor = {
	orgId: string
	locationId: string
	deviceId: string
	staffId: string | null
}

/** The same org lock as online ordering, plus a real SQLite/DO transaction.
 * Version fingerprints cover source contents AND progress. A lost response
 * cannot advance a ticket twice, and a stale tab never hides a new dish.
 */
export async function kitchenCommand(
	db: KitchenDb,
	actor: Actor,
	command: KdsCommand,
) {
	const messages = orderMessageBatch()
	const result = await kitchenCommandInTx(db, actor, command, messages)
	// An online order the kitchen made Ready tells its guest (#79), after commit.
	messages.deliver(actor.orgId)
	return result
}

function kitchenCommandInTx(
	db: KitchenDb,
	actor: Actor,
	command: KdsCommand,
	messages: ReturnType<typeof orderMessageBatch>,
) {
	return runExclusive(actor.orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (rawTx) => {
				const tx = rawTx as unknown as KitchenDb
				if (command.action === 'delay') {
					await delayTicket(tx, actor, command, messages)
					return { tillBecameReady: false }
				}
				const { config, version } = await settings(tx, actor.locationId)
				const source = await loadSource(
					tx,
					actor.orgId,
					actor.locationId,
					command.source,
					command.orderId,
				)
				const [saved] = await tx
					.select()
					.from(kdsTickets)
					.where(
						and(
							eq(kdsTickets.source, command.source),
							eq(kdsTickets.orderId, command.orderId),
						),
					)
					.limit(1)
				const ticket = project(source, saved ?? null, config, version)
				if (ticket.version !== command.expectedVersion)
					throw new HttpError(409, 'stale_ticket')
				const wasReady = kdsTicketStage(ticket.lines) === 'ready'
				if (command.action === 'stage') {
					if (ticket.completedAt !== null)
						throw new HttpError(409, 'ticket_done')
					const selected = ticket.lines.filter(
						(line) =>
							(!command.stationId || line.stationId === command.stationId) &&
							(!command.lineId || line.id === command.lineId),
					)
					if (!selected.length) throw new HttpError(404, 'line_not_found')
					// Starting a later round leaves the dishes already made ready.
					const keepReady = command.stage === 'preparing' && !command.lineId
					for (const line of selected)
						if (!keepReady || line.stage !== 'ready')
							line.stage = command.stage!
				} else if (command.action === 'done') {
					if (ticket.completedAt !== null)
						throw new HttpError(409, 'ticket_done')
					if (kdsTicketStage(ticket.lines) !== 'ready')
						throw new HttpError(409, 'ticket_not_ready')
				} else if (ticket.completedAt === null) {
					throw new HttpError(409, 'ticket_not_done')
				}
				const now = Date.now()
				const completedAt = command.action === 'done' ? now : null
				// Clearing serves every dish. A recall takes back that clearing; a dish
				// made again is no longer the one that went out.
				const progress: Progress = {}
				for (const line of ticket.lines) {
					progress[line.id] = line.stage
					// A started dish keeps the stations it had when it left New.
					if (line.stage !== 'new') {
						const existing =
							saved && kdsPinnedStations(saved.progress, line.id)
						const ids = existing ?? line.stationIds ?? [line.stationId]
						progress[KDS_STATION_PIN + line.id] = ids.join(',')
					}
					// A tab's earlier round keeps the time it went out.
					const served =
						command.action === 'done'
							? (line.servedAt ?? now)
							: command.action === 'recall' &&
								  line.servedAt === ticket.completedAt
								? undefined
								: (line.servedAt ?? undefined)
					if (served !== undefined && line.stage === 'ready')
						progress[SERVED + line.id] = served
				}
				await tx
					.insert(kdsTickets)
					.values({
						source: command.source,
						orderId: command.orderId,
						locationId: actor.locationId,
						version: (saved?.version ?? 0) + 1,
						progress,
						completedAt,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: [kdsTickets.source, kdsTickets.orderId],
						set: {
							version: (saved?.version ?? 0) + 1,
							progress,
							completedAt,
							updatedAt: now,
						},
					})
				// Kitchen readiness reaches the customer's receipt, forward only. Done
				// means off the pass, NOT collected/delivered and never marked paid.
				if (command.source === 'online' && command.action === 'stage') {
					const stage = kdsTicketStage(ticket.lines)
					if (stage !== 'new') {
						const moved = await tx
							.update(restaurantOrders)
							.set({ status: stage, updatedAt: new Date(now) })
							.where(
								and(
									eq(restaurantOrders.id, command.orderId),
									eq(restaurantOrders.orgId, actor.orgId),
									eq(restaurantOrders.locationId, actor.locationId),
									// bounded: one or two literal statuses
									inArray(
										restaurantOrders.status,
										stage === 'ready'
											? ['accepted', 'preparing']
											: ['accepted'],
									),
								),
							)
							.returning()
						for (const order of moved)
							await queueOrderStatusMessages(
								tx as unknown as OrderMessageTx,
								order,
								null,
								stage,
								messages.context(now),
							)
					}
				}
				await tx.insert(kdsEvents).values({
					locationId: actor.locationId,
					deviceId: actor.deviceId,
					staffId: actor.staffId,
					source: command.source,
					orderId: command.orderId,
					action:
						command.action === 'stage'
							? `stage:${command.stage}`
							: command.action,
					at: now,
				})
				// Whether this command made a till order's whole ticket Ready (it
				// was not before): its one ready text goes out after this commits.
				return {
					tillBecameReady:
						command.source === 'pos' &&
						command.action === 'stage' &&
						!wasReady &&
						kdsTicketStage(ticket.lines) === 'ready',
				}
			}),
		),
	)
}

/**
 * Pushes an online ticket's promised time back. Guarded by the promised
 * version the screen saw, not the ticket fingerprint: a dish moving on another
 * screen does not block it, and a replay after it applied is `stale_version`,
 * so a lost response never pushes the time twice. Same rules and code as the
 * Orders page (`applyPromisedDelay`).
 */
async function delayTicket(
	tx: KitchenDb,
	actor: Actor,
	command: KdsCommand,
	messages: ReturnType<typeof orderMessageBatch>,
) {
	// A walk-in ticket was never promised a time.
	if (command.source !== 'online') throw new HttpError(409, 'no_promised_time')
	const [order] = await tx
		.select()
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.id, command.orderId),
				eq(restaurantOrders.orgId, actor.orgId),
				eq(restaurantOrders.locationId, actor.locationId),
				payableOrderCondition(),
			),
		)
		.limit(1)
	if (!order) throw new HttpError(404, 'ticket_not_found')
	const now = Date.now()
	const delayed = await applyPromisedDelay(
		tx as unknown as OrderMessageTx,
		order,
		{
			minutes: command.minutes!,
			expectedVersion: command.expectedPromisedVersion!,
		},
		new Date(now),
		messages.context(now),
	)
	if (!delayed.ok) throw new HttpError(delayed.status, delayed.code)
	await tx.insert(kdsEvents).values({
		locationId: actor.locationId,
		deviceId: actor.deviceId,
		staffId: actor.staffId,
		source: command.source,
		orderId: command.orderId,
		action: `delay:${command.minutes}`,
		at: now,
	})
}

export async function configureKitchen(
	db: KitchenDb,
	actor: Actor,
	expectedVersion: number,
	config: KdsConfig,
) {
	return runExclusive(actor.orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (rawTx) => {
				const tx = rawTx as unknown as KitchenDb
				const current = await settings(tx, actor.locationId)
				if (current.version !== expectedVersion)
					throw new HttpError(409, 'stale_settings')
				if (kdsCoverageGaps(config).length)
					throw new HttpError(422, 'kitchen_uncovered')
				const now = Date.now()
				await tx
					.insert(kdsLocationSettings)
					.values({
						locationId: actor.locationId,
						config,
						version: current.version + 1,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: kdsLocationSettings.locationId,
						set: { config, version: current.version + 1, updatedAt: now },
					})
				await tx.insert(kdsEvents).values({
					locationId: actor.locationId,
					deviceId: actor.deviceId,
					staffId: actor.staffId,
					action: 'settings',
					at: now,
				})
			}),
		),
	)
}
