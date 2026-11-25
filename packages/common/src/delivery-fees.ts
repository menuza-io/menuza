import { z } from 'zod'

/**
 * What a guest pays to have an order delivered, worked out in one place (#244,
 * #421) for tenant-api, Sites, the customer app and the phone agent. Pure: no
 * I/O, no UI words.
 *
 * ## Order of things, from address to fee
 *
 * 1. **Which zone** (#266, `resolveZoneForPoint` in `@repo/geo`): disabled zones
 *    are skipped, Not allowed zones exclude, and among the allowed zones that
 *    cover the address the location's `zonePriority` decides (`cheapest` or the
 *    list order).
 * 2. **Distance** (#421): when that zone has distance bands, the distance is the
 *    road distance if the zone says `driving` and the routing service answered,
 *    otherwise the straight-line distance from the store. The band the distance
 *    falls in sets the fee; the zone's single fee is the fallback when the
 *    distance cannot be measured.
 * 3. **Order size** (#244): when the zone has a fee by order size, the step the
 *    subtotal reaches sets the fee. With distance bands too, the step table can
 *    only lower the distance fee, never raise it (the lower of the two).
 * 4. A `free_delivery` discount still wins over all of it (the discount engine
 *    takes this fee as its input).
 *
 * The subtotal is the items subtotal before discounts, tax, tip and fees: the
 * same base the zone's minimum order is checked against. Money in zones is in
 * major units; every comparison here is done in whole minor units.
 */

export const MAX_DELIVERY_FEE_STEPS = 10
export const MAX_DELIVERY_DISTANCE_BANDS = 10

export const DISTANCE_MODE_VALUES = ['straight_line', 'driving'] as const
export type DistanceMode = (typeof DISTANCE_MODE_VALUES)[number]

/** "From this subtotal, charge this fee." Major units. */
export const DeliveryFeeStepSchema = z.object({
	from: z.number().min(0),
	fee: z.number().min(0),
})
export type DeliveryFeeStep = z.infer<typeof DeliveryFeeStepSchema>

/** "From this distance, charge this fee." The distance is in `unit`. */
export const DeliveryDistanceBandSchema = z.object({
	from: z.number().min(0),
	fee: z.number().min(0),
})
export type DeliveryDistanceBand = z.infer<typeof DeliveryDistanceBandSchema>

export const DeliveryDistanceFeesSchema = z.object({
	mode: z.enum(DISTANCE_MODE_VALUES),
	unit: z.enum(['km', 'miles']),
	bands: z.array(DeliveryDistanceBandSchema).max(MAX_DELIVERY_DISTANCE_BANDS),
})
export type DeliveryDistanceFees = z.infer<typeof DeliveryDistanceFeesSchema>

/** The parts of a delivery zone that set its fee. */
export type DeliveryFeeZone = {
	deliveryFee: number
	minimumOrder: number
	feeSteps?: readonly DeliveryFeeStep[] | null
	distanceFees?: DeliveryDistanceFees | null
}

const METERS_PER_KM = 1000
const METERS_PER_MILE = 1609.344

const toMinor = (value: number) => Math.round(value * 100)

export function metersToUnit(meters: number, unit: 'km' | 'miles'): number {
	return meters / (unit === 'km' ? METERS_PER_KM : METERS_PER_MILE)
}

/** Steps sorted by threshold, with unusable rows left out. */
function usableSteps(zone: DeliveryFeeZone): DeliveryFeeStep[] {
	return [...(zone.feeSteps ?? [])]
		.filter(
			(step) =>
				Number.isFinite(step.from) &&
				Number.isFinite(step.fee) &&
				step.from >= 0 &&
				step.fee >= 0,
		)
		.sort((a, b) => a.from - b.from)
}

function usableBands(zone: DeliveryFeeZone): DeliveryDistanceBand[] {
	return [...(zone.distanceFees?.bands ?? [])]
		.filter(
			(band) =>
				Number.isFinite(band.from) &&
				Number.isFinite(band.fee) &&
				band.from >= 0 &&
				band.fee >= 0,
		)
		.sort((a, b) => a.from - b.from)
}

/** Whether the zone prices by distance (it has bands to price by). */
export function zoneHasDistanceFees(zone: DeliveryFeeZone): boolean {
	return usableBands(zone).length > 0
}

