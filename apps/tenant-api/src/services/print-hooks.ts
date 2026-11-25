import { and, gte, inArray, isNotNull, lte } from 'drizzle-orm'
import {
	getTenantDb,
	restaurantOrders,
	type RestaurantOrder,
	type TenantDatabase,
} from '@repo/tenant-db'
import { kdsFireAt } from '@repo/common/kds'
import { runInBackground } from '../lib/background.ts'
import { printingEnabled } from '../lib/print-switches.ts'
import { loadKitchenConfig } from './kds-service.ts'
import { locationHasPrinter, queueOrderPrint } from './print-service.ts'

/**
 * The hooks that queue cloud print jobs (#117). They run after the order's own
 * transaction has committed, from the same places that feed the Kitchen and the
 * guest messages, and never throw into them. The unique key on a job makes a
 * hook that runs twice queue once.
 */

type PrintableOrder = Pick<
	RestaurantOrder,
	| 'id'
	| 'locationId'
	| 'status'
	| 'paymentMethod'
	| 'paymentStatus'
	| 'scheduledFor'
	| 'createdAt'
>

/** An online order the kitchen works on: accepted and paid, free, or paid at handoff. */
export function isPrintableOnlineOrder(order: PrintableOrder): boolean {
	const stands =
		order.paymentMethod === 'handoff' ||
		order.paymentStatus === 'paid' ||
		order.paymentStatus === 'not_required'
	return stands && ['accepted', 'preparing', 'ready'].includes(order.status)
}

/**
 * Queues the kitchen ticket and the receipt for an online order that was just
 * accepted. A scheduled order waits for its fire time (the orders tick queues it
 * then), so a ticket for tomorrow's lunch does not print tonight.
 */
export async function printAcceptedOrder(
	db: TenantDatabase,
	orgId: string,
	order: PrintableOrder,
	now = Date.now(),
): Promise<void> {
	if (!isPrintableOnlineOrder(order)) return
	if (!(await locationHasPrinter(db, order.locationId))) return
	if (order.scheduledFor) {
		const config = await loadKitchenConfig(db, order.locationId)
		const dueAt = order.scheduledFor.getTime()
		const fireAt = kdsFireAt(
			{ createdAt: order.createdAt?.getTime() ?? now, dueAt },
			config,
		)
		if (fireAt > now) return
	}
	for (const kind of ['kitchen', 'receipt'] as const) {
		await queueOrderPrint(db, {
			orgId,
			locationId: order.locationId,
			source: 'online',
			orderId: order.id,
			trigger: { kind, dedupeKey: 'accepted' },
			now,
		})
	}
}

/** Collects orders accepted inside a write and queues their jobs after it commits. */
export function printQueue() {
	const orders = new Map<string, PrintableOrder>()
	return {
		add(order: PrintableOrder) {
			orders.set(order.id, order)
		},
		settle(orgId: string): void {
			if (orders.size === 0) return
			const pending = [...orders.values()]
			orders.clear()
			runInBackground(
				(async () => {
					if (!(await printingEnabled(orgId))) return
					const db = await getTenantDb(orgId)
					for (const order of pending) {
						await printAcceptedOrder(db, orgId, order).catch((error) =>
							console.error(
								'Printing an accepted order failed',
								error instanceof Error ? error.name : 'unknown',
							),
						)
					}
				})(),
			)
		},
	}
}

/**
 * The orders tick: scheduled orders whose fire time has come (their kitchen
 * ticket was held back at acceptance), and when the next one is due so the
 * Durable Object alarm (or the Node interval) wakes for it. Cheap when nobody
 * has a printer.
 */
export async function printDueScheduledOrders(
	db: TenantDatabase,
	orgId: string,
	now = Date.now(),
): Promise<{ printed: number; nextDueAt: number | null }> {
	if (!(await printingEnabled(orgId))) return { printed: 0, nextDueAt: null }
	const rows = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(
				isNotNull(restaurantOrders.scheduledFor),
				inArray(restaurantOrders.status, ['accepted', 'preparing']),
				// Nothing older than a day matters; look a day ahead for the next one.
				gte(restaurantOrders.scheduledFor, new Date(now - 24 * 60 * 60_000)),
				lte(restaurantOrders.scheduledFor, new Date(now + 24 * 60 * 60_000)),
			),
		)
		.limit(200)
	let printed = 0
	let nextDueAt: number | null = null
	const printerAt = new Map<string, boolean>()
	for (const order of rows) {
		if (!isPrintableOnlineOrder(order)) continue
		let hasPrinter = printerAt.get(order.locationId)
		if (hasPrinter === undefined) {
			hasPrinter = await locationHasPrinter(db, order.locationId)
			printerAt.set(order.locationId, hasPrinter)
		}
		if (!hasPrinter) continue
		const config = await loadKitchenConfig(db, order.locationId)
		const fireAt = kdsFireAt(
			{
				createdAt: order.createdAt?.getTime() ?? now,
				dueAt: order.scheduledFor!.getTime(),
			},
			config,
		)
		if (fireAt > now) {
			nextDueAt = nextDueAt === null ? fireAt : Math.min(nextDueAt, fireAt)
			continue
		}
		await printAcceptedOrder(db, orgId, order, now)
		printed++
	}
	return { printed, nextDueAt }
}

/**
 * A Station sale: a kitchen ticket when a round was sent (and for a sale paid
 * at once), a receipt when it is paid. Fire and forget after the upload.
 */
export function printTillSale(
	orgId: string,
	sale: {
		id: string
		locationId: string
		status: string
		lines: ReadonlyArray<{ sentAt?: string }>
	},
): void {
	runInBackground(
		(async () => {
			if (!(await printingEnabled(orgId))) return
			const db = await getTenantDb(orgId)
			if (!(await locationHasPrinter(db, sale.locationId))) return
			if (sale.status === 'void' || sale.status === 'refunded') return
			const sent = sale.lines
				.map((line) => (line.sentAt ? Date.parse(line.sentAt) : Number.NaN))
				.filter((at) => Number.isFinite(at))
			const round = sent.length ? Math.max(...sent) : null
			if (round !== null || sale.status === 'paid') {
				await queueOrderPrint(db, {
					orgId,
					locationId: sale.locationId,
					source: 'pos',
					orderId: sale.id,
					trigger: {
						kind: 'kitchen',
						dedupeKey: round !== null ? `sent:${round}` : 'paid',
					},
				})
			}
			if (sale.status === 'paid') {
				await queueOrderPrint(db, {
					orgId,
					locationId: sale.locationId,
					source: 'pos',
					orderId: sale.id,
					trigger: { kind: 'receipt', dedupeKey: 'paid' },
				})
			}
		})().catch((error) =>
			console.error(
				'Printing a till sale failed',
				error instanceof Error ? error.name : 'unknown',
			),
		),
	)
}
