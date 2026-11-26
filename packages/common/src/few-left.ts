/**
 * "Only a few left" (#473). The same 7-day counted rule as auto sold-out.
 * Station shows the number. The online menu shows a phrase and never the number.
 */

export const FEW_LEFT_DEFAULT_THRESHOLD = 5
export const FEW_LEFT_COUNT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const FEW_LEFT_ONLINE_FLAG = 'inventory.few_left_online'

export type FewLeftLine = { itemId: string; quantity: number }

/**
 * How many more portions the recipe can make. Null when any ingredient was
 * not in an approved count within `maxAgeMs`, or the recipe has no lines.
 * Zero is a real count (sold out is a different badge).
 */
export function portionsLeft(input: {
	lines: readonly FewLeftLine[]
	onHand: ReadonlyMap<string, number>
	countedAt: ReadonlyMap<string, number>
	now: number
	maxAgeMs?: number
}): number | null {
	const maxAge = input.maxAgeMs ?? FEW_LEFT_COUNT_MAX_AGE_MS
	const lines = input.lines.filter((line) => line.quantity > 0)
	if (lines.length === 0) return null
	let min = Number.POSITIVE_INFINITY
	for (const line of lines) {
		const counted = input.countedAt.get(line.itemId)
		if (counted == null || input.now - counted > maxAge) return null
		const onHand = input.onHand.get(line.itemId) ?? 0
		min = Math.min(min, Math.floor(onHand / line.quantity))
	}
	if (!Number.isFinite(min)) return null
	return Math.max(0, min)
}

/** Station label. Null when there is nothing to say (not counted, or none left). */
export function stationFewLeftLabel(
	portions: number | null,
	threshold = FEW_LEFT_DEFAULT_THRESHOLD,
): string | null {
	if (portions == null || portions <= 0 || portions > threshold) return null
	return `${portions} left`
}

/**
 * Online badge. Never includes the number. Null when the org has not turned
 * the badge on, or the dish is not in the "few left" band.
 */
export function onlineFewLeftLabel(
	portions: number | null,
	input: { enabled: boolean; threshold?: number } = { enabled: false },
): string | null {
	if (!input.enabled) return null
	const threshold = input.threshold ?? FEW_LEFT_DEFAULT_THRESHOLD
	if (portions == null || portions <= 0 || portions > threshold) return null
	return 'Only a few left'
}
