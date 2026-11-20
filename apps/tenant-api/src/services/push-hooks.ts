import {
	buildBookingPush,
	buildOrderStatusPush,
	buildRewardPush,
	orderPushRef,
	type BookingPushKind,
} from '@repo/common/push'
import {
	customerPushDevices,
	getTenantDb,
	loyaltyBalances,
	loyaltyMembers,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { errorLogFields } from '../lib/error-log.ts'
import { activeRewardsInTx } from './loyalty-program-service.ts'
import { sendPushToCustomer } from './push-service.ts'

/**
 * The hooks that turn what already happens into a guest push (#105), each
 * after its own commit and none able to fail the work that triggered it:
 *
 *  - an order's status changes (`order-messages.ts` collects it with the order
 *    messages): accepted, ready (or out for delivery) and cancelled;
 *  - a booking message goes out (`rsv-message-service.ts`): the confirmation,
 *    the reminder (the same moment as the reminder text or email) and the
 *    waitlist "your table is ready";
 *  - points are earned (`loyalty-purchase-service.ts`): points earned, and a
 *    reward that has just come within reach.
 *
 * One push per event: each uses a reference that is the same however many
 * times its hook runs (the send log is unique per kind, reference and device).
 */

export type OrderPushIntent = {
	orderId: string
	customerId: string
	number: string
	status: string
	fulfillment: string
}

async function guarded(
	label: string,
	work: () => Promise<unknown>,
): Promise<void> {
	try {
		await work()
	} catch (error) {
		console.warn(`Guest push hook failed: ${label}`, errorLogFields(error))
	}
}

export async function deliverOrderPushes(
	orgId: string,
	intents: readonly OrderPushIntent[],
): Promise<void> {
	if (intents.length === 0) return
	const db = await getTenantDb(orgId)
	for (const intent of intents) {
		await guarded('order', () =>
			sendPushToCustomer(db, {
				orgId,
				customerId: intent.customerId,
				kind: 'order_status',
				ref: orderPushRef(intent.orderId, intent.status),
				category: 'orders',
				build: ({ locale, siteOrigin }) =>
					buildOrderStatusPush(
						{
							orderId: intent.orderId,
							number: intent.number,
							status: intent.status,
							fulfillment: intent.fulfillment,
						},
						{ locale, siteOrigin },
					),
			}),
		)
	}
}

export async function pushBooking(
	orgId: string,
	input: { customerId: string | null; kind: BookingPushKind; ref: string },
): Promise<void> {
	if (!input.customerId) return
	await guarded('booking', async () => {
		const db = await getTenantDb(orgId)
		await sendPushToCustomer(db, {
			orgId,
			customerId: input.customerId!,
			kind: 'booking',
			ref: input.ref,
			category: 'bookings',
			build: ({ locale, siteOrigin }) =>
				buildBookingPush({ kind: input.kind }, { locale, siteOrigin }),
		})
	})
}

/** After points are earned: points earned, and a reward that just came within reach. */
export async function pushLoyaltyEarned(
	orgId: string,
	input: { memberId: string; purchaseId: string; awardedPoints: number },
): Promise<void> {
	if (input.awardedPoints <= 0) return
	await guarded('loyalty', async () => {
		const db = await getTenantDb(orgId)
		const member = await db
			.select({ customerId: loyaltyMembers.customerId })
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.id, input.memberId))
			.get()
		if (!member?.customerId) return
		// Nothing to send to: skip the balance and reward reads.
		const device = await db
			.select({ id: customerPushDevices.id })
			.from(customerPushDevices)
			.where(eq(customerPushDevices.customerId, member.customerId))
			.limit(1)
			.get()
		if (!device) return
		const balance = await db
			.select({ points: loyaltyBalances.points })
			.from(loyaltyBalances)
			.where(eq(loyaltyBalances.memberId, input.memberId))
			.get()
		const rewards = await activeRewardsInTx(db)
		const cheapest = rewards[0]
		const cost = cheapest?.definition.pointsCost
		const after = balance?.points ?? 0
		const crossed =
			cheapest !== undefined &&
			cost !== undefined &&
			after >= cost &&
			after - input.awardedPoints < cost
		// One push: a reward within reach says more than the points do.
		await sendPushToCustomer(db, {
			orgId,
			customerId: member.customerId,
			kind: 'reward',
			ref: crossed
				? `reward:${input.memberId}:${cheapest!.rewardId}:${input.purchaseId}`
				: `earn:${input.purchaseId}`,
			category: 'rewards',
			build: ({ locale, siteOrigin }) =>
				buildRewardPush(
					{ kind: crossed ? 'reward_available' : 'points_earned' },
					{ locale, siteOrigin },
				),
		})
	})
}
