import {
	TEST_ORDER_AUTO_COMPLETE_MS,
	TEST_ORDER_DAILY_LIMIT,
	TEST_ORDER_NONCE_RETENTION_MS,
	type TestPrintAnswer,
} from '@repo/common/test-orders'
import { readGuestOrderingFeatures } from '@repo/common/guest-ordering'
import {
	restaurantOrders,
	restaurantOrderSteps,
	runTenantTransaction,
	testOrderNonces,
	type RestaurantOrder,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, gte, inArray, lt, min, sql } from 'drizzle-orm'

import { errorLogFields } from '../lib/error-log.ts'
import { HttpError } from '../lib/http.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { mintTestOrderCode, newTestOrderNonce } from '../lib/test-order-code.ts'
import {
	applyOrderStatusPatchInTx,
	fetchOrderContext,
	orderWriteQueues,
	runExclusive,
	settleOrderWriteQueues,
} from './order-service.ts'

/**
 * Free test orders (#119): minting a code, spending its nonce, recording
 * "Did the ticket print?", and the regional tick that finishes an open test
 * order after two hours and forgets nonces after a day. A test order runs the
 * real guest and kitchen path and is otherwise inert (see `placeOrder`).
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Mints one code for one location, if the organization may and the day's limit allows. */
export async function mintTestOrderCodeForOrg(
	orgId: string,
	db: TenantDatabase,
	input: { locationId: string; now?: number },
): Promise<{ code: string; expiresAt: number }> {
	const now = input.now ?? Date.now()
	const context = await fetchOrderContext(orgId, input.locationId, null)
	if (!context.ok) {
		throw new HttpError(
			context.failure.status,
			context.failure.code,
			context.failure.message,
		)
	}
	if (
		!readGuestOrderingFeatures(
			(context.data as { guestOrdering?: unknown }).guestOrdering,
		).testOrders
	) {
		throw new HttpError(
			403,
			'test_orders_disabled',
			'Test orders are not turned on.',
		)
	}
	if (!context.data.menu.locations.some((l) => l.id === input.locationId)) {
		throw new HttpError(404, 'location_not_found', 'Location not found.')
	}
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [{ count } = { count: 0 }] = await tx
					.select({ count: sql<number>`count(*)` })
					.from(testOrderNonces)
					.where(
						and(
							eq(testOrderNonces.locationId, input.locationId),
							gte(testOrderNonces.mintedAt, now - DAY_MS),
						),
					)
				if (Number(count) >= TEST_ORDER_DAILY_LIMIT) {
					throw new HttpError(
						429,
						'test_order_limit',
						'You have placed the most test orders allowed for today at this location.',
						{ limit: TEST_ORDER_DAILY_LIMIT },
					)
				}
				const nonce = newTestOrderNonce()
				await tx
					.insert(testOrderNonces)
					.values({ nonce, locationId: input.locationId, mintedAt: now })
				return mintTestOrderCode({
					orgId,
					locationId: input.locationId,
					nonce,
					now,
				})
			}),
		),
	)
}

/** `POST …/test-print`: the answer to "Did the ticket print?", recorded once per answer change. */
export async function recordTestPrintAnswer(
	orgId: string,
	db: TenantDatabase,
	orderId: string,
	answer: TestPrintAnswer,
	options: { locationIds?: readonly string[] | null; now?: number } = {},
): Promise<
	| { ok: true; order: RestaurantOrder }
	| { ok: false; status: 404 | 409; code: string; message: string }
> {
	const now = options.now ?? Date.now()
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [order] = await tx
					.select()
					.from(restaurantOrders)
					.where(
						and(
							eq(restaurantOrders.id, orderId),
							eq(restaurantOrders.orgId, orgId),
						),
					)
					.limit(1)
				if (
					!order ||
					(options.locationIds != null &&
						!options.locationIds.includes(order.locationId))
				) {
					return {
						ok: false as const,
						status: 404 as const,
						code: 'order_not_found',
						message: 'Order not found.',
					}
				}
				if (!order.isTest) {
					return {
						ok: false as const,
						status: 409 as const,
						code: 'not_a_test_order',
						message: 'Only a test order has this question.',
					}
				}
				const [updated] = await tx
					.update(restaurantOrders)
					.set({
						testPrintAnswer: answer,
						testPrintAnsweredAt: now,
						updatedAt: new Date(now),
					})
					.where(eq(restaurantOrders.id, orderId))
					.returning()
				return { ok: true as const, order: updated! }
			}),
		),
	)
}

