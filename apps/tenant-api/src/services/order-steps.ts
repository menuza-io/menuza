import {
	type OrderStep,
	type OrderStepActorKind,
	type OrderStepEvent,
	type OrderStepRow,
	type OrderStepSource,
	standingSteps,
	stepsForStatus,
} from '@repo/common/order-steps'
import {
	restaurantOrderSteps,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { asc, inArray, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'

type Writer = TenantDatabase | TenantTransaction

/**
 * Order steps (#243): when an online order was placed, accepted or declined,
 * started, ready, handed over or sent out, and delivered. Written inside the
 * existing status changes (`applyOrderStatusPatchInTx`, the kitchen screen's
 * stage write, placement and payment events), never from a second status
 * machine; the table is append-only (triggers in tenant migration 0068).
 *
 * A row holds the order id, the step, when, and who or which screen did it: an
 * opaque member, device or staff id, never a name, and no guest data.
 */

export type StepActor = {
	actorKind: OrderStepActorKind
	/** Opaque id: the member's user id, `staff:<id>`, or null. */
	actorId: string | null
	source: OrderStepSource
}

export type StepWrite = StepActor & {
	step: OrderStep
	event?: OrderStepEvent
	/** When it happened (epoch ms); the server's time when left out. */
	at?: number
	/** The step carries the till's time (a queued Station command). */
	offline?: boolean
}

/** Appends one step row. Never throws for the caller's sake: see `safeRecord`. */
export async function recordOrderStep(
	db: Writer,
	orderId: string,
	write: StepWrite,
	now = Date.now(),
): Promise<void> {
	await db.insert(restaurantOrderSteps).values({
		orderId,
		step: write.step,
		event: write.event ?? 'done',
		at: write.at ?? now,
		recordedAt: now,
		actorKind: write.actorKind,
		actorId: write.actorId,
		source: write.source,
		offline: write.offline ?? false,
	})
}

/** The steps a status change reaches, appended in order. */
export async function recordStatusSteps(
	db: Writer,
	order: { id: string; fulfillment: string },
	status: string,
	actor: StepActor,
	options: { now?: number; at?: number; offline?: boolean } = {},
): Promise<void> {
	const now = options.now ?? Date.now()
	for (const step of stepsForStatus(status, order.fulfillment)) {
		await recordOrderStep(
			db,
			order.id,
			{
				...actor,
				step,
				...(options.at !== undefined ? { at: options.at } : {}),
				...(options.offline ? { offline: true } : {}),
			},
			now,
		)
	}
}

/** The step rows of each order, in the order they were recorded. */
export async function loadOrderStepRows(
	db: Writer,
	orderIds: readonly string[],
): Promise<Map<string, OrderStepRow[]>> {
	const byOrder = new Map<string, OrderStepRow[]>()
	if (orderIds.length === 0) return byOrder
	const rows = await queryInChunks([...orderIds], (chunk) =>
		db
			.select({
				orderId: restaurantOrderSteps.orderId,
				step: restaurantOrderSteps.step,
				event: restaurantOrderSteps.event,
				at: restaurantOrderSteps.at,
				recordedAt: restaurantOrderSteps.recordedAt,
				actorKind: restaurantOrderSteps.actorKind,
				actorId: restaurantOrderSteps.actorId,
				source: restaurantOrderSteps.source,
				offline: restaurantOrderSteps.offline,
			})
			.from(restaurantOrderSteps)
			.where(inArray(restaurantOrderSteps.orderId, chunk))
			// Recording order: time, then the table's own row order.
			.orderBy(asc(restaurantOrderSteps.recordedAt), sql`rowid`),
	)
	rows.sort((a, b) => a.recordedAt - b.recordedAt)
	for (const row of rows) {
		const list = byOrder.get(row.orderId) ?? []
		list.push({
			step: row.step,
			event: row.event,
			at: row.at,
			recordedAt: row.recordedAt,
			actorKind: row.actorKind,
			actorId: row.actorId,
			source: row.source,
			offline: row.offline,
		})
		byOrder.set(row.orderId, list)
	}
	return byOrder
}

export async function loadOrderSteps(
	db: Writer,
	orderId: string,
): Promise<OrderStepRow[]> {
	return (await loadOrderStepRows(db, [orderId])).get(orderId) ?? []
}

/** Whether a step currently stands for an order (done and not taken back). */
export async function stepStands(
	db: Writer,
	orderId: string,
	step: OrderStep,
): Promise<boolean> {
	return standingSteps(await loadOrderSteps(db, orderId)).has(step)
}


/**
 * Brings the kitchen's steps in line with what its screen shows (#243): a
 * ticket in preparation has started, a ready one has started and is ready (and,
 * for a delivery order, on its way). A step the kitchen recorded that the
 * screen no longer supports (a dish set back after the ticket was ready) is
 * taken back with an `undone` row, and done again with a new `done` row when
 * the ticket moves on: both stay in the log and the latest counts. Steps other
 * screens recorded (the Orders page marked it ready) are never taken back here.
 */
export async function syncKitchenSteps(
	db: Writer,
	order: { id: string; fulfillment: string },
	stage: 'new' | 'preparing' | 'ready',
	actor: StepActor,
	options: { now?: number; at?: number; offline?: boolean } = {},
): Promise<void> {
	const now = options.now ?? Date.now()
	const standing = standingSteps(await loadOrderSteps(db, order.id))
	const delivery = order.fulfillment === 'delivery'
	const wanted = new Set<OrderStep>()
	if (stage === 'preparing' || stage === 'ready') wanted.add('started')
	if (stage === 'ready') {
		wanted.add('ready')
		if (delivery) wanted.add('out_for_delivery')
	}
	const kitchenSteps: OrderStep[] = ['started', 'ready', 'out_for_delivery']
	for (const step of kitchenSteps) {
		const stands = standing.get(step)
		if (wanted.has(step) && !stands) {
			await recordOrderStep(
				db,
				order.id,
				{
					...actor,
					step,
					...(options.at !== undefined ? { at: options.at } : {}),
					...(options.offline ? { offline: true } : {}),
				},
				now,
			)
		} else if (!wanted.has(step) && stands?.source === 'station_kitchen') {
			await recordOrderStep(
				db,
				order.id,
				{ ...actor, step, event: 'undone' },
				now,
			)
		}
	}
}
