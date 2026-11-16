import { readySlotFloorMs } from './available-times.ts'
import { activeBusyExtraPrepMinutes } from './location-availability.ts'
import {
	parsePrepSchedule,
	parseSlotLimitSettings,
} from './location-settings.ts'
import { prepMinutesAt } from './prep-schedule.ts'
import type { PublicLocationContext } from './restaurant-orders.ts'
import {
	orderLimitExemptFromCatalog,
	type OrderLimitCatalogEntry,
} from './order-limit-exempt.ts'
import {
	slotLimitForFulfillment,
	slotUsageUnits,
	type SlotUsageLine,
} from './slot-usage.ts'

export type ReadySlotCapacitySpec = {
	locationId: string
	readySlotAtMs: number
	/** Units this order consumes in the slot (0 when exempt-only). */
	units: number
	limit: number
	allowOneLargeOrderPerSlot: boolean
	fulfillment: 'pickup' | 'delivery'
}

export function readyInstantMs(
	location: PublicLocationContext,
	scheduledForIso: string | null,
	now: Date,
): number {
	const timeZone = location.timezone || 'UTC'
	if (scheduledForIso) {
		const when = new Date(scheduledForIso)
		return readySlotFloorMs(when.getTime(), timeZone)
	}
	const schedule = parsePrepSchedule(location.prepSchedule)
	const kitchenStart = now.getTime()
	const prep =
		prepMinutesAt(schedule, location.prepTime ?? 15, kitchenStart, timeZone) +
		activeBusyExtraPrepMinutes(location, now)
	return readySlotFloorMs(now.getTime() + prep * 60_000, timeZone)
}

export function computeReadySlotCapacity(input: {
	slotLimitsEnabled: boolean
	location: PublicLocationContext
	fulfillment: string
	scheduledFor: string | null
	now: Date
	catalog: ReadonlyMap<string, OrderLimitCatalogEntry>
	categoryExempt: ReadonlySet<string>
	lines: readonly SlotUsageLine[]
}): ReadySlotCapacitySpec | null {
	if (!input.slotLimitsEnabled) return null
	if (input.fulfillment !== 'pickup' && input.fulfillment !== 'delivery') {
		return null
	}
	const settings = parseSlotLimitSettings(input.location.slotLimitSettings)
	if (!settings?.enabled) return null
	const limit = slotLimitForFulfillment(settings, input.fulfillment)
	if (limit == null) return null
	const exempt = orderLimitExemptFromCatalog(
		input.catalog,
		input.categoryExempt,
	)
	const units = slotUsageUnits({
		settings,
		lines: input.lines,
		exempt,
	})
	const readySlotAtMs = readyInstantMs(
		input.location,
		input.scheduledFor,
		input.now,
	)
	return {
		locationId: input.location.id,
		readySlotAtMs,
		units,
		limit,
		allowOneLargeOrderPerSlot: settings.allowOneLargeOrderPerSlot,
		fulfillment: input.fulfillment,
	}
}
