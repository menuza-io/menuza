import { z } from 'zod'
import { currencySchema, LOYALTY_MAX_MINOR, minorSchema } from './money.ts'
import { loyaltyCatalogIdSchema } from './program.ts'

/**
 * The neutral cart the discount math works on, built by each order channel's
 * adapter from its authoritative priced lines (never from client prices).
 * Amounts are in the same units as the channel's subtotal: tax-inclusive when
 * menu prices include tax.
 */
export const loyaltyCartLineSchema = z
	.object({
		lineId: z.string().min(1).max(100),
		itemId: loyaltyCatalogIdSchema,
		variantId: loyaltyCatalogIdSchema.nullable(),
		/** Every category the item is in; a line never counts twice. */
		categoryIds: z.array(loyaltyCatalogIdSchema).max(50),
		quantity: z.number().int().min(1).max(1000),
		/** One unit of the chosen variant, without modifiers. */
		unitBaseMinor: minorSchema,
		/** One unit including its modifiers. */
		unitMinor: minorSchema,
	})
	.strict()
	.refine((line) => line.unitBaseMinor <= line.unitMinor, {
		message: 'The base price cannot exceed the unit price',
		path: ['unitBaseMinor'],
	})
export type LoyaltyCartLine = z.infer<typeof loyaltyCartLineSchema>

export const loyaltyCartSchema = z
	.object({
		currency: currencySchema,
		lines: z.array(loyaltyCartLineSchema).min(1).max(200),
		/** Discretionary discounts already on the bill; loyalty does not stack with them. */
		otherDiscountMinor: minorSchema.default(0),
	})
	.strict()
	.refine(
		(cart) =>
			new Set(cart.lines.map((line) => line.lineId)).size === cart.lines.length,
		{ message: 'Duplicate line id', path: ['lines'] },
	)
	// Every line is at most quantity times unit price, so no single product
	// leaves the safe integer range, and the subtotal (which is at least each
	// line) stays within the largest money amount loyalty accepts. The discount
	// math sums and multiplies these amounts and can never overflow.
	.refine(
		(cart) =>
			cart.lines.reduce(
				(sum, line: LoyaltyCartLine) => sum + cartLineTotalMinor(line),
				0,
			) <= LOYALTY_MAX_MINOR,
		{
			message: 'The cart total is too large',
			path: ['lines'],
		},
	)
export type LoyaltyCart = z.infer<typeof loyaltyCartSchema>

export function cartLineTotalMinor(line: LoyaltyCartLine): number {
	return line.unitMinor * line.quantity
}

export function cartSubtotalMinor(cart: Pick<LoyaltyCart, 'lines'>): number {
	return cart.lines.reduce((sum, line) => sum + cartLineTotalMinor(line), 0)
}

/**
 * Canonical text of a cart: what a redemption is bound to. Line order is kept
 * (it decides allocation tie-breaks); category order is not significant.
 */
export function canonicalLoyaltyCart(cart: LoyaltyCart): string {
	return JSON.stringify([
		cart.currency,
		cart.otherDiscountMinor,
		cart.lines.map((line) => [
			line.lineId,
			line.itemId,
			line.variantId,
			[...line.categoryIds].sort(),
			line.quantity,
			line.unitBaseMinor,
			line.unitMinor,
		]),
	])
}

/** SHA-256 (hex) of the canonical cart. Web Crypto: Workers, Node and browsers. */
export async function hashLoyaltyCart(cart: LoyaltyCart): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalLoyaltyCart(cart))
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}
