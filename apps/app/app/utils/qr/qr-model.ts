import { z } from 'zod'

/** Mirrors the views of apps/tenant-api/src/services/qr-tab-service.ts. */
export const qrTableSchema = z.object({
	id: z.string(),
	locationId: z.string(),
	label: z.string(),
	tokenVersion: z.number().int(),
	token: z.string().nullable(),
	importedRsvTableId: z.string().nullable(),
	archivedAt: z.string().nullable(),
	openTabId: z.string().nullable(),
})
export type QrTable = z.infer<typeof qrTableSchema>

export const qrSettingsSchema = z.object({
	requireGuestName: z.boolean(),
	requireGuestPhone: z.boolean(),
	allowOnlineTabPay: z.boolean(),
	perTableLimitPerHour: z.number().int(),
})
export type QrSettings = z.infer<typeof qrSettingsSchema>

const roundSchema = z.object({
	id: z.string(),
	number: z.string(),
	status: z.string(),
	createdAt: z.string().nullable(),
	totalCents: z.number().int(),
	lines: z.array(
		z.object({
			itemName: z.string(),
			quantity: z.number(),
			totalCents: z.number(),
		}),
	),
})

export const qrTabSchema = z.object({
	id: z.string(),
	tabNumber: z.string(),
	status: z.enum(['open', 'closed', 'cancelled']),
	paymentStatus: z.string(),
	paymentMethod: z.enum(['counter', 'online']).nullable(),
	table: z.object({
		id: z.string(),
		label: z.string(),
		locationId: z.string(),
	}),
	openedAt: z.string(),
	closedAt: z.string().nullable(),
	guestName: z.string().nullable(),
	lockedAt: z.string().nullable(),
	voidReason: z.string().nullable(),
	/** What the guest paid online; set while a payment is open or in review. */
	onlineAmountCents: z.number().int().nullable().optional(),
	rounds: z.array(roundSchema),
	roundsPending: z.boolean(),
	totals: z.object({
		currency: z.string(),
		subtotalCents: z.number().int(),
		taxCents: z.number().int(),
		tipCents: z.number().int(),
		totalCents: z.number().int(),
	}),
})
export type QrTab = z.infer<typeof qrTabSchema>

export const MAX_TABLES_PER_ADD = 200

export type TableLabelPlan = {
	labels: string[]
	/** Why the input cannot be added as typed; null when it can. */
	problem: 'reversed_range' | 'range_too_large' | 'too_many' | null
}

/**
 * What "Add tables" will create, with the reason when the input would not do
 * what it looks like (a reversed or oversized range, more than 200 tables).
 */
export function planTableLabels(input: string): TableLabelPlan {
	let problem: TableLabelPlan['problem'] = null
	let count = 0
	for (const part of input.split(/[,\n]/)) {
		const value = part.trim()
		if (!value) continue
		const range = /^(\D*)(\d{1,4})\s*-\s*\1?(\d{1,4})$/.exec(value)
		if (range) {
			const start = Number(range[2])
			const end = Number(range[3])
			if (end < start) problem ??= 'reversed_range'
			else if (end - start >= MAX_TABLES_PER_ADD) problem ??= 'range_too_large'
			else count += end - start + 1
			continue
		}
		count += 1
	}
	if (count > MAX_TABLES_PER_ADD) problem ??= 'too_many'
	return { labels: problem ? [] : expandTableLabels(input), problem }
}

/** "T1-T12" or "1-12" → T1 … T12 (at most 200). Anything else is one label. */
export function expandTableLabels(input: string): string[] {
	const labels: string[] = []
	for (const part of input.split(/[,\n]/)) {
		const value = part.trim()
		if (!value) continue
		const range = /^(\D*)(\d{1,4})\s*-\s*\1?(\d{1,4})$/.exec(value)
		if (range) {
			const [, prefix = '', from, to] = range
			const start = Number(from)
			const end = Number(to)
			if (end >= start && end - start < 200) {
				for (let n = start; n <= end; n += 1) labels.push(`${prefix}${n}`)
				continue
			}
		}
		labels.push(value)
	}
	return [...new Set(labels)].slice(0, 200)
}