/** Whether the zone prices by order size. */
export function zoneHasFeeSteps(zone: DeliveryFeeZone): boolean {
	return usableSteps(zone).length > 0
}

/** Whether the guest's fee can change with the cart (a table by order size). */
export function deliveryFeeDependsOnSubtotal(zone: DeliveryFeeZone): boolean {
	return zoneHasFeeSteps(zone)
}

/**
 * The distance a zone's bands are measured with: the road distance when the
 * zone asks for `driving` and the routing service gave one, otherwise the
 * straight-line distance (also the fallback when routing fails). `null` when
 * neither is known.
 */
export function distanceForZone(
	zone: DeliveryFeeZone,
	measured: { straightMeters?: number | null; drivingMeters?: number | null },
): { meters: number; source: 'driving' | 'straight_line' } | null {
	const finite = (value: number | null | undefined): value is number =>
		typeof value === 'number' && Number.isFinite(value) && value >= 0
	if (zone.distanceFees?.mode === 'driving' && finite(measured.drivingMeters)) {
		return { meters: measured.drivingMeters, source: 'driving' }
	}
	if (finite(measured.straightMeters)) {
		return { meters: measured.straightMeters, source: 'straight_line' }
	}
	return null
}

/**
 * The fee for the distance alone, in minor units: the band the distance falls
 * in, else the zone's single fee (no bands, or the distance is unknown).
 */
export function distanceFeeCents(
	zone: DeliveryFeeZone,
	distanceMeters: number | null | undefined,
): number {
	const bands = usableBands(zone)
	const single = toMinor(zone.deliveryFee)
	if (
		bands.length === 0 ||
		distanceMeters == null ||
		!Number.isFinite(distanceMeters) ||
		distanceMeters < 0
	) {
		return single
	}
	const distance = metersToUnit(distanceMeters, zone.distanceFees!.unit)
	let band = bands[0]!
	for (const candidate of bands) {
		if (candidate.from <= distance + 1e-9) band = candidate
	}
	return toMinor(band.fee)
}

function stepFeeCents(
	steps: readonly DeliveryFeeStep[],
	subtotalCents: number,
): number {
	let step = steps[0]!
	for (const candidate of steps) {
		if (toMinor(candidate.from) <= subtotalCents) step = candidate
	}
	return toMinor(step.fee)
}

/**
 * The delivery fee in minor units for a zone, a subtotal (minor units, before
 * discounts, tax, tip and fees) and a distance. The one function every channel
 * uses.
 */
export function deliveryFeeCentsFor(
	zone: DeliveryFeeZone,
	subtotalCents: number,
	distanceMeters: number | null = null,
): number {
	const base = distanceFeeCents(zone, distanceMeters)
	const steps = usableSteps(zone)
	if (steps.length === 0) return base
	const bySize = stepFeeCents(steps, Math.max(0, subtotalCents))
	// A zone that prices by distance as well lets the order size only lower it.
	return zoneHasDistanceFees(zone) ? Math.min(base, bySize) : bySize
}

/** The fee in major units (a convenience over `deliveryFeeCentsFor`). */
export function deliveryFeeFor(
	zone: DeliveryFeeZone,
	subtotal: number,
	distanceMeters: number | null = null,
): number {
	return deliveryFeeCentsFor(zone, toMinor(subtotal), distanceMeters) / 100
}

export type DeliveryFeeProgress = {
	/** The fee at this subtotal, minor units. */
	feeCents: number
	/**
	 * The next step down: the subtotal it starts at, the fee from there and how
	 * much more the guest has to add (all minor units). `null` when no later step
	 * is cheaper.
	 */
	next: { fromCents: number; feeCents: number; remainingCents: number } | null
}

/**
 * Where the guest stands on the fee table: the fee now and what adding more
 * would unlock ("Add 6.00 more for free delivery"). Only a step that lowers the
 * fee counts.
 */
export function deliveryFeeProgress(
	zone: DeliveryFeeZone,
	subtotalCents: number,
	distanceMeters: number | null = null,
): DeliveryFeeProgress {
	const current = deliveryFeeCentsFor(zone, subtotalCents, distanceMeters)
	for (const step of usableSteps(zone)) {
		const from = toMinor(step.from)
		if (from <= subtotalCents) continue
		const fee = deliveryFeeCentsFor(zone, from, distanceMeters)
		if (fee < current) {
			return {
				feeCents: current,
				next: {
					fromCents: from,
					feeCents: fee,
					remainingCents: from - Math.max(0, subtotalCents),
				},
			}
		}
	}
	return { feeCents: current, next: null }
}

