import { z } from 'zod'

/**
 * What prints on each ticket type, and when (#363). Per location, an owner
 * chooses which fields show on the guest receipt, the kitchen station ticket,
 * the assembly (expo) ticket and the item label, which are bold or larger,
 * when tickets print, and how adjusted and cancelled orders print.
 *
 * Nothing set means exactly what Station printed before this existed: every
 * field shows, plain, printed by hand, in full, with no cancellation slip. A
 * field the law or the till's own records need (the VAT number and invoice
 * lines, the items, the tax and the total) is `locked`: it can be made bold or
 * larger, never hidden.
 *
 * The Station print path and the App's live preview read the same registry
 * (`TICKET_FIELDS`) and the same resolver, so a field hidden here is hidden in
 * both.
 */

export const TICKET_TYPES = ['receipt', 'kitchen', 'assembly', 'label'] as const
export type TicketType = (typeof TICKET_TYPES)[number]

export type TicketFieldDef = {
	key: string
	/** Always shown: a legal or structural part of the ticket. */
	locked?: boolean
}

const f = (key: string, locked = false): TicketFieldDef => ({
	key,
	...(locked ? { locked: true } : {}),
})

/**
 * Fields in print order. The guest receipt is one type for the till's receipt
 * and the online order's guest ticket. The kitchen ticket's paid/unpaid line,
 * modifier group names and order-type colour stay in Kitchen setup (#420).
 */
export const TICKET_FIELDS: Record<TicketType, readonly TicketFieldDef[]> = {
	receipt: [
		f('businessName'),
		f('vatNumber', true),
		f('invoiceTitle', true),
		f('dateTime'),
		f('orderNumber'),
		f('invoiceNumber', true),
		f('orderType'),
		f('guestContact'),
		f('servedBy'),
		f('items', true),
		f('itemOptions'),
		f('itemNotes'),
		f('subtotal'),
		f('discounts'),
		f('tax', true),
		f('tip'),
		f('total', true),
		f('payments'),
		f('change'),
		f('refunds'),
		f('balanceDue'),
		f('qrCode', true),
		f('thankYou'),
	],
	kitchen: [
		f('ticketTitle'),
		f('dateTime'),
		f('orderNumber'),
		f('orderType'),
		f('utensils'),
		f('largeOrder'),
		f('courses'),
		f('items', true),
		f('itemOptions'),
		f('itemNotes'),
		f('highlights'),
	],
	assembly: [
		f('ticketTitle'),
		f('orderNumber'),
		f('orderType'),
		f('dateTime'),
		f('guestName'),
		f('items', true),
		f('itemOptions'),
		f('itemNotes'),
		f('paymentStatus'),
	],
	label: [
		f('itemName', true),
		f('itemOptions'),
		f('itemNotes'),
		f('orderNumber'),
		f('orderType'),
		f('dateTime'),
		f('count'),
	],
}

/** Which of the four have a print path in Station today. */
export const TICKET_TYPES_PRINTED_TODAY: readonly TicketType[] = [
	'receipt',
	'kitchen',
]

export const RECEIPT_PRINT_TIMINGS = ['manual', 'on_close'] as const
export const KITCHEN_PRINT_TIMINGS = [
	'manual',
	'on_acceptance',
	'when_ready',
] as const
export type ReceiptPrintTiming = (typeof RECEIPT_PRINT_TIMINGS)[number]
export type KitchenPrintTiming = (typeof KITCHEN_PRINT_TIMINGS)[number]

const fieldSchema = z
	.strictObject({
		show: z.boolean().optional(),
		bold: z.boolean().optional(),
		large: z.boolean().optional(),
	})
	.catch({})

const typeSchema = z
	.record(z.string().max(40), fieldSchema)
	.catch({})
	.optional()

export const ticketsConfigSchema = z.object({
	receipt: typeSchema,
	kitchen: typeSchema,
	assembly: typeSchema,
	label: typeSchema,
	when: z
		.object({
			receipt: z.enum(RECEIPT_PRINT_TIMINGS).catch('manual').optional(),
			kitchen: z.enum(KITCHEN_PRINT_TIMINGS).catch('manual').optional(),
		})
		.catch({})
		.optional(),
	/** Dine-in orders are left out of every print. */
	excludeDineIn: z.boolean().catch(false).optional(),
	/** An adjusted order prints only what changed. */
	changesOnly: z.boolean().catch(false).optional(),
	/** Dishes already served are struck through on a reprint. */
	strikeCompleted: z.boolean().catch(false).optional(),
	/** A cancelled order prints a cancellation slip. */
	cancellationSlip: z.boolean().catch(false).optional(),
})

