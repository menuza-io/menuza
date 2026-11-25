import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'

import {
	eventDayBeforeAlertAtMs,
	nextBalanceReminder,
	readCateringPolicy,
} from '@repo/common/catering'
import {
	cateringQuotes,
	getTenantDb,
	restaurantOrders,
	type RestaurantOrder,
	type TenantDatabase,
} from '@repo/tenant-db'

import { errorLogFields } from '../lib/error-log.ts'
import { postCateringAlert, sendBalanceMessage } from './catering-messages.ts'
import { cateringBalanceOwedCents } from './catering-orders.ts'
import { fetchOrderContext } from './order-service.ts'

/**
 * The catering part of the orders tick (hourly cron fan-out, the Durable
 * Object alarm, the Node interval; no extra cron slot): the reminders before a
 * balance is due and when it is overdue (#361), the restaurant's alert the day
 * before each catering event (#124) and expiring quotes nobody paid. Each send
 * is claimed with a compare-and-set on its own column, so a racing tick or a
 * replay never sends twice, and a send that failed is released for the next
 * pass. Ids and counts only leave the region; the guest's address is read only
 * to send. Returns when the next thing falls due, so the alarm wakes then.
 */

export type CateringTickResult = {
	reminders: number
	overdue: number
	eventAlerts: number
	quotesExpired: number
	nextDueAt: number | null
}

const BATCH = 200

async function reminderDaysFor(
	orgId: string,
): Promise<(locationId: string) => number> {
	const fetched = await fetchOrderContext(orgId, null, null).catch(() => null)
	return (locationId) => {
		if (!fetched?.ok) return 2
		const policy = readCateringPolicy(fetched.data.catering, locationId)
		return policy?.settings.deposit.reminderDaysBeforeDue ?? 2
	}
}

export async function runCateringTickForOrg(
	orgId: string,
	options: { now?: number; db?: TenantDatabase } = {},
): Promise<CateringTickResult> {
	const now = options.now ?? Date.now()
	const db = options.db ?? (await getTenantDb(orgId))
	const result: CateringTickResult = {
		reminders: 0,
		overdue: 0,
		eventAlerts: 0,
		quotesExpired: 0,
		nextDueAt: null,
	}
	const upcoming: number[] = []

	// Quotes nobody paid in time.
	const expired = await db
		.update(cateringQuotes)
		.set({ status: 'expired', updatedAt: now })
		.where(
			and(
				eq(cateringQuotes.status, 'sent'),
				lte(cateringQuotes.expiresAt, now),
			),
		)
		.returning({ id: cateringQuotes.id })
	result.quotesExpired = expired.length

	const live = and(
		eq(restaurantOrders.isCatering, true),
		eq(restaurantOrders.paymentStatus, 'paid'),
		sql`${restaurantOrders.status} not in ('cancelled', 'expired')`,
	)

	// Balance reminders.
	const balanceOrders = await db
		.select()
		.from(restaurantOrders)
		.where(and(live, eq(restaurantOrders.balanceState, 'due')))
		.limit(BATCH)
	if (balanceOrders.length > 0) {
		const reminderDays = await reminderDaysFor(orgId)
		for (const order of balanceOrders) {
			if (cateringBalanceOwedCents(order) <= 0 || !order.balanceDueAt) continue
			const timeZone = order.locationTimezone ?? 'UTC'
			const verdict = nextBalanceReminder(
				{
					balanceDueAtMs: order.balanceDueAt.getTime(),
					balanceCents: cateringBalanceOwedCents(order),
					balanceState: 'due',
					beforeDueSentAtMs: order.balanceBeforeDueSentAt?.getTime() ?? null,
					overdueSentAtMs: order.balanceOverdueSentAt?.getTime() ?? null,
					eventAtMs: order.cateringEventAt?.getTime() ?? 0,
				},
				{
					now,
					timeZone,
					reminderDaysBeforeDue: reminderDays(order.locationId),
				},
			)
			if (verdict.nextAtMs !== null) upcoming.push(verdict.nextAtMs)
			if (!verdict.due) continue
			const column =
				verdict.due === 'before_due'
					? 'balanceBeforeDueSentAt'
					: 'balanceOverdueSentAt'
			const claimed = await db
				.update(restaurantOrders)
				.set({ [column]: new Date(now) })
				.where(
					and(
						eq(restaurantOrders.id, order.id),
						eq(restaurantOrders.balanceVersion, order.balanceVersion),
						eq(restaurantOrders.balanceState, 'due'),
						isNull(restaurantOrders[column]),
					),
				)
				.returning()
			const row: RestaurantOrder | undefined = claimed[0]
			if (!row) continue
			const sent = await sendBalanceMessage(
				orgId,
				row,
				verdict.due === 'before_due' ? 'balance_reminder' : 'balance_overdue',
			).catch((error: unknown) => {
				console.error(
					'Catering balance reminder failed',
					orgId,
					order.id,
					errorLogFields(error),
				)
				return false
			})
			if (!sent) {
				// Nothing could be sent (no address, switch off): try again next pass.
				await db
					.update(restaurantOrders)
					.set({ [column]: null })
					.where(eq(restaurantOrders.id, order.id))
				continue
			}
			if (verdict.due === 'before_due') {
				result.reminders += 1
			} else {
				result.overdue += 1
				// The team is told once that a balance is overdue (ids only).
				void postCateringAlert(orgId, 'balance_overdue', order)
			}
		}
	}

	// The restaurant's reminder the day before each event.
	const eventOrders = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(
				live,
				isNull(restaurantOrders.eventAlertSentAt),
				gt(restaurantOrders.cateringEventAt, new Date(now)),
				inArray(restaurantOrders.fulfillment, ['pickup', 'delivery']),
			),
		)
		.limit(BATCH)
	for (const order of eventOrders) {
		const eventAt = order.cateringEventAt
		if (!eventAt) continue
		const alertAt = eventDayBeforeAlertAtMs(
			eventAt,
			order.locationTimezone ?? 'UTC',
		)
		if (alertAt > now) {
			upcoming.push(alertAt)
			continue
		}
		const claimed = await db
			.update(restaurantOrders)
			.set({ eventAlertSentAt: new Date(now) })
			.where(
				and(
					eq(restaurantOrders.id, order.id),
					isNull(restaurantOrders.eventAlertSentAt),
				),
			)
			.returning({ id: restaurantOrders.id })
		if (claimed.length === 0) continue
		const outcome = await postCateringAlert(orgId, 'event_tomorrow', order)
		if (outcome === 'retry') {
			await db
				.update(restaurantOrders)
				.set({ eventAlertSentAt: null })
				.where(eq(restaurantOrders.id, order.id))
			upcoming.push(now + 15 * 60_000)
			continue
		}
		result.eventAlerts += 1
	}

	result.nextDueAt = upcoming.length > 0 ? Math.min(...upcoming) : null
	return result
}
