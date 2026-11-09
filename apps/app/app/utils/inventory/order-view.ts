import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	type OrderDetail,
	type OrderLine,
	type OrderSendChannel,
	type OrderTextLocale,
	type OrderStatus,
	orderTotalMinor,
	PRICED_BY_WEIGHT_PACK_STEP_MILLI,
	shortOfMinimumMinor,
	type SupplierOrderChannel,
} from '@repo/inventory'

/**
 * The Review order page as pure functions: what a line's stepper does, what
 * the order comes to while it is being edited, and how dates and cut-offs
 * read. The region stays the source of truth (it snapshots pack size and
 * price when a line is saved); the App only previews while a draft is open.
 */

export const ORDER_STATUS_LABELS: Record<OrderStatus, MessageDescriptor> = {
	draft: msg`Draft`,
	sent: msg`Sent`,
	partly_received: msg`Partly received`,
	received: msg`Received`,
	cancelled: msg`Cancelled`,
}

export type OrderBadgeVariant = 'outline' | 'secondary' | 'warning' | 'success'

export function orderStatusVariant(status: OrderStatus): OrderBadgeVariant {
	switch (status) {
		case 'draft':
			return 'secondary'
		case 'sent':
			return 'outline'
		case 'partly_received':
			return 'warning'
		case 'received':
			return 'success'
		case 'cancelled':
			return 'outline'
	}
}

/** Statuses a delivery can still be received against (as the contract's rule). */
export function orderIsOpen(status: OrderStatus): boolean {
	return status === 'draft' || status === 'sent' || status === 'partly_received'
}

/** A line the person is editing: the saved line plus what they typed. */
export type DraftOrderLine = {
	/** The order line's id, or a local key for a line added on this page. */
	key: string
	itemId: string
	itemName: string
	supplierProductId: string
	packName: string
	packBaseQuantity: number
	pricedByWeight: boolean
	/** `null` for a line added on this page: it is known once saved. */
	baseUnit: OrderLine['baseUnit'] | null
	countUnit: OrderLine['countUnit']
	/** `null` while the field is empty. */
	packs: number | null
	/** What the suggestion proposed, to show "you changed it". */
	suggestedPacks: number | null
	onHand: number | null
	fillUpToQuantity: number | null
	/** Pack price at the time the line was saved (cost grant only). */
	packPriceMinor: number | null
}

export function draftLineFromOrderLine(line: OrderLine): DraftOrderLine {
	return {
		key: line.id,
		itemId: line.itemId,
		itemName: line.itemName,
		// A line whose supplier product was archived has none: it is shown, but
		// cannot be sent back in a PATCH (see `orderLinesPayload`).
		supplierProductId: line.supplierProductId ?? '',
		packName: line.packName,
		packBaseQuantity: line.packBaseQuantity,
		pricedByWeight: line.pricedByWeight,
		baseUnit: line.baseUnit,
		countUnit: line.countUnit,
		packs: line.packs,
		suggestedPacks: line.suggestedPacks,
		onHand: line.onHand ?? null,
		fillUpToQuantity: line.fillUpToQuantity ?? null,
		packPriceMinor: line.packPriceMinor ?? null,
	}
}

export function draftLinesFromOrder(order: OrderDetail): DraftOrderLine[] {
	return order.lines.map(draftLineFromOrderLine)
}

/** How much − and + change a line: halves for a pack priced by weight, else whole packs. */
export function packStep(line: { pricedByWeight: boolean }): number {
	return line.pricedByWeight ? PRICED_BY_WEIGHT_PACK_STEP_MILLI / 1000 : 1
}

/** The lines of a PATCH or POST: the empty ones are left out. */
export function orderLinesPayload(lines: readonly DraftOrderLine[]) {
	return lines
		.filter(
			(line) =>
				line.packs !== null && line.packs > 0 && line.supplierProductId !== '',
		)
		.map((line) => ({
			itemId: line.itemId,
			supplierProductId: line.supplierProductId,
			packs: line.packs!,
		}))
}

