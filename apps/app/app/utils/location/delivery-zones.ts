import {
	DeliveryDistanceFeesSchema,
	DeliveryFeeStepSchema,
	validateDistanceBands,
	validateFeeSteps,
	type FeeTableProblem,
} from '@repo/common/delivery-fees'
import { type DeliveryZone } from '@repo/common/location-types'
import { zoneOverlaps } from '@repo/geo/overlap'

/**
 * Delivery zone list helpers shared by the zones screen and the location save
 * (#266, #244, #421). Pure: no I/O.
 */

/** Moves one zone to the place another holds. */
export function moveZone(
	zones: readonly DeliveryZone[],
	fromId: string,
	toId: string,
): DeliveryZone[] {
	const from = zones.findIndex((zone) => zone.id === fromId)
	const to = zones.findIndex((zone) => zone.id === toId)
	if (from < 0 || to < 0 || from === to) return [...zones]
	const next = [...zones]
	const [moved] = next.splice(from, 1)
	next.splice(to, 0, moved!)
	return next
}

export type ZoneOverlapNote = {
	/** Allowed zones this one overlaps, in list order. */
	overlaps: Array<{ id: string; name: string; thisWins: boolean }>
}

/**
 * For each zone, which allowed zones it overlaps and which of the two applies
 * where they do: the higher one in `order` mode, the cheaper one (then the lower
 * minimum, then the higher one) in `cheapest` mode. Not allowed zones exclude
 * whatever their place, so they carry no note, and neither do disabled zones.
 */
export function zoneOverlapNotes(
	zones: readonly DeliveryZone[],
	store: { lat: number; lng: number } | null,
	priority: 'cheapest' | 'order',
): Map<string, ZoneOverlapNote> {
	const allowed = zones.filter(
		(zone) => zone.restriction === 'allowed' && zone.enabled,
	)
	const found = zoneOverlaps(allowed, store)
	const position = new Map(zones.map((zone, index) => [zone.id, index]))
	const notes = new Map<string, ZoneOverlapNote>()
	for (const [id, others] of found) {
		const zone = zones.find((candidate) => candidate.id === id)!
		notes.set(id, {
			overlaps: others.flatMap((otherId) => {
				const other = zones.find((candidate) => candidate.id === otherId)
				if (!other) return []
				const higher = position.get(id)! < position.get(otherId)!
				const cheaper =
					zone.deliveryFee !== other.deliveryFee
						? zone.deliveryFee < other.deliveryFee
						: zone.minimumOrder !== other.minimumOrder
							? zone.minimumOrder < other.minimumOrder
							: higher
				return [
					{
						id: other.id,
						name: other.name,
						thisWins: priority === 'order' ? higher : cheaper,
					},
				]
			}),
		})
	}
	return notes
}

export type ZoneTableError = {
	zoneName: string
	problem: FeeTableProblem | 'invalid_table'
}

/**
 * The first problem in any zone's fee table, or null. Used on the screen before
 * a zone is saved and again on the server, so a hand-made request cannot store a
 * table the region would misread.
 */
export function firstZoneTableProblem(
	zones: readonly Partial<DeliveryZone>[],
): ZoneTableError | null {
	for (const zone of zones) {
		const zoneName = typeof zone.name === 'string' ? zone.name : ''
		if (zone.feeSteps !== undefined) {
			const parsed = DeliveryFeeStepSchema.array().max(10).safeParse(zone.feeSteps)
			if (!parsed.success) return { zoneName, problem: 'invalid_table' }
			const problem = validateFeeSteps(parsed.data, zone.minimumOrder ?? 0)
			if (problem) return { zoneName, problem }
		}
		if (zone.distanceFees) {
			const parsed = DeliveryDistanceFeesSchema.safeParse(zone.distanceFees)
			if (!parsed.success) return { zoneName, problem: 'invalid_table' }
			const problem = validateDistanceBands(parsed.data)
			if (problem) return { zoneName, problem }
		}
	}
	return null
}

/** Reads the zones a form sent; null when it is not a list of objects. */
export function parseZonesJson(
	raw: string | null | undefined,
): Partial<DeliveryZone>[] | null {
	if (!raw) return null
	try {
		const value: unknown = JSON.parse(raw)
		return Array.isArray(value) &&
			value.every((item) => typeof item === 'object' && item !== null)
			? (value as Partial<DeliveryZone>[])
			: null
	} catch {
		return null
	}
}

/**
 * The message a refused save shows (English; the form reads it as the error).
 * The screen checks the same tables first, so this only fires for a request the
 * screen did not make.
 */
export function zoneTableProblemMessage(error: ZoneTableError): string {
	const zone = error.zoneName || 'A delivery zone'
	switch (error.problem) {
		case 'steps_not_distinct':
			return `${zone}: each fee step needs a different order amount.`
		case 'steps_first_not_minimum':
			return `${zone}: the first fee step must start at the minimum order.`
		case 'steps_too_many':
			return `${zone}: use at most 10 fee steps.`
		case 'bands_not_distinct':
			return `${zone}: each distance band needs a different distance.`
		case 'bands_first_not_zero':
			return `${zone}: the first distance band must start at zero.`
		case 'bands_too_many':
			return `${zone}: use at most 10 distance bands.`
		default:
			return `${zone}: check the amounts in the fee table.`
	}
}