/**
 * Whether a location's launch step "Place a test order" is done (#83, #119): a
 * test order whose ticket the operator confirmed printed, or one a person moved
 * through the kitchen (it reached a kitchen screen: a status step by a person,
 * not by the tick).
 */
export async function testOrderDoneAt(
	db: TenantDatabase,
	locationId?: string,
): Promise<number | null> {
	const scope = locationId
		? eq(restaurantOrders.locationId, locationId)
		: undefined
	const [confirmed] = await db
		.select({ at: min(restaurantOrders.testPrintAnsweredAt) })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.isTest, true),
				eq(restaurantOrders.testPrintAnswer, 'yes'),
				scope,
			),
		)
	if (confirmed?.at) return Number(confirmed.at)
	const [moved] = await db
		.select({ at: min(restaurantOrderSteps.at) })
		.from(restaurantOrderSteps)
		.innerJoin(
			restaurantOrders,
			eq(restaurantOrders.id, restaurantOrderSteps.orderId),
		)
		.where(
			and(
				eq(restaurantOrders.isTest, true),
				inArray(restaurantOrderSteps.step, ['started', 'ready', 'handed_over']),
				// A person moved it, never the tick that finishes an open one.
				inArray(restaurantOrderSteps.actorKind, ['operator', 'station']),
				scope,
			),
		)
	return moved?.at ? Number(moved.at) : null
}

export type GuestOrderingTestTickResult = {
	completed: number
	noncesPruned: number
	/** When the oldest still-open test order is two hours old (epoch ms), for the next alarm. */
	nextDueAt: number | null
}

/**
 * Finishes every open test order older than two hours (`completed`, by the
 * system) and forgets nonces older than a day. A test order never moves money,
 * stock or points, so completing it is only a status change and its order step.
 */
export async function runTestOrdersTick(
	orgId: string,
	db: TenantDatabase,
	now: number,
): Promise<GuestOrderingTestTickResult> {
	const cutoff = new Date(now - TEST_ORDER_AUTO_COMPLETE_MS)
	const stale = await db
		.select({ id: restaurantOrders.id })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.isTest, true),
				inArray(restaurantOrders.status, [
					'pending_acceptance',
					'accepted',
					'preparing',
					'ready',
				]),
				lt(restaurantOrders.createdAt, cutoff),
			),
		)
		.orderBy(asc(restaurantOrders.createdAt))
		.limit(100)
	let completed = 0
	for (const { id } of stale) {
		try {
			const queues = orderWriteQueues()
			const done = await runExclusive(orgId, () =>
				retryOnSqliteBusy(() =>
					runTenantTransaction(db, async (tx) => {
						const [order] = await tx
							.select()
							.from(restaurantOrders)
							.where(eq(restaurantOrders.id, id))
							.limit(1)
						if (!order || !order.isTest) return false
						// A waiting test order is accepted first, as the guest-visible path is.
						let current = order
						if (current.status === 'pending_acceptance') {
							const accepted = await applyOrderStatusPatchInTx(
								tx,
								current,
								{ status: 'accepted' },
								{
									cancel: {
										mayRefund: false,
										origin: 'system',
										actorId: 'system',
									},
									queues,
									now: new Date(now),
								},
							)
							if (!accepted.result.ok) return false
							current = accepted.result.data
						}
						const finished = await applyOrderStatusPatchInTx(
							tx,
							current,
							{ status: 'completed' },
							{
								cancel: {
									mayRefund: false,
									origin: 'system',
									actorId: 'system',
								},
								queues,
								now: new Date(now),
							},
						)
						if (!finished.result.ok) return false
						current = finished.result.data
						return current.status === 'completed'
					}),
				),
			)
			await settleOrderWriteQueues(orgId, queues)
			if (done) completed++
		} catch (error) {
			console.error(
				'Test order completion failed',
				orgId,
				id,
				errorLogFields(error),
			)
		}
	}
	const pruned = await db
		.delete(testOrderNonces)
		.where(lt(testOrderNonces.mintedAt, now - TEST_ORDER_NONCE_RETENTION_MS))
		.returning({ nonce: testOrderNonces.nonce })
	const [next] = await db
		.select({ at: min(restaurantOrders.createdAt) })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.isTest, true),
				inArray(restaurantOrders.status, [
					'pending_acceptance',
					'accepted',
					'preparing',
					'ready',
				]),
			),
		)
	const nextAt = next?.at
		? new Date(next.at).getTime() + TEST_ORDER_AUTO_COMPLETE_MS
		: null
	return {
		completed,
		noncesPruned: pruned.length,
		nextDueAt: nextAt && nextAt > now ? nextAt : null,
	}
}