/**
 * What a client needs to price delivery as the cart changes, without the zone:
 * the fee for the distance (steps aside) and the table by order size. The
 * regional quote carries it so Sites, the customer app and the phone agent
 * work the fee out with `deliveryFeeCentsFor` and never disagree with the node.
 */
export type DeliveryFeePricing = {
	/** The fee for the address, in major units, before any order size table. */
	baseFee: number
	steps: DeliveryFeeStep[]
	/** Whether the table can only lower a distance fee (the zone has bands too). */
	byDistance: boolean
}

export function deliveryPricingFor(
	zone: DeliveryFeeZone,
	distanceMeters: number | null,
): DeliveryFeePricing {
	return {
		baseFee: distanceFeeCents(zone, distanceMeters) / 100,
		steps: usableSteps(zone),
		byDistance: zoneHasDistanceFees(zone),
	}
}

/**
 * A quote's pricing as a zone: the distance fee is already the single fee, and a
 * one-band table keeps the "order size only lowers a distance fee" rule.
 */
function zoneFromPricing(pricing: DeliveryFeePricing): DeliveryFeeZone {
	return {
		deliveryFee: pricing.baseFee,
		minimumOrder: 0,
		feeSteps: pricing.steps,
		distanceFees: pricing.byDistance
			? {
					mode: 'straight_line',
					unit: 'km',
					bands: [{ from: 0, fee: pricing.baseFee }],
				}
			: null,
	}
}

export function deliveryFeeFromPricing(
	pricing: DeliveryFeePricing,
	subtotal: number,
): number {
	return deliveryFeeCentsFor(zoneFromPricing(pricing), toMinor(subtotal), 0) / 100
}

/** The progress toward the next cheaper step, from a quote's pricing. */
export function deliveryProgressFromPricing(
	pricing: DeliveryFeePricing,
	subtotal: number,
): DeliveryFeeProgress {
	return deliveryFeeProgress(zoneFromPricing(pricing), toMinor(subtotal), 0)
}

/** A problem with a fee table, or null when it is fine. */
export type FeeTableProblem =
	| 'steps_not_distinct'
	| 'steps_first_not_minimum'
	| 'steps_too_many'
	| 'bands_not_distinct'
	| 'bands_first_not_zero'
	| 'bands_too_many'

/**
 * The rules for a zone's fee by order size: different thresholds, the first
 * starting at the zone's minimum order (so every order that can be placed has a
 * step), at most ten.
 */
export function validateFeeSteps(
	steps: readonly DeliveryFeeStep[] | null | undefined,
	minimumOrder: number,
): FeeTableProblem | null {
	if (!steps || steps.length === 0) return null
	if (steps.length > MAX_DELIVERY_FEE_STEPS) return 'steps_too_many'
	const froms = steps.map((step) => toMinor(step.from))
	if (new Set(froms).size !== froms.length) return 'steps_not_distinct'
	if (Math.min(...froms) !== toMinor(minimumOrder)) {
		return 'steps_first_not_minimum'
	}
	return null
}

/** The rules for distance bands: different distances, the first from zero. */
export function validateDistanceBands(
	fees: DeliveryDistanceFees | null | undefined,
): FeeTableProblem | null {
	if (!fees || fees.bands.length === 0) return null
	if (fees.bands.length > MAX_DELIVERY_DISTANCE_BANDS) return 'bands_too_many'
	const froms = fees.bands.map((band) => Math.round(band.from * 1000))
	if (new Set(froms).size !== froms.length) return 'bands_not_distinct'
	if (Math.min(...froms) !== 0) return 'bands_first_not_zero'
	return null
}

/** The bands as ranges for display: [from, to) with the last open-ended. */
export function distanceBandRanges(
	fees: DeliveryDistanceFees,
): Array<{ from: number; to: number | null; fee: number }> {
	const bands = [...fees.bands].sort((a, b) => a.from - b.from)
	return bands.map((band, index) => ({
		from: band.from,
		to: bands[index + 1]?.from ?? null,
		fee: band.fee,
	}))
}
