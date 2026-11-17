import { z } from 'zod'

export const ORDER_TOO_LARGE_CODE = 'order_too_large'

const capMinor = z.number().int().min(1).max(10_000_000).nullable()

export const orderCapRuleSchema = z.strictObject({
	/** Maximum subtotal before discounts and tips, minor units; null is no cap. */
	maxSubtotalMinor: capMinor.optional(),
	/** Dine-in only: maximum head count; null is no cap. */
	maxGuests: z.number().int().min(1).max(500).nullable().optional(),
})

export type OrderCapRule = z.infer<typeof orderCapRuleSchema>

export const orderCapsSettingsSchema = z.strictObject({
	pickup: orderCapRuleSchema.optional(),
	delivery: orderCapRuleSchema.optional(),
	dineIn: z
		.strictObject({
			maxGuests: z.number().int().min(1).max(500).nullable(),
		})
		.optional(),
})

export type OrderCapsSettings = z.infer<typeof orderCapsSettingsSchema>

export function parseOrderCapsSettings(raw: unknown): OrderCapsSettings | null {
	if (raw == null || raw === '') return null
	let candidate: unknown = raw
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate)
		} catch {
			return null
		}
	}
	const parsed = orderCapsSettingsSchema.safeParse(candidate)
	return parsed.success ? parsed.data : null
}

export type OrderCapViolation = {
	code: 'order_too_large'
	fulfillment: 'pickup' | 'delivery' | 'dine_in'
	/** What was exceeded so the message can point to catering or phone, not the cap. */
	kind: 'amount' | 'guests'
}

export function readOrderCapsForLocation(
	raw: unknown,
	locationId: string,
): OrderCapsSettings | null {
	if (raw == null) return null
	let record: Record<string, unknown>
	if (typeof raw === 'object' && raw !== null && 'locations' in raw) {
		const nested = (raw as { locations?: Record<string, unknown> }).locations
		if (!nested) return null
		record = nested
	} else if (typeof raw === 'object' && !Array.isArray(raw)) {
		record = raw as Record<string, unknown>
	} else {
		return null
	}
	const entry = record[locationId]
	return parseOrderCapsSettings(entry)
}

export function checkOrderCaps(input: {
	settings: OrderCapsSettings | null
	fulfillment: 'pickup' | 'delivery' | 'dine_in'
	subtotalCents: number
	guestCount?: number | null
}): OrderCapViolation | null {
	const { settings, fulfillment, subtotalCents } = input
	if (!settings) return null
	const rule =
		fulfillment === 'pickup'
			? settings.pickup
			: fulfillment === 'delivery'
				? settings.delivery
				: settings.dineIn
	if (!rule) return null
	const maxSub =
		fulfillment === 'dine_in'
			? undefined
			: (rule as OrderCapRule).maxSubtotalMinor
	if (maxSub != null && subtotalCents > maxSub) {
		return { code: 'order_too_large', fulfillment, kind: 'amount' }
	}
	const guests =
		fulfillment === 'dine_in'
			? settings.dineIn?.maxGuests
			: (rule as OrderCapRule).maxGuests
	if (guests != null && (input.guestCount ?? 0) > guests) {
		return { code: 'order_too_large', fulfillment, kind: 'guests' }
	}
	return null
}