export type TicketsConfig = z.infer<typeof ticketsConfigSchema>

export type TicketFieldStyle = { show: boolean; bold: boolean; large: boolean }

export type ResolvedTickets = {
	raw: TicketsConfig
	when: { receipt: ReceiptPrintTiming; kitchen: KitchenPrintTiming }
	excludeDineIn: boolean
	changesOnly: boolean
	strikeCompleted: boolean
	cancellationSlip: boolean
}

/** Reads a stored value (a JSON string, an object or nothing) as a config; bad parts read as the defaults. */
export function resolveTickets(raw: unknown): ResolvedTickets {
	let value: unknown = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw)
		} catch {
			value = null
		}
	}
	const parsed = ticketsConfigSchema.safeParse(
		value && typeof value === 'object' ? value : {},
	)
	const config: TicketsConfig = parsed.success ? parsed.data : {}
	return {
		raw: config,
		when: {
			receipt: config.when?.receipt ?? 'manual',
			kitchen: config.when?.kitchen ?? 'manual',
		},
		excludeDineIn: config.excludeDineIn === true,
		changesOnly: config.changesOnly === true,
		strikeCompleted: config.strikeCompleted === true,
		cancellationSlip: config.cancellationSlip === true,
	}
}

export const DEFAULT_TICKETS = resolveTickets(null)

/** How one field prints. A locked field is always shown. */
export function fieldStyle(
	tickets: ResolvedTickets | null | undefined,
	type: TicketType,
	key: string,
): TicketFieldStyle {
	const def = TICKET_FIELDS[type].find((field) => field.key === key)
	const set = tickets?.raw[type]?.[key]
	return {
		show: def?.locked ? true : set?.show !== false,
		bold: set?.bold === true,
		large: set?.large === true,
	}
}

/** The classes a styled field adds; empty for a plain field, so default markup is unchanged. */
export function fieldClasses(style: TicketFieldStyle): string {
	return [style.bold ? 'font-bold' : '', style.large ? 'text-base' : '']
		.filter(Boolean)
		.join(' ')
}

/** The fields of a type in print order that show. */
export function visibleFields(
	tickets: ResolvedTickets | null | undefined,
	type: TicketType,
): string[] {
	return TICKET_FIELDS[type]
		.filter((field) => fieldStyle(tickets, type, field.key).show)
		.map((field) => field.key)
}

/** Whether an order of this kind may be printed at all (dine-in can be left out). */
export function printAllowed(
	tickets: ResolvedTickets | null | undefined,
	orderType: 'dine_in' | 'takeaway' | 'drive_through' | 'delivery' | 'pickup',
): boolean {
	return !(tickets?.excludeDineIn && orderType === 'dine_in')
}

/** What a stored config looks like once saved: only what differs from the defaults. */
export function compactTickets(config: TicketsConfig): TicketsConfig {
	const out: TicketsConfig = {}
	for (const type of TICKET_TYPES) {
		const fields: Record<
			string,
			{ show?: boolean; bold?: boolean; large?: boolean }
		> = {}
		const known = new Set(TICKET_FIELDS[type].map((field) => field.key))
		for (const [key, value] of Object.entries(config[type] ?? {})) {
			if (!known.has(key)) continue
			const entry: { show?: boolean; bold?: boolean; large?: boolean } = {}
			const locked = TICKET_FIELDS[type].find((d) => d.key === key)?.locked
			if (value.show === false && !locked) entry.show = false
			if (value.bold === true) entry.bold = true
			if (value.large === true) entry.large = true
			if (Object.keys(entry).length > 0) fields[key] = entry
		}
		if (Object.keys(fields).length > 0) out[type] = fields
	}
	const when: NonNullable<TicketsConfig['when']> = {}
	if (config.when?.receipt && config.when.receipt !== 'manual')
		when.receipt = config.when.receipt
	if (config.when?.kitchen && config.when.kitchen !== 'manual')
		when.kitchen = config.when.kitchen
	if (Object.keys(when).length > 0) out.when = when
	if (config.excludeDineIn) out.excludeDineIn = true
	if (config.changesOnly) out.changesOnly = true
	if (config.strikeCompleted) out.strikeCompleted = true
	if (config.cancellationSlip) out.cancellationSlip = true
	return out
}
