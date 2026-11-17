import type { SlotLimitSettings } from './location-types.ts'

export type OrderLimitExempt = {
	itemIds: ReadonlySet<string>
	categoryIds: ReadonlySet<string>
}

export type SlotUsageLine = {
	itemId: string
	quantity: number
	categoryIds: readonly string[]
}

export type SlotUsageInput = {
	lines: readonly SlotUsageLine[]
	settings: SlotLimitSettings
	exempt: OrderLimitExempt
}

/** How much capacity one order consumes in its ready-time slot (#108, #256). */
export function slotUsageUnits(input: SlotUsageInput): number {
	const { settings, lines, exempt } = input
	if (!settings.enabled) return 0
	if (lines.length === 0) return 0

	if (settings.unit === 'orders') {
		return lines.some((line) => lineCountsTowardLimit(line, exempt)) ? 1 : 0
	}

	let dishes = 0
	for (const line of lines) {
		if (!lineCountsTowardLimit(line, exempt)) continue
		dishes += line.quantity
	}
	return dishes
}

/** Dish quantities that count toward order limits (#256), reused for packaging per-item (#408). */
export function orderDishUnits(
	lines: readonly SlotUsageLine[],
	exempt: OrderLimitExempt,
): number {
	let dishes = 0
	for (const line of lines) {
		if (!lineCountsTowardLimit(line, exempt)) continue
		dishes += line.quantity
	}
	return dishes
}

function lineCountsTowardLimit(
	line: SlotUsageLine,
	exempt: OrderLimitExempt,
): boolean {
	if (exempt.itemIds.has(line.itemId)) return false
	if (line.categoryIds.length === 0) return true
	return line.categoryIds.some((id) => !exempt.categoryIds.has(id))
}

export function slotLimitForFulfillment(
	settings: SlotLimitSettings,
	fulfillment: 'pickup' | 'delivery',
): number | null {
	if (!settings.enabled) return null
	const specific =
		fulfillment === 'pickup' ? settings.pickupLimit : settings.deliveryLimit
	return specific ?? settings.defaultLimit
}

/**
 * True when `used + incoming` would exceed `limit`, including the
 * "one large order in an empty slot" exception (#256).
 */
export function wouldExceedSlotLimit(args: {
	used: number
	incoming: number
	limit: number | null
	allowOneLargeOrderPerSlot: boolean
}): boolean {
	const { used, incoming, limit, allowOneLargeOrderPerSlot } = args
	if (limit == null || incoming <= 0) return false
	if (used + incoming <= limit) return false
	if (used === 0 && allowOneLargeOrderPerSlot && incoming > limit) {
		return false
	}
	return true
}
