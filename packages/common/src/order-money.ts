/**
 * "What you get paid" order money breakdown (#288).
 *
 * Pure function shared by Settings → Payments → What you get paid and tests.
 * Reuses the exact checkout pricing helpers (`computeServiceFee`, `computeTip`)
 * so the "What the guest pays" column always matches checkout for the same order.
 */

import { computeTip } from './order-tips.ts'
import {
	computeServiceFee,
	type ServiceFeeFulfillment,
	type ServiceFeeSettings,
} from './service-fee.ts'

export type OrderMoneyOrderType = 'pickup' | 'delivery' | 'in_store'
export type OrderMoneyPaymentMethod = 'card' | 'cash'
export type FeePayer = 'guest' | 'restaurant'

export type OrderMoneyInput = {
	/** Order subtotal in minor units (e.g. cents). */
	subtotalCents: number
	orderType: OrderMoneyOrderType
	paymentMethod: OrderMoneyPaymentMethod
	/** Tip in minor units (when exact amount) or null. */
	tipCents?: number | null
	/** Tip percentage (0..30), used when tipCents is omitted/null. */
	tipPercent?: number | null
}

export type OrderMoneySettings = {
	currency: string
	/** Sales tax / VAT rate in basis points (e.g. 825 = 8.25%). */
	taxRateBp: number
	/** True when menu prices already include tax (e.g. KSA VAT). */
	pricesIncludeTax: boolean
	/** Location's service fee settings (reuses `computeServiceFee`). */
	serviceFee?: ServiceFeeSettings | null
	/** Delivery fee in minor units for delivery orders. */
	deliveryFeeCents?: number
	/** Who pays the delivery fee ('guest' adds to guest total; 'restaurant' absorbs it). */
	deliveryFeePayer?: FeePayer
	/** Optional card surcharge in basis points when enabled. */
	surchargeBp?: number
	/** Who pays the card processing fee ('restaurant' default, or 'guest' via surcharge). */
	cardFeePayer?: FeePayer
	/** Courier / own-driver cost borne by the restaurant on delivery orders. */
	courierCostCents?: number
}

export type OrderMoneyRates = {
	/** Card processing percentage in basis points (e.g. 290 = 2.9%). */
	cardProcessingBp: number
	/** Card processing fixed fee in minor units (e.g. 30 = $0.30). */
	cardProcessingFixedCents: number
	/** Menuza platform fee in basis points (e.g. 0, or 200 = 2.0%). */
	platformFeeBp: number
}

export type OrderMoneyLineKind =
	| 'subtotal'
	| 'tax'
	| 'service_fee'
	| 'delivery_fee'
	| 'surcharge'
	| 'tip'
	| 'gross_collected'
	| 'card_processing'
	| 'platform_fee'
	| 'courier_cost'

export type OrderMoneyLine = {
	kind: OrderMoneyLineKind
	label: string
	/** Positive for additions/revenue, negative for deductions. */
	amountCents: number
}

export type OrderMoneyExplanation = {
	currency: string
	guest: {
		lines: OrderMoneyLine[]
		totalCents: number
	}
	restaurant: {
		lines: OrderMoneyLine[]
		netPayoutCents: number
	}
	/** Convenience totals matching checkout fields. */
	breakdown: {
		subtotalCents: number
		taxCents: number
		serviceFeeCents: number
		serviceFeeTaxCents: number
		deliveryFeeCents: number
		surchargeCents: number
		tipCents: number
		guestTotalCents: number
		cardProcessingFeeCents: number
		platformFeeCents: number
		courierCostCents: number
		netPayoutCents: number
	}
}

function toServiceFeeFulfillment(
	orderType: OrderMoneyOrderType,
): ServiceFeeFulfillment {
	if (orderType === 'delivery') return 'delivery'
	if (orderType === 'in_store') return 'dine_in'
	return 'pickup'
}

