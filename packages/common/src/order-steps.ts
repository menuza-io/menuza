/**
 * The steps an online order goes through (#243), recorded as append-only rows
 * (`restaurant_order_steps` in the region) inside the existing status changes.
 * A step row holds an order id, the step, when, and who or which screen did
 * it: never a guest name, phone, address or note. Pure: no I/O.
 *
 * One status machine stays the only one (`order-service.ts` and the kitchen
 * screen); this only remembers when each status was reached. Times are the
 * server's when the step is recorded; a Station step taken offline carries the
 * till's time and is marked `offline`. A step taken back and done again keeps
 * both rows; the latest one counts.
 */

export const ORDER_STEP_VALUES = [
	'placed',
	'accepted',
	'declined',
	'started',
	'ready',
	'handed_over',
	'out_for_delivery',
	'delivered',
] as const
export type OrderStep = (typeof ORDER_STEP_VALUES)[number]

/** `done`: the step was reached. `undone`: it was taken back (a recalled ticket). */
export const ORDER_STEP_EVENT_VALUES = ['done', 'undone'] as const
export type OrderStepEvent = (typeof ORDER_STEP_EVENT_VALUES)[number]

export const ORDER_STEP_ACTOR_KIND_VALUES = [
	'guest',
	'operator',
	'station',
	'system',
] as const
export type OrderStepActorKind = (typeof ORDER_STEP_ACTOR_KIND_VALUES)[number]

/** Which screen or process recorded the step. */
export const ORDER_STEP_SOURCE_VALUES = [
	'app',
	'station_orders',
	'station_kitchen',
	'guest',
	'payment',
	'system',
] as const
export type OrderStepSource = (typeof ORDER_STEP_SOURCE_VALUES)[number]

export type OrderStepRow = {
	step: OrderStep
	event: OrderStepEvent
	/** When the step happened (the till's time for an offline Station step). */
	at: number
	/** When the server recorded it. */
	recordedAt: number
	actorKind: OrderStepActorKind
	/** An opaque member, device or staff id; never a name. */
	actorId: string | null
	source: OrderStepSource
	offline: boolean
}

export type StandingStep = Omit<OrderStepRow, 'event' | 'step'>

/**
 * The steps that stand now: for each step the latest `done` row, unless a
 * later `undone` row took it back. `rows` are in recording order (oldest
 * first); a redone step replaces the earlier row, which stays in the log.
 */
export function standingSteps(
	rows: readonly OrderStepRow[],
): Map<OrderStep, StandingStep> {
	const standing = new Map<OrderStep, StandingStep>()
	for (const row of rows) {
		if (row.event === 'undone') {
			standing.delete(row.step)
			continue
		}
		const { step: ignoredStep, event: ignoredEvent, ...rest } = row
		standing.set(row.step, rest)
	}
	return standing
}

export const ORDER_STEP_LABELS: Record<OrderStep, string> = {
	placed: 'Placed',
	accepted: 'Accepted',
	declined: 'Declined',
	started: 'Started',
	ready: 'Ready',
	handed_over: 'Handed over',
	out_for_delivery: 'Out for delivery',
	delivered: 'Delivered',
}

export const ORDER_STEP_SOURCE_LABELS: Record<OrderStepSource, string> = {
	app: 'Orders page',
	station_orders: 'Station online orders',
	station_kitchen: 'Station kitchen screen',
	guest: 'The guest',
	payment: 'Payment confirmation',
	system: 'Menuza (automatic)',
}

/**
 * The step a status change reaches, by fulfilment. An order has no separate
 * "out for delivery" status: a delivery order that turns `ready` is on its
 * way (the guest's message says so) and one that turns `completed` was
 * delivered, while pickup and dine-in orders are handed over.
 */
export function stepsForStatus(
	status: string,
	fulfillment: string,
): OrderStep[] {
	const delivery = fulfillment === 'delivery'
	switch (status) {
		case 'accepted':
			return ['accepted']
		case 'preparing':
			return ['started']
		case 'ready':
			return delivery ? ['ready', 'out_for_delivery'] : ['ready']
		case 'completed':
			return [delivery ? 'delivered' : 'handed_over']
		default:
			return []
	}
}

/** The timeline's order: each step's place, so a late-recorded row sorts right. */
const STEP_ORDER: Record<OrderStep, number> = {
	placed: 0,
	accepted: 1,
	declined: 1,
	started: 2,
	ready: 3,
	out_for_delivery: 4,
	handed_over: 4,
	delivered: 5,
}

export type OrderTimelineEntry = {
	step: OrderStep
	at: number
	actorKind: OrderStepActorKind
	actorId: string | null
	source: OrderStepSource
	offline: boolean
	/** Minutes after the order was placed, null when it has no placed step. */
	minutesSincePlaced: number | null
}

/** What order detail shows: the standing steps, in order. */
export function orderTimeline(
	rows: readonly OrderStepRow[],
): OrderTimelineEntry[] {
	const standing = standingSteps(rows)
	const placed = standing.get('placed')?.at ?? null
	return [...standing.entries()]
		.map(([step, value]) => ({
			step,
			at: value.at,
			actorKind: value.actorKind,
			actorId: value.actorId,
			source: value.source,
			offline: value.offline,
			minutesSincePlaced:
				placed === null ? null : Math.max(0, Math.round((value.at - placed) / 60_000)),
		}))
		.sort((a, b) => a.at - b.at || STEP_ORDER[a.step] - STEP_ORDER[b.step])
}

export type OrderTimings = {
	placedAt: number | null
	/** Minutes from placed to accepted, only for an order a person accepted. */
	minutesToAccept: number | null
	minutesToStart: number | null
	minutesToReady: number | null
	/** Minutes ready came after the promised time (negative: early). */
	minutesLate: number | null
	/** 1 when ready after the promised time, 0 when on time, null when not measurable. */
	late: 0 | 1 | null
}

function minutesBetween(from: number | undefined, to: number | undefined) {
	if (from === undefined || to === undefined) return null
	return Math.max(0, (to - from) / 60_000)
}

/** The measures of one order for the reports (#243). */
export function orderTimings(
	rows: readonly OrderStepRow[],
	promisedAtMs: number | null,
): OrderTimings {
	const standing = standingSteps(rows)
	const placed = standing.get('placed')?.at
	const accepted = standing.get('accepted')
	const ready = standing.get('ready')?.at
	const lateMinutes =
		ready !== undefined && promisedAtMs !== null
			? (ready - promisedAtMs) / 60_000
			: null
	return {
		placedAt: placed ?? null,
		minutesToAccept:
			accepted && accepted.actorKind !== 'system'
				? minutesBetween(placed, accepted.at)
				: null,
		minutesToStart: minutesBetween(placed, standing.get('started')?.at),
		minutesToReady: minutesBetween(placed, ready),
		minutesLate: lateMinutes,
		late: lateMinutes === null ? null : lateMinutes > 0 ? 1 : 0,
	}
}
