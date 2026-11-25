import {
	deliveryFeeFromPricing,
	deliveryProgressFromPricing,
	type DeliveryFeePricing,
} from '@repo/common/delivery-fees'

/**
 * The delivery fee for the cart on screen (#244): the verified address's
 * pricing worked out with the same `@repo/common` rule the region uses at
 * placement, so the fee shown is the fee charged. Details saved before fee
 * tables existed carry no pricing and keep their single fee.
 */

type DeliveryWithFee = {
	deliveryFee: number
	pricing?: DeliveryFeePricing
}

/** The fee in major units for an items subtotal (before discounts, tax and tip). */
export function deliveryFeeForCart(
	delivery: DeliveryWithFee | null | undefined,
	subtotal: number,
): number {
	if (!delivery) return 0
	if (!delivery.pricing) return delivery.deliveryFee
	return deliveryFeeFromPricing(delivery.pricing, Math.max(0, subtotal))
}

export type DeliveryFeeHint = {
	/** How much more the guest adds to reach the next cheaper step, major units. */
	remaining: number
	/** The fee from that step, major units; 0 is free delivery. */
	fee: number
}

/** "Add 6.00 more for free delivery": the next cheaper step, or null. */
export function deliveryFeeHint(
	delivery: DeliveryWithFee | null | undefined,
	subtotal: number,
): DeliveryFeeHint | null {
	if (!delivery?.pricing || subtotal <= 0) return null
	const { next } = deliveryProgressFromPricing(delivery.pricing, subtotal)
	return next
		? { remaining: next.remainingCents / 100, fee: next.feeCents / 100 }
		: null
}

/**
 * The items subtotal of the cart saved in this browser, major units (0 when
 * empty or unreadable). The order details sheet uses it to show the fee for the
 * cart in hand when it asks which store delivers (#161, #244).
 */
export function readCartSubtotal(
	orgId: string,
	storage: Pick<Storage, 'getItem'> | null = typeof localStorage ===
	'undefined'
		? null
		: localStorage,
): number {
	try {
		const raw = storage?.getItem(`menuza_cart_${orgId}`)
		if (!raw) return 0
		const lines: unknown = JSON.parse(raw)
		if (!Array.isArray(lines)) return 0
		return lines.reduce((sum: number, line: unknown) => {
			const l = line as { unitPrice?: unknown; quantity?: unknown }
			return typeof l?.unitPrice === 'number' &&
				typeof l?.quantity === 'number' &&
				Number.isFinite(l.unitPrice * l.quantity)
				? sum + l.unitPrice * l.quantity
				: sum
		}, 0)
	} catch {
		return 0
	}
}
