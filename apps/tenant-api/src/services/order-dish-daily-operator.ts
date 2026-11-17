/**
 * Manager actions on daily dish caps (#409): today's figures and the top-up.
 * Used by the App (operator token) and Station (device plus staff session).
 *
 * "Top up the amount left": a manager either adds units (a fresh batch came
 * out of the kitchen) or states how many are left (a count at the pass). Both
 * only change today's adjustment; the configured limit and tomorrow's
 * allowance are untouched. Ids and counts only, no guest data.
 */
import { collectDailyDishLimits } from '@repo/common/daily-dish-catalog'
import { DAILY_DISH_MAX_UNITS } from '@repo/common/daily-dish-limits'
import { and, eq } from 'drizzle-orm'
import {
	getTenantDb,
	orderDishDailyTopups,
	runTenantTransaction,
} from '@repo/tenant-db'

import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	dailyDishBusinessDate,
	readDailyDishStatus,
	type DailyDishStatus,
	type DailyDishStatusRow,
} from './order-dish-daily-service.ts'
import { fetchOrderContext, runExclusive } from './order-service.ts'

export type DailyDishOperatorFailure = {
	status: 400 | 404 | 503
	code: string
	message: string
}

export type DailyDishOperatorResult<T> =
	{ ok: true; data: T } | { ok: false; failure: DailyDishOperatorFailure }

export type DailyDishChange = { addUnits: number } | { amountLeft: number }

const unavailable: DailyDishOperatorFailure = {
	status: 503,
	code: 'ordering_unavailable',
	message: 'Ordering is temporarily unavailable.',
}

async function loadContext(orgId: string, locationId: string) {
	const result = await fetchOrderContext(orgId, locationId, null)
	if (!result.ok) return null
	return result.data
}

/** Today's figures for every capped dish and option at one location. */
export async function getOperatorDailyDishStatus(input: {
	orgId: string
	locationId: string
	now?: Date
}): Promise<DailyDishOperatorResult<DailyDishStatus>> {
	const context = await loadContext(input.orgId, input.locationId)
	if (!context) return { ok: false, failure: unavailable }
	if (!context.menu.locations.some((l) => l.id === input.locationId)) {
		return {
			ok: false,
			failure: {
				status: 404,
				code: 'location_not_found',
				message: 'Location not found.',
			},
		}
	}
	const db = await getTenantDb(input.orgId)
	return {
		ok: true,
		data: await readDailyDishStatus(
			db,
			context,
			input.locationId,
			input.now ?? new Date(),
		),
	}
}

/**
 * Adds units to, or sets the amount left of, one capped dish or option for
 * the location's current business date.
 */
export async function adjustDailyDish(input: {
	orgId: string
	locationId: string
	/** `item:<id>` or `option:<id>`. */
	key: string
	change: DailyDishChange
	/** The manager as an id only: a control-plane user id (App) or `staff:<id>` (Station). */
	userId: string | null
	now?: Date
}): Promise<DailyDishOperatorResult<DailyDishStatusRow>> {
	const now = input.now ?? new Date()
	const context = await loadContext(input.orgId, input.locationId)
	if (!context) return { ok: false, failure: unavailable }
	if (!context.menu.locations.some((l) => l.id === input.locationId)) {
		return {
			ok: false,
			failure: {
				status: 404,
				code: 'location_not_found',
				message: 'Location not found.',
			},
		}
	}
	const limits = collectDailyDishLimits(
		context.dailyDishLimits,
		input.locationId,
	)
	const entry = limits.get(input.key)
	if (!entry) {
		return {
			ok: false,
			failure: {
				status: 404,
				code: 'daily_limit_not_found',
				message: 'This dish has no daily limit here.',
			},
		}
	}
	const db = await getTenantDb(input.orgId)

	const row = await runExclusive(input.orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const businessDate = await dailyDishBusinessDate(
					tx,
					context,
					input.locationId,
					now.getTime(),
				)
				const status = await readDailyDishStatus(
					tx,
					context,
					input.locationId,
					now,
				)
				const current = status.rows.find((r) => r.key === input.key)
				// The row exists whenever the key is limited at this location.
				const toppedUp = current?.toppedUpUnits ?? 0
				const sold = current?.soldUnits ?? 0
				const held = current?.heldUnits ?? 0
				const next =
					'addUnits' in input.change
						? toppedUp + input.change.addUnits
						: input.change.amountLeft + sold + held - entry.limit
				const clamped = Math.max(
					-DAILY_DISH_MAX_UNITS,
					Math.min(DAILY_DISH_MAX_UNITS, next),
				)
				const at = now.getTime()
				const [existing] = await tx
					.select({ id: orderDishDailyTopups.id })
					.from(orderDishDailyTopups)
					.where(
						and(
							eq(orderDishDailyTopups.locationId, input.locationId),
							eq(orderDishDailyTopups.businessDate, businessDate),
							eq(orderDishDailyTopups.catalogKey, input.key),
						),
					)
					.limit(1)
				if (existing) {
					await tx
						.update(orderDishDailyTopups)
						.set({
							toppedUpUnits: clamped,
							updatedBy: input.userId,
							updatedAt: at,
						})
						.where(eq(orderDishDailyTopups.id, existing.id))
				} else {
					await tx.insert(orderDishDailyTopups).values({
						locationId: input.locationId,
						businessDate,
						catalogKey: input.key,
						toppedUpUnits: clamped,
						updatedBy: input.userId,
						updatedAt: at,
					})
				}
				const after = await readDailyDishStatus(
					tx,
					context,
					input.locationId,
					now,
				)
				return after.rows.find((r) => r.key === input.key)
			}),
		),
	)
	if (!row) return { ok: false, failure: unavailable }
	return { ok: true, data: row }
}
