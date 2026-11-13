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

/** A location's ready-text policy as the App last said it (no guest data). */
type Policy = { readyText: boolean; restaurant: string; at: number }
const POLICY_FRESH_MS = 60_000
/** While the App cannot be reached, the last answer this old still decides. */
const POLICY_STALE_MS = 6 * 60 * 60_000
const policies = new Map<string, Policy>()

export function resetReadyTextPolicyCache(): void {
	policies.clear()
}

async function policyFor(
	orgId: string,
	locationId: string,
	now: number,
	context: NonNullable<Deps['context']>,
): Promise<Policy | null> {
	const key = `${orgId}:${locationId}`
	const known = policies.get(key)
	if (known && now - known.at < POLICY_FRESH_MS) return known
	const live = await context(orgId, locationId).catch(() => null)
	if (live) {
		const location = live.menu.locations.find(
			(entry) => entry.id === locationId,
		)
		const policy = {
			readyText: location?.readyText === true,
			restaurant:
				(typeof live.menu.organization.name === 'string' &&
					live.menu.organization.name.trim()) ||
				location?.name ||
				'',
			at: now,
		}
		if (policies.size > 500) policies.clear()
		policies.set(key, policy)
		return policy
	}
	return known && now - known.at < POLICY_STALE_MS ? known : null
}

/** The name as it goes in the text: short, and in plain SMS characters where it can be. */
export function smsRestaurantName(name: string): string {
	const plain = name
		.replace(/[\u2018\u2019\u201B\u2032]/g, "'")
		.replace(/[\u201C\u201D\u2033]/g, '"')
		.replace(/[\u2013\u2014]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
	const chars = [...plain]
	return chars.length > 30 ? `${chars.slice(0, 29).join('').trimEnd()}…` : plain
}

export function readyTextMessage(number: string, restaurant: string): string {
	const label = number.replace(/^#/, '')
	return `Your order #${label} at ${smsRestaurantName(restaurant)} is ready for pickup.`
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
			readyTextPhone: posOrders.readyTextPhone,
			readyTextStatus: posOrders.readyTextStatus,
			locationId: posOrders.locationId,
		})
		.from(posOrders)
		.where(eq(posOrders.id, input.orderId))
		.limit(1)
	if (!order || order.readyTextStatus !== null) return 'skipped'
	if (order.status === 'void' || order.status === 'refunded') return 'skipped'
	// Counter orders carry the number typed for this text; phone orders carry
	// their callback number only when the guest agreed at the till.
	const phone = order.readyTextPhone
	if (!phone) return 'skipped'

	const policy = await policyFor(
		input.orgId,
		order.locationId,
		now,
		deps.context ?? liveContext,
	)
	if (policy && !policy.readyText) return 'skipped'
	const restaurant = policy?.restaurant ?? ''

	const to = normalizePhone(phone)
	const route = smsRouteAvailable()
	// Claim the one attempt, and count the day's texts, in one exclusive step.
	const claimed = await runExclusive(input.orgId, () =>
		runTenantTransaction(db, async (rawTx) => {
			const tx = rawTx as unknown as TenantDatabase
			let status: 'sent' | 'limit' | 'unavailable' | 'failed' = 'sent'
			if (!route) status = 'unavailable'
			// Whether the location texts guests cannot be known (the App has been
			// unreachable for hours): recorded, so it shows, rather than dropped.
			else if (!policy || !restaurant) status = 'failed'
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
				// The number was for this one attempt: it goes as the attempt is
				// recorded (the send below uses its own copy).
				.set({
					readyTextStatus: status,
					readyTextAt: now,
					readyTextPhone: null,
				})
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
