import {
	fieldClasses,
	fieldStyle,
	printAllowed,
	resolveTickets,
	type ResolvedTickets,
	type TicketFieldStyle,
	type TicketType,
} from '@repo/common/ticket-config'
import { useMemo } from 'react'
import { type LineVoid, type PosOrder } from './db.ts'
import { type CartLine } from './pricing.ts'
import { roundsOf } from './rounds.ts'
import { usePos } from './store.ts'

/**
 * What this location prints on each ticket, and when (#363). Read from the
 * location's Station settings, which arrive with the published menu, so it
 * works with no connection like the rest of the till.
 */
export function useTickets(): ResolvedTickets {
	const raw = usePos((s) => s.location?.stationSettings?.tickets)
	return useMemo(() => resolveTickets(raw), [raw])
}

/** One field of one ticket type: whether it prints and the classes it adds. */
export function fieldOf(
	tickets: ResolvedTickets,
	type: TicketType,
	key: string,
): TicketFieldStyle & { cls: string } {
	const style = fieldStyle(tickets, type, key)
	return { ...style, cls: fieldClasses(style) }
}

// ---------------------------------------------------------------------------
// The kitchen ticket for an order rung up at the till
// ---------------------------------------------------------------------------

export type KitchenTicketPlan = {
	/** The whole order, only what changed since the last round, or a cancellation slip. */
	kind: 'full' | 'changes' | 'cancelled'
	lines: CartLine[]
	/** Dishes taken off since the previous round (for `changes`). */
	removed: LineVoid[]
	/** When the ticket's content happened: the round, or the cancellation. */
	at: number
}

/**
 * What a kitchen ticket for a till order holds, or null when it may not print:
 * dine-in left out by the owner, or a cancelled order with no cancellation slip
 * switched on. An adjusted order (a tab that went to the kitchen in more than
 * one round) prints only the newest round, and the dishes taken off since the
 * one before, when the owner asked for changes only.
 */
export function kitchenTicketPlan(
	order: PosOrder,
	tickets: ResolvedTickets,
): KitchenTicketPlan | null {
	if (!printAllowed(tickets, order.orderType)) return null
	if (order.status === 'void') {
		if (!tickets.cancellationSlip) return null
		return {
			kind: 'cancelled',
			lines: order.lines,
			removed: [],
			at: order.voidedAt ?? order.updatedAt,
		}
	}
	const sent = roundsOf(order.lines).filter((round) => round.sentAt !== null)
	if (tickets.changesOnly && sent.length > 1) {
		const latest = sent[sent.length - 1]!
		const before = sent[sent.length - 2]!
		return {
			kind: 'changes',
			lines: latest.lines,
			removed: order.lineVoids.filter((v) => v.at > before.sentAt!),
			at: latest.sentAt!,
		}
	}
	return { kind: 'full', lines: order.lines, removed: [], at: order.createdAt }
}

/** The links the receipt codes open at this terminal's location, from the menu it already has (#263). */
export function useReceiptTargets() {
	const codes = usePos((s) => s.location?.receiptCodes)
	return useMemo(
		() => ({
			reviewUrl: codes?.reviewUrl ?? null,
			appUrl: codes?.appUrl ?? null,
		}),
		[codes?.reviewUrl, codes?.appUrl],
	)
}

/** The organization logo's address, resolved against the App, or null. */
export function useReceiptLogoUrl(): string | null {
	const icon = usePos((s) => s.snapshot?.organization.siteIcon?.appleTouchIcon)
	const appUrl = usePos((s) => s.settings.appUrl)
	if (!icon) return null
	if (/^(https?:|data:|blob:)/.test(icon)) return icon
	return appUrl
		? `${appUrl.replace(/\/+$/, '')}${icon.startsWith('/') ? '' : '/'}${icon}`
		: null
}