/**
 * Compute tax on a base amount using the exact rounding used at checkout:
 * - Tax-exclusive: `Math.round(base * taxRateBp / 10_000)` added on top.
 * - Tax-inclusive: `base - Math.round(base * 10_000 / (10_000 + taxRateBp))`
 *   already included inside `base`.
 */
export function computeOrderTaxCents(
	baseCents: number,
	taxRateBp: number,
	pricesIncludeTax: boolean,
): number {
	const safeBase = Math.max(0, Math.round(baseCents))
	const safeRate = Math.max(0, Math.round(taxRateBp))
	if (safeBase === 0 || safeRate === 0) return 0
	if (pricesIncludeTax) {
		return safeBase - Math.round((safeBase * 10_000) / (10_000 + safeRate))
	}
	return Math.round((safeBase * safeRate) / 10_000)
}

export function explainOrderMoney(
	input: OrderMoneyInput,
	settings: OrderMoneySettings,
	rates: OrderMoneyRates,
): OrderMoneyExplanation {
	const subtotalCents = Math.max(0, Math.round(input.subtotalCents))
	const currency = (settings.currency || 'USD').toUpperCase()
	const taxRateBp = Math.max(0, Math.round(settings.taxRateBp || 0))
	const pricesIncludeTax = Boolean(settings.pricesIncludeTax)
	const deliveryFeePayer: FeePayer = settings.deliveryFeePayer ?? 'guest'
	const cardFeePayer: FeePayer = settings.cardFeePayer ?? 'restaurant'

	// 1. Service fee via the exact checkout helper (`computeServiceFee`).
	const fulfillment = toServiceFeeFulfillment(input.orderType)
	const serviceFeeResult =
		input.orderType === 'in_store'
			? { feeCents: 0, taxCents: 0 }
			: computeServiceFee({
					settings: settings.serviceFee ?? null,
					fulfillment,
					baseCents: subtotalCents,
					taxRatePercent: taxRateBp / 100,
					taxInclusive: pricesIncludeTax,
				})
	const serviceFeeCents = serviceFeeResult.feeCents
	const serviceFeeTaxCents = serviceFeeResult.taxCents

	// 2. Subtotal tax + service fee tax.
	const subtotalTaxCents = computeOrderTaxCents(
		subtotalCents,
		taxRateBp,
		pricesIncludeTax,
	)
	const taxCents = subtotalTaxCents + serviceFeeTaxCents

	// 3. Delivery fee (delivery orders only).
	const rawDeliveryFeeCents =
		input.orderType === 'delivery'
			? Math.max(0, Math.round(settings.deliveryFeeCents ?? 0))
			: 0
	const guestDeliveryFeeCents =
		deliveryFeePayer === 'guest' ? rawDeliveryFeeCents : 0

	// 4. Tip via the exact checkout helper (`computeTip`).
	let tipCents = 0
	if (typeof input.tipCents === 'number' && Number.isFinite(input.tipCents)) {
		tipCents = Math.max(0, Math.round(input.tipCents))
	} else if (
		typeof input.tipPercent === 'number' &&
		Number.isFinite(input.tipPercent) &&
		input.tipPercent > 0
	) {
		const tipResult = computeTip({
			tip: { percent: Math.min(30, Math.max(0, Math.round(input.tipPercent))) },
			subtotalCents,
			currency,
		})
		tipCents = tipResult.ok ? tipResult.tipCents : 0
	}

	// 5. Base total before optional card surcharge.
	const preSurchargeTotalCents = pricesIncludeTax
		? subtotalCents + serviceFeeCents + guestDeliveryFeeCents + tipCents
		: subtotalCents +
			taxCents +
			serviceFeeCents +
			guestDeliveryFeeCents +
			tipCents

	// 6. Optional card surcharge (card payments only).
	const effectiveSurchargeBp =
		input.paymentMethod === 'card'
			? cardFeePayer === 'guest'
				? Math.max(
						0,
						Math.round(settings.surchargeBp || rates.cardProcessingBp),
					)
				: Math.max(0, Math.round(settings.surchargeBp ?? 0))
			: 0
	const surchargeCents =
		effectiveSurchargeBp > 0 && preSurchargeTotalCents > 0
			? Math.round((preSurchargeTotalCents * effectiveSurchargeBp) / 10_000)
			: 0

	const guestTotalCents = preSurchargeTotalCents + surchargeCents

	// 7. Build "What the guest pays" column (hidden lines omitted when 0).
	const guestLines: OrderMoneyLine[] = [
		{ kind: 'subtotal', label: 'Subtotal', amountCents: subtotalCents },
	]
	if (taxCents > 0) {
		guestLines.push({
			kind: 'tax',
			label: pricesIncludeTax ? 'Tax (included)' : 'Tax',
			amountCents: taxCents,
		})
	}
	if (serviceFeeCents > 0) {
		guestLines.push({
			kind: 'service_fee',
			label: settings.serviceFee?.label ?? 'Service fee',
			amountCents: serviceFeeCents,
		})
	}
	if (guestDeliveryFeeCents > 0) {
		guestLines.push({
			kind: 'delivery_fee',
			label: 'Delivery fee',
			amountCents: guestDeliveryFeeCents,
		})
	}
	if (surchargeCents > 0) {
		guestLines.push({
			kind: 'surcharge',
			label: 'Card surcharge',
			amountCents: surchargeCents,
		})
	}
	if (tipCents > 0) {
		guestLines.push({ kind: 'tip', label: 'Tip', amountCents: tipCents })
	}

	// 8. Restaurant deductions (card processing, platform fee, courier cost).
	const cardProcessingFeeCents =
		input.paymentMethod === 'card' && guestTotalCents > 0
			? Math.round(
					(guestTotalCents * Math.max(0, rates.cardProcessingBp)) / 10_000,
				) + Math.max(0, Math.round(rates.cardProcessingFixedCents))
			: 0

	const platformFeeCents =
		input.paymentMethod === 'card' &&
		guestTotalCents > 0 &&
		rates.platformFeeBp > 0
			? Math.round((guestTotalCents * rates.platformFeeBp) / 10_000)
			: 0

	// Courier cost: restaurant pays explicit courierCostCents, plus any
	// delivery fee the restaurant chose to absorb instead of charging the guest.
	const absorbedDeliveryFee =
		deliveryFeePayer === 'restaurant' ? rawDeliveryFeeCents : 0
	const courierCostCents =
		input.orderType === 'delivery'
			? Math.max(0, Math.round(settings.courierCostCents ?? 0)) +
				absorbedDeliveryFee
			: 0

	const netPayoutCents =
		guestTotalCents -
		cardProcessingFeeCents -
		platformFeeCents -
		courierCostCents

	// 9. Build "What you receive" column (hidden lines omitted when 0).
	const restaurantLines: OrderMoneyLine[] = [
		{
			kind: 'gross_collected',
			label: 'Collected from guest',
			amountCents: guestTotalCents,
		},
	]
	if (cardProcessingFeeCents > 0) {
		restaurantLines.push({
			kind: 'card_processing',
			label: 'Card processing fee',
			amountCents: -cardProcessingFeeCents,
		})
	}
	if (platformFeeCents > 0) {
		restaurantLines.push({
			kind: 'platform_fee',
			label: 'Platform fee',
			amountCents: -platformFeeCents,
		})
	}
	if (courierCostCents > 0) {
		restaurantLines.push({
			kind: 'courier_cost',
			label: 'Courier / delivery cost',
			amountCents: -courierCostCents,
		})
	}

	return {
		currency,
		guest: {
			lines: guestLines,
			totalCents: guestTotalCents,
		},
		restaurant: {
			lines: restaurantLines,
			netPayoutCents,
		},
		breakdown: {
			subtotalCents,
			taxCents,
			serviceFeeCents,
			serviceFeeTaxCents,
			deliveryFeeCents: guestDeliveryFeeCents,
			surchargeCents,
			tipCents,
			guestTotalCents,
			cardProcessingFeeCents,
			platformFeeCents,
			courierCostCents,
			netPayoutCents,
		},
	}
}
