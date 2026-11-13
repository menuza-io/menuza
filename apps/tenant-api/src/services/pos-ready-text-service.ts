import { type RestaurantOrderContext } from '@repo/common/restaurant-orders'
import { sendSms } from '@repo/sms'
import {
	posOrders,
	runTenantTransaction,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, count, eq, gte, isNull } from 'drizzle-orm'
import { isValidPhone, normalizePhone } from '../lib/phone.ts'
import { smsRouteAvailable } from '../lib/sms-route.ts'
import { runExclusive } from '../lib/concurrency.ts'
import { fetchOrderContext } from './order-service.ts'

/**
 * "Text me when it's ready" for counter and phone orders taken on Station
 * (#250). When Kitchen marks a till order's whole ticket Ready, the guest gets
 * one text: "Your order #<number> at <restaurant> is ready for pickup." No
 * link, no marketing, no replies, and the number never becomes a customer,
 * a consent or an audience member.
 *
 * - One attempt per order, ever: the order row is claimed (`ready_text_status`)
 *   before anything is sent, so reopening and re-readying sends nothing, and
 *   two kitchen screens racing send one text.
 * - Sent only while the location's switch is on, on a node with an SMS route
 *   (US). A cancelled, voided or refunded order sends nothing; a ticket that
 *   already went out (done) never reaches here.
 * - A transactional daily cap per organization, separate from the sign-in
 *   code limiter: over it the ticket still moves on and the order records
 *   `limit` ("Text not sent (limit)").
 * - Logs carry ids and outcomes only, never the number or the text.
 */

/** Ready texts one organization may send in 24 hours. */
export const READY_TEXT_DAILY_LIMIT = 300
const DAY_MS = 24 * 60 * 60 * 1000

export type ReadyTextOutcome =
	| 'sent'
	| 'limit'
	| 'unavailable'
	| 'failed'
	/** Nothing to do: no number, already tried, switched off or not sellable. */
	| 'skipped'

type Deps = {
	send?: (input: { to: string; message: string }) => Promise<unknown>
	context?: (
		orgId: string,
		locationId: string,
	) => Promise<RestaurantOrderContext | null>
	now?: number
}

async function liveContext(orgId: string, locationId: string) {
	const result = await fetchOrderContext(orgId, locationId, null)
	return result.ok ? result.data : null
}

export function readyTextMessage(number: string, restaurant: string): string {
	const label = number.replace(/^#/, '')
	return `Your order #${label} at ${restaurant} is ready for pickup.`
}

export async function sendReadyTextIfDue(
	db: TenantDatabase,
	input: { orgId: string; orderId: string },
	deps: Deps = {},
): Promise<ReadyTextOutcome> {
	const now = deps.now ?? Date.now()
	const [order] = await db
		.select({
			number: posOrders.number,
			status: posOrders.status,
			orderSource: posOrders.orderSource,
			customerPhone: posOrders.customerPhone,
			readyTextPhone: posOrders.readyTextPhone,
			readyTextStatus: posOrders.readyTextStatus,
			locationId: posOrders.locationId,
		})
		.from(posOrders)
		.where(eq(posOrders.id, input.orderId))
		.limit(1)
	if (!order || order.readyTextStatus !== null) return 'skipped'
	if (order.status === 'void' || order.status === 'refunded') return 'skipped'
	const phone =
		order.orderSource === 'phone' ? order.customerPhone : order.readyTextPhone
	if (!phone) return 'skipped'

	const context = await (deps.context ?? liveContext)(
		input.orgId,
		order.locationId,
	)
	// Unknown policy (the App unreachable): leave it untried rather than guess.
	if (!context) return 'skipped'
	const location = context.menu.locations.find(
		(entry) => entry.id === order.locationId,
	)
	if (!location?.readyText) return 'skipped'
	const restaurant =
		(typeof context.menu.organization.name === 'string' &&
			context.menu.organization.name.trim()) ||
		location.name

	const to = normalizePhone(phone)
	const route = smsRouteAvailable()
	// Claim the one attempt, and count the day's texts, in one exclusive step.
	const claimed = await runExclusive(input.orgId, () =>
		runTenantTransaction(db, async (rawTx) => {
			const tx = rawTx as unknown as TenantDatabase
			let status: 'sent' | 'limit' | 'unavailable' | 'failed' = 'sent'
			if (!route) status = 'unavailable'
			else if (!isValidPhone(to)) status = 'failed'
			else {
				const [sent] = await tx
					.select({ value: count() })
					.from(posOrders)
					.where(
						and(
							eq(posOrders.readyTextStatus, 'sent'),
							gte(posOrders.readyTextAt, now - DAY_MS),
						),
					)
				if ((sent?.value ?? 0) >= READY_TEXT_DAILY_LIMIT) status = 'limit'
			}
			const rows = await tx
				.update(posOrders)
				.set({ readyTextStatus: status, readyTextAt: now })
				.where(
					and(
						eq(posOrders.id, input.orderId),
						isNull(posOrders.readyTextStatus),
					),
				)
				.returning({ id: posOrders.id })
			return rows.length > 0 ? status : null
		}),
	)
	if (claimed === null) return 'skipped'
	if (claimed !== 'sent') {
		console.warn('Ready text not sent', input.orderId, claimed)
		return claimed
	}
	try {
		await (deps.send ?? sendSms)({
			to,
			message: readyTextMessage(order.number, restaurant),
		})
		return 'sent'
	} catch (error) {
		await db
			.update(posOrders)
			.set({ readyTextStatus: 'failed' })
			.where(eq(posOrders.id, input.orderId))
		console.warn(
			'Ready text failed',
			input.orderId,
			error instanceof Error ? error.name : 'unknown',
		)
		return 'failed'
	}
}
