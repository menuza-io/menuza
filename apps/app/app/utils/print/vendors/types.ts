/**
 * Print vendor adapter contract. Every vendor speaks in integer cents (USD in
 * v1) and our own references; nothing a customer typed ever reaches a vendor.
 * The only personal data sent is the operator's shipping recipient.
 */

export const PRINT_VENDORS = ['gelato', 'prodigi', 'mock'] as const
export type PrintVendorName = (typeof PRINT_VENDORS)[number]

export type VendorAddress = {
	name: string
	phone: string
	email: string | null
	line1: string
	line2: string | null
	city: string
	state: string
	postalCode: string
	country: string
}

export type VendorItem = {
	/** Our item id, echoed back by the vendor. */
	reference: string
	sku: string
	/** Printed copies of this file. */
	quantity: number
	/** Signed URL of the print-ready PDF (orders only, not quotes). */
	fileUrl?: string
}

export type VendorQuote = {
	itemsCents: number
	shippingCents: number
	shippingMethod: string
	currency: 'USD'
}

export type VendorOrderState =
	| 'submitted'
	| 'in_production'
	| 'shipped'
	| 'delivered'
	| 'cancelled'
	| 'failed'

export type VendorStatus = {
	state: VendorOrderState
	carrier: string | null
	trackingNumber: string | null
	trackingUrl: string | null
}

export class VendorError extends Error {
	constructor(
		readonly vendor: PrintVendorName,
		readonly code: 'unavailable' | 'rejected' | 'not_configured',
		message: string,
		/** The vendor's HTTP status, when it answered. */
		readonly status?: number,
	) {
		super(message)
		this.name = 'VendorError'
	}
}

export interface PrintVendor {
	readonly name: PrintVendorName
	quote(items: VendorItem[], address: VendorAddress): Promise<VendorQuote>
	createOrder(input: {
		reference: string
		items: VendorItem[]
		address: VendorAddress
		shippingMethod: string
		callbackUrl: string | null
	}): Promise<{ vendorOrderId: string }>
	status(vendorOrderId: string): Promise<VendorStatus>
	/** `too_late` once production started; nothing was cancelled. */
	cancel(vendorOrderId: string): Promise<'cancelled' | 'too_late'>
}

/** Vendor decimal amounts ("12.50", 12.5) to integer cents. */
export function toCents(value: unknown): number {
	const amount =
		typeof value === 'number'
			? value
			: typeof value === 'string'
				? Number.parseFloat(value)
				: Number.NaN
	if (!Number.isFinite(amount) || amount < 0) {
		throw new Error('Invalid vendor amount')
	}
	return Math.round(amount * 100)
}

export function splitName(name: string): { first: string; last: string } {
	const parts = name.trim().split(/\s+/)
	const first = parts.shift() ?? ''
	return { first, last: parts.join(' ') || first }
}
