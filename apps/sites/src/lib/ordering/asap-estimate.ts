import {
	isLocationOpenForOrdering,
	locationDeliveryArrivalMinutes,
} from '@repo/common/location-availability'
import {
	largeOrderExtraMinutes,
	type LargeOrderRule,
} from '@repo/common/promised-time'

type EstimateLocation = Parameters<typeof isLocationOpenForOrdering>[0]

export type AsapEstimateInput = {
	location: EstimateLocation
	now: Date
	/** Delivery range from a quote for the same location, when there is one. */
	travel?: { min: number; max: number } | null
	/** `ordering.largeOrder` of the region's options (null: no rule known). */
	largeOrder: LargeOrderRule | null
	/** Item subtotal in major currency units (what the cart sums). */
	subtotal: number
	/** Total item quantity. */
	itemCount: number
}

/**
 * The ASAP times checkout shows, computed with the same functions the region
 * uses for the promise it stores (`computePromisedTime`): prep + busy minutes
 * + the large-order extra (when this cart is over the threshold), plus the
 * delivery range for delivery. Minutes from now.
 */
export function asapEstimate(input: AsapEstimateInput): {
	pickupMinutes: number
	delivery: { min: number; max: number }
	largeOrderExtra: number
} {
	const extra = largeOrderExtraMinutes(input.largeOrder, {
		subtotalCents: Math.round(input.subtotal * 100),
		itemCount: input.itemCount,
	})
	return {
		pickupMinutes:
			isLocationOpenForOrdering(input.location, input.now).estimatedPrepTime +
			extra,
		delivery: locationDeliveryArrivalMinutes(input.location, input.now, {
			travel: input.travel,
			largeOrderExtraMinutes: extra,
		}),
		largeOrderExtra: extra,
	}
}
