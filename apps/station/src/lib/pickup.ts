/** A datetime-local value in the restaurant's zone, not the tablet's zone. */
export function pickupLocalValue(at: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(at)
	const part = (type: string) => parts.find((p) => p.type === type)!.value
	return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}

/** Rejects nonexistent or ambiguous DST times instead of silently moving pickup. */
export function parsePickupLocal(
	value: string,
	timeZone: string,
): number | null {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
	const wall = Date.parse(`${value}:00Z`)
	if (!Number.isFinite(wall)) return null
	const candidates = new Set<number>()
	for (const delta of [-86_400_000, 0, 86_400_000]) {
		const sample = wall + delta
		const offset =
			Date.parse(`${pickupLocalValue(sample, timeZone)}:00Z`) - sample
		const candidate = wall - offset
		if (pickupLocalValue(candidate, timeZone) === value)
			candidates.add(candidate)
	}
	return candidates.size === 1 ? [...candidates][0]! : null
}

export function formatPickupAt(
	at: number,
	locale: string,
	timeZone?: string | null,
): string {
	return new Intl.DateTimeFormat(locale, {
		timeZone: timeZone ?? undefined,
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(at)
}

export type PhonePickup = {
	customerName: string
	customerPhone: string
	pickupAt: number | null
	pickupTimeZone: string
}
