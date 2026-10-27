import { z } from 'zod'

/** Mirrors operatorOrder() in apps/tenant-api/src/services/order-service.ts. */
export const orderSchema = z.object({
	id: z.string(),
	/** `c_<id>` or `g_<id>` person key, null for a guest checkout (or no access). */
	customerKey: z.string().nullable().optional(),
	number: z.string(),
	status: z.string(),
	paymentStatus: z.string(),
	paymentMethod: z.enum(['handoff', 'online']),
	paymentProcessor: z.string().nullable().optional(),
	subtotalCents: z.number().int().optional(),
	taxCents: z.number().int().optional(),
	deliveryFeeCents: z.number().int().optional(),
	tipCents: z.number().int().optional(),
	tipPercent: z.number().nullable().optional(),
	totalCents: z.number().int(),
	currency: z.string(),
	createdAt: z.string().nullable(),
	paidAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	cancelledAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
	contact: z.object({
		name: z.string(),
		phone: z.string(),
		email: z.string().nullable(),
	}),
	fulfillment: z.string(),
	location: z.object({ id: z.string(), name: z.string() }),
	lines: z.array(
		z.object({
			itemName: z.string(),
			quantity: z.number(),
			unitPriceCents: z.number(),
			totalCents: z.number(),
			instructions: z.string().nullable(),
			options: z.array(
				z.object({
					optionName: z.string(),
					quantity: z.number(),
				}),
			),
		}),
	),
	pickup: z
		.object({
			date: z.string(),
			time: z.string(),
			timezone: z.string(),
		})
		.nullable(),
	drop: z.object({ slug: z.string() }).nullable(),
	/** QR dine-in round: the table and the tab it belongs to. */
	table: z.object({ id: z.string(), label: z.string() }).nullable().optional(),
	tabId: z.string().nullable().optional(),
	source: z.string().nullable().optional(),
	delivery: z
		.object({
			address: z.string(),
			city: z.string().nullable(),
			unit: z.string().nullable(),
			postalCode: z.string().nullable().optional(),
			notes: z.string().nullable(),
			feeCents: z.number().int().nullable().optional(),
		})
		.nullable(),
})
export type Order = z.infer<typeof orderSchema>

/**
 * Receipt lines preserve every catalog locale as a JSON map string
 * (`{"en":"…","ar":"…"}`). Operators read them in their own locale.
 */
export function localizedName(value: string, locale: string): string {
	if (!value.startsWith('{')) return value
	try {
		const parsed: unknown = JSON.parse(value)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>
			const picked =
				record[locale] ??
				record[locale.split('-')[0] ?? ''] ??
				record.en ??
				Object.values(record).find((entry) => typeof entry === 'string')
			if (typeof picked === 'string') return picked
		}
	} catch {
		// Not a locale map; fall through to the raw value.
	}
	return value
}

export function formatMoney(
	cents: number,
	currency: string,
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(cents / 100)
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`
	}
}

/** Next forward step for the primary button, or undefined when there is none. */
export function nextOrderStatus(status: string): string | undefined {
	return (
		{
			accepted: 'preparing',
			preparing: 'ready',
			ready: 'completed',
			// Late payment: the operator decides to honour the order.
			payment_review: 'preparing',
		} as Record<string, string>
	)[status]
}

export const CLOSED_ORDER_STATUSES = ['completed', 'cancelled', 'expired']

export function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean)
	if (parts.length === 0) return '?'
	const first = Array.from(parts[0] ?? '')[0] ?? ''
	const last = parts.length > 1 ? Array.from(parts.at(-1) ?? '')[0] : ''
	return `${first}${last ?? ''}`.toUpperCase()
}

/** "3 min ago" style hint; empty when the date is invalid. */
export function relativeTime(
	iso: string | null | undefined,
	locale: string,
	now: number = Date.now(),
): string {
	if (!iso) return ''
	const time = new Date(iso).getTime()
	if (Number.isNaN(time)) return ''
	const seconds = Math.round((time - now) / 1000)
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		['year', 31536000],
		['month', 2592000],
		['day', 86400],
		['hour', 3600],
		['minute', 60],
	]
	try {
		const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
		for (const [unit, size] of units) {
			if (Math.abs(seconds) >= size)
				return formatter.format(Math.round(seconds / size), unit)
		}
		return formatter.format(0, 'second')
	} catch {
		return ''
	}
}

export function formatDateTime(
	iso: string | null | undefined,
	locale: string,
): string {
	if (!iso) return ''
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ''
	try {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(date)
	} catch {
		return date.toLocaleString()
	}
}
