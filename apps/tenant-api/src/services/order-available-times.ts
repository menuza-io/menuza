import {
	buildOnlineHours,
	readySlotFloorMs,
	slotsForLocalDate,
	type AvailableTimeSlot,
} from '@repo/common/available-times'
import {
	parsePrepSchedule,
	parseSlotLimitSettings,
} from '@repo/common/location-settings'
import { activeBusyExtraPrepMinutes } from '@repo/common/location-availability'
import { prepMinutesAt } from '@repo/common/prep-schedule'
import { slotLimitForFulfillment } from '@repo/common/slot-usage'
import {
	getTenantDb,
	RESTAURANT_ORDER_ACTIVE_STATUSES,
	restaurantOrders,
} from '@repo/tenant-db'
import { and, eq, gte, inArray, isNotNull, lt, sql, sum } from 'drizzle-orm'

import { type RestaurantOrderContext } from '@repo/common/restaurant-orders'

export type AvailableTimesResponse = {
	slots: AvailableTimeSlot[]
	earliest: string | null
}

export async function buildAvailableTimes(
	orgId: string,
	context: RestaurantOrderContext,
	locationId: string,
	fulfillment: 'pickup' | 'delivery',
	localDate: string,
	now = new Date(),
): Promise<AvailableTimesResponse | null> {
	if (!context.slotLimits?.enabled) return null
	const location = context.menu.locations.find((l) => l.id === locationId)
	if (!location) return null
	const settings = parseSlotLimitSettings(location.slotLimitSettings)
	if (!settings?.enabled) return null
	const limit = slotLimitForFulfillment(settings, fulfillment)
	const hours = buildOnlineHours({
		timezone: location.timezone,
		isActive: true,
		storeHours: location.storeHours,
		onlineHours: location.onlineHours,
		specialHours: location.specialHours,
		onlineOrderingSettings: location.onlineOrderingSettings,
	})
	const timeZone = location.timezone || 'UTC'
	const prep =
		prepMinutesAt(
			parsePrepSchedule(location.prepSchedule),
			location.prepTime ?? 15,
			now.getTime(),
			timeZone,
		) + activeBusyExtraPrepMinutes(location, now)
	const used = await readSlotUsageByReadyAt(
		orgId,
		locationId,
		localDate,
		location.timezone,
	)
	const slots = slotsForLocalDate(
		hours,
		localDate,
		used,
		limit,
		now.getTime(),
		prep,
	)
	const earliest =
		slots.find((s) => s.available)?.at ?? slots.find((s) => s.at)?.at ?? null
	return { slots, earliest }
}

export async function readSlotUsageByReadyAt(
	orgId: string,
	locationId: string,
	localDate: string,
	timeZone: string,
): Promise<Map<number, number>> {
	const start = readySlotFloorMs(
		new Date(`${localDate}T00:00:00`).getTime(),
		timeZone,
	)
	const end =
		readySlotFloorMs(new Date(`${localDate}T23:59:00`).getTime(), timeZone) +
		24 * 60 * 60_000
	const db = await getTenantDb(orgId)
	const rows = await db
		.select({
			slot: restaurantOrders.readySlotAt,
			value: sum(restaurantOrders.readySlotUnits),
		})
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.orgId, orgId),
				eq(restaurantOrders.locationId, locationId),
				isNotNull(restaurantOrders.readySlotAt),
				gte(restaurantOrders.readySlotAt, new Date(start)),
				lt(restaurantOrders.readySlotAt, new Date(end)),
				inArray(restaurantOrders.status, [...RESTAURANT_ORDER_ACTIVE_STATUSES]),
				sql`${restaurantOrders.dropId} IS NULL`,
			),
		)
		.groupBy(restaurantOrders.readySlotAt)
	const out = new Map<number, number>()
	for (const row of rows) {
		if (!row.slot) continue
		out.set(row.slot.getTime(), Number(row.value))
	}
	return out
}
