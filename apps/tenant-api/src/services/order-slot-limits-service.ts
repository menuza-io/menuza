import {
	ORDER_SLOT_MINUTES,
	buildOnlineHours,
	localDateInZone,
	readySlotFloorMs,
	slotsForLocalDate,
} from '@repo/common/available-times'
import {
	parsePrepSchedule,
	parseSlotLimitSettings,
} from '@repo/common/location-settings'
import { activeBusyExtraPrepMinutes } from '@repo/common/location-availability'
import { prepMinutesAt } from '@repo/common/prep-schedule'
import {
	buildOrderLimitCatalog,
	orderLimitExemptFromCatalog,
	readySlotUnitsForOrder,
	slotLimitForFulfillment,
	type RestaurantOrderContext,
} from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	RESTAURANT_ORDER_ACTIVE_STATUSES,
	restaurantOrders,
	runTenantTransaction,
} from '@repo/tenant-db'
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'

import { fetchOrderContext, runExclusive } from './order-service.ts'
import { readSlotUsageByReadyAt } from './order-available-times.ts'

export type OperatorSlotLimitsToday = {
	enabled: boolean
	unit: 'orders' | 'dishes' | null
	limit: number | null
	exemptItems: number
	exemptCategories: number
	slots: Array<{
		at: string
		used: number
		limit: number | null
		remaining: number | null
	}>
}

export type SlotLimitsFailure = {
	status: 404 | 403 | 503
	code: string
	message: string
}

export type ResetSlotLimitsResult =
	| { ok: true; slotsCleared: string[] }
	| { ok: false; failure: SlotLimitsFailure }

const SLOT_PANEL_COUNT = 6

export async function getOperatorSlotLimitsToday(
	orgId: string,
	context: RestaurantOrderContext,
	locationId: string,
	fulfillment: 'pickup' | 'delivery',
	now = new Date(),
): Promise<OperatorSlotLimitsToday | null> {
	if (context.slotLimits?.enabled !== true) return null
	const location = context.menu.locations.find((l) => l.id === locationId)
	if (!location) return null
	const settings = parseSlotLimitSettings(location.slotLimitSettings)
	if (!settings?.enabled) return null
	const limit = slotLimitForFulfillment(settings, fulfillment)
	const { catalog, categoryExempt } = buildOrderLimitCatalog(context)
	const exempt = orderLimitExemptFromCatalog(catalog, categoryExempt)
	const localDate = localDateInZone(now.getTime(), location.timezone || 'UTC')
	const used = await readSlotUsageByReadyAt(
		orgId,
		locationId,
		localDate,
		location.timezone,
	)
	const hours = buildOnlineHours(location)
	const prep =
		prepMinutesAt(
			parsePrepSchedule(location.prepSchedule),
			location.prepTime ?? 15,
			now.getTime(),
			location.timezone || 'UTC',
		) + activeBusyExtraPrepMinutes(location, now)
	const all = slotsForLocalDate(
		hours,
		localDate,
		used,
		limit,
		now.getTime(),
		prep,
	)
	const currentFloor = readySlotFloorMs(
		now.getTime(),
		location.timezone || 'UTC',
	)
	const upcoming = all.filter(
		(slot) => new Date(slot.at).getTime() >= currentFloor,
	)
	const panel = upcoming.slice(0, SLOT_PANEL_COUNT).map((slot) => {
		const usedCount = used.get(new Date(slot.at).getTime()) ?? 0
		const remaining = limit == null ? null : Math.max(0, limit - usedCount)
		return {
			at: slot.at,
			used: usedCount,
			limit,
			remaining,
		}
	})
	return {
		enabled: true,
		unit: settings.unit ?? 'orders',
		limit,
		exemptItems: exempt.itemIds.size,
		exemptCategories: exempt.categoryIds.size,
		slots: panel,
	}
}

export async function resetOperatorSlotLimits(input: {
	orgId: string
	locationId: string
	now?: Date
}): Promise<ResetSlotLimitsResult> {
	const now = input.now ?? new Date()
	const contextResult = await fetchOrderContext(
		input.orgId,
		input.locationId,
		null,
	)
	if (!contextResult.ok) {
		return {
			ok: false,
			failure: {
				status: 503,
				code: 'ordering_unavailable',
				message: 'Ordering is temporarily unavailable.',
			},
		}
	}
	const context = contextResult.data
	if (context.slotLimits?.enabled !== true) {
		return {
			ok: false,
			failure: {
				status: 404,
				code: 'slot_limits_disabled',
				message: 'Slot limits are not enabled.',
			},
		}
	}
	const location = context.menu.locations.find((l) => l.id === input.locationId)
	if (!location) {
		return {
			ok: false,
			failure: {
				status: 404,
				code: 'location_not_found',
				message: 'Location not found.',
			},
		}
	}
	const timeZone = location.timezone || 'UTC'
	const slotFloor = readySlotFloorMs(now.getTime(), timeZone)

	const slotsCleared = new Set<string>()
	const db = await getTenantDb(input.orgId)

	const result = await runExclusive(input.orgId, () =>
		runTenantTransaction(db, async (tx) => {
			const rows = await tx
				.select({
					id: restaurantOrders.id,
					status: restaurantOrders.status,
					fulfillment: restaurantOrders.fulfillment,
					lines: restaurantOrders.lines,
					readySlotAt: restaurantOrders.readySlotAt,
					dropId: restaurantOrders.dropId,
				})
				.from(restaurantOrders)
				.where(
					and(
						eq(restaurantOrders.orgId, input.orgId),
						eq(restaurantOrders.locationId, input.locationId),
						isNotNull(restaurantOrders.readySlotAt),
						gte(restaurantOrders.readySlotAt, new Date(slotFloor)),
						sql`${restaurantOrders.dropId} IS NULL`,
					),
				)

			for (const row of rows) {
				if (!row.readySlotAt) continue
				const slotMs = row.readySlotAt.getTime()
				const slotEnds = slotMs + ORDER_SLOT_MINUTES * 60_000
				if (slotEnds <= now.getTime()) continue
				slotsCleared.add(row.readySlotAt.toISOString())

				const active = (
					RESTAURANT_ORDER_ACTIVE_STATUSES as readonly string[]
				).includes(row.status)
				const units = active
					? readySlotUnitsForOrder({
							context,
							locationId: input.locationId,
							fulfillment: row.fulfillment,
							lines: row.lines,
						})
					: 0

				await tx
					.update(restaurantOrders)
					.set({ readySlotUnits: units > 0 ? units : null })
					.where(eq(restaurantOrders.id, row.id))
			}
			return [...slotsCleared].sort()
		}),
	)

	return { ok: true, slotsCleared: result }
}
