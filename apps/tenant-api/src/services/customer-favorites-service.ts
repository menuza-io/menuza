import {
	FAVORITES_LIMIT,
	type FavoriteList,
} from '@repo/common/guest-favorites'
import {
	customerFavorites,
	runTenantTransaction,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, desc, eq, sql } from 'drizzle-orm'

import { HttpError } from '../lib/http.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { runExclusive } from './order-service.ts'

/**
 * Favorite dishes on the guest account (#158). Regional rows hold the dish id
 * and the day it was added; the menu itself (names, prices, what is sold out)
 * stays where it is, and clients join the two, so a dish that left the menu
 * simply drops out of the row. Up to 100 per customer (one regional database
 * holds one organization, so that is per organization too).
 */

export async function listFavorites(
	db: TenantDatabase,
	customerId: string,
): Promise<FavoriteList> {
	const rows = await db
		.select({
			itemId: customerFavorites.itemId,
			createdAt: customerFavorites.createdAt,
		})
		.from(customerFavorites)
		.where(eq(customerFavorites.customerId, customerId))
		.orderBy(desc(customerFavorites.createdAt))
	return { favorites: rows, limit: FAVORITES_LIMIT }
}

/**
 * Adds one favorite. Idempotent: a dish already favorited answers `created:
 * false` without using another slot, so a double tap or a retry is harmless.
 */
export async function addFavorite(
	orgId: string,
	db: TenantDatabase,
	customerId: string,
	itemId: string,
	now = Date.now(),
): Promise<{ created: boolean }> {
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [existing] = await tx
					.select({ itemId: customerFavorites.itemId })
					.from(customerFavorites)
					.where(
						and(
							eq(customerFavorites.customerId, customerId),
							eq(customerFavorites.itemId, itemId),
						),
					)
					.limit(1)
				if (existing) return { created: false }
				const [{ count } = { count: 0 }] = await tx
					.select({ count: sql<number>`count(*)` })
					.from(customerFavorites)
					.where(eq(customerFavorites.customerId, customerId))
				if (Number(count) >= FAVORITES_LIMIT) {
					throw new HttpError(
						409,
						'favorites_limit_reached',
						`You can favorite up to ${FAVORITES_LIMIT} dishes.`,
						{ limit: FAVORITES_LIMIT },
					)
				}
				await tx
					.insert(customerFavorites)
					.values({ customerId, itemId, createdAt: now })
				return { created: true }
			}),
		),
	)
}

/** Removes one favorite; removing one that is not there is not an error. */
export async function removeFavorite(
	db: TenantDatabase,
	customerId: string,
	itemId: string,
): Promise<void> {
	await db
		.delete(customerFavorites)
		.where(
			and(
				eq(customerFavorites.customerId, customerId),
				eq(customerFavorites.itemId, itemId),
			),
		)
}