export type DraftTotals = {
	/** `null` without the cost grant (no line carries a price). */
	totalMinor: number | null
	unpricedLines: number
	shortOfMinimumMinor: number
}

/** The order's total while editing, from the pack prices the region saved. */
export function draftTotals(
	lines: readonly DraftOrderLine[],
	minimumOrderMinor: number | null | undefined,
	canSeeCost: boolean,
): DraftTotals {
	if (!canSeeCost) {
		return { totalMinor: null, unpricedLines: 0, shortOfMinimumMinor: 0 }
	}
	const counted = lines.filter((line) => line.packs !== null && line.packs > 0)
	const { totalMinor, unpricedLines } = orderTotalMinor(
		counted.map((line) => ({
			packs: line.packs!,
			packPriceMinor: line.packPriceMinor,
		})),
	)
	return {
		totalMinor,
		unpricedLines,
		shortOfMinimumMinor: shortOfMinimumMinor(totalMinor, minimumOrderMinor),
	}
}

/** Whether the typed lines differ from the saved ones (so Save and Send know to save first). */
export function linesChanged(
	lines: readonly DraftOrderLine[],
	saved: readonly OrderLine[],
): boolean {
	const typed = orderLinesPayload(lines)
	const kept = saved.filter((line) => line.supplierProductId !== null)
	if (typed.length !== kept.length) return true
	return typed.some((line, index) => {
		const original = kept[index]
		return (
			original === undefined ||
			original.itemId !== line.itemId ||
			original.supplierProductId !== line.supplierProductId ||
			original.packs !== line.packs
		)
	})
}

/** The way a supplier likes to be ordered from, as the send dialog's first choice. */
export function defaultSendChannel(
	channel: SupplierOrderChannel,
	available: { email: boolean; phone: boolean },
): OrderSendChannel {
	if (channel === 'email' && available.email) return 'email'
	if (channel === 'whatsapp' && available.phone) return 'whatsapp'
	return available.email ? 'email' : available.phone ? 'whatsapp' : 'copy'
}

export const SEND_CHANNEL_LABELS: Record<OrderSendChannel, MessageDescriptor> =
	{
		email: msg`Email`,
		whatsapp: msg`WhatsApp`,
		copy: msg`Copy the text`,
		pdf: msg`Print or save as PDF`,
	}

export const EMAIL_SKIPPED_MESSAGES = {
	not_configured: msg`Email cannot be sent from here yet.`,
	no_supplier_email: msg`This supplier has no email address yet.`,
	disabled: msg`Sending email is switched off for now.`,
} as const

/** `YYYY-MM-DD` and `HH:mm` as a local Date (never shifted by the time zone). */
export function localMomentDate(date: string, time = '00:00'): Date {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const [hours, minutes] = time.split(':').map(Number) as [number, number]
	return new Date(year, month - 1, day, hours, minutes)
}

/** "Thu" for an expected delivery date. */
export function weekdayShort(date: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(
		localMomentDate(date),
	)
}

/** "Wed, 4:00 PM" for a cut-off. */
export function cutoffText(
	cutoff: { date: string; time: string },
	locale: string,
): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		hour: 'numeric',
		minute: '2-digit',
	}).format(localMomentDate(cutoff.date, cutoff.time))
}

/** "Tue 4 Nov" for a due or sent date. */
export function shortDayText(date: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
	}).format(localMomentDate(date))
}

/** Packs as the person reads them: "2", "1.5". */
export function packsText(packs: number, locale: string): string {
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
		packs,
	)
}

/** Today as `YYYY-MM-DD` in the browser's time zone. */
export function todayIso(now = new Date()): string {
	const month = String(now.getMonth() + 1).padStart(2, '0')
	const day = String(now.getDate()).padStart(2, '0')
	return `${now.getFullYear()}-${month}-${day}`
}

/** The language the region writes order and credit texts in: Arabic or English. */
export function textLocale(locale: string): OrderTextLocale {
	return locale.toLowerCase().startsWith('ar') ? 'ar' : 'en'
}

/** Copies text to the clipboard; false when the browser refuses (no secure page, no permission). */
export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		return false
	}
}
