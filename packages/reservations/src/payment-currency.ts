/**
 * The currencies each online processor settles for reservation payments. One
 * definition for both sides: the App refuses to open a checkout in any other
 * currency, and the region refuses to create a payable booking in one (a hold
 * the guest could never pay would otherwise sit in `pending_payment`).
 * `connect` is Stripe Connect; SAR never goes to Stripe.
 */
export type ReservationPaymentProcessor = 'connect' | 'checkout'

const SETTLED_CURRENCIES: Record<
	ReservationPaymentProcessor,
	ReadonlySet<string>
> = {
	connect: new Set(['USD', 'CAD']),
	checkout: new Set(['SAR', 'USD']),
}

export function processorSettlesCurrency(
	processor: ReservationPaymentProcessor,
	currency: string,
): boolean {
	return SETTLED_CURRENCIES[processor].has(currency.toUpperCase())
}
