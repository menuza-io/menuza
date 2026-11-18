import { parseGuestDisplayImageUrl } from '@repo/common/terminal-profiles'
import { type OrderType } from './db.ts'
import { type CartLine, type Totals, lineTotalCents  } from './pricing.ts'

/**
 * The guest's second screen (#367): a second window of this same app, opened
 * on a spare display, that shows the order as the till has it. The two talk
 * over a `BroadcastChannel` (same origin, same device), so it works with no
 * network. Only the order on screen travels: dish names, prices and the totals,
 * the tip choices and the guest's own loyalty sign-in. No staff name, no
 * customer details, no table, no other order.
 */

export const GUEST_DISPLAY_PARAM = 'guest-display'

/** One channel per restaurant and terminal, so two tills side by side never mix. */
export const guestChannelName = (slug: string, terminalCode: string) =>
	`station-guest-display:${slug.trim().toLowerCase()}:${terminalCode}`

/** The address of the guest screen for this till. */
export function guestDisplayUrl(
	slug: string,
	terminalCode: string,
	origin: string,
): string {
	const url = new URL('/', origin)
	url.searchParams.set(
		GUEST_DISPLAY_PARAM,
		guestChannelName(slug, terminalCode),
	)
	return url.toString()
}

/** The channel a guest-screen page was opened for, or null when this is the till. */
export function guestDisplayChannel(search: string): string | null {
	const value = new URLSearchParams(search).get(GUEST_DISPLAY_PARAM)
	return value && /^station-guest-display:[\w.-]*:[\w-]{1,12}$/.test(value)
		? value
		: null
}

export type GuestLine = {
	id: string
	name: string
	/** Size and chosen options, never the dish note. */
	detail: string | null
	quantity: number
	totalCents: number
}

export type GuestTip = {
	/** Percentages offered, `0` is "no tip". */
	choices: number[]
	selected: number
}

export type GuestLoyalty =
	| { stage: 'invite' }
	| { stage: 'phone'; error?: string | null }
	| { stage: 'code'; maskedPhone: string; error?: string | null }
	| { stage: 'busy' }
	| {
			stage: 'member'
			/** The guest's own first name, shown back to them. */
			firstName: string | null
			points: number
			unitLabel: string
	  }

export type GuestState = {
	v: 1
	/** Increases with every message, so an old one never replaces a new one. */
	seq: number
	view: 'idle' | 'order' | 'checkout'
	businessName: string
	currency: string
	locale: string
	rtl: boolean
	lines: GuestLine[]
	subtotalCents: number
	discountCents: number
	taxCents: number
	tipCents: number
	totalCents: number
	taxInclusive: boolean
	tip: GuestTip | null
	loyalty: GuestLoyalty | null
	/** The picture shown between orders. */
	idleImageUrl: string | null
}

/** Display to till. */
export type GuestMessage =
	| { type: 'hello' }
	| { type: 'tip'; percent: number }
	| { type: 'loyalty-start' }
	| { type: 'loyalty-phone'; phone: string }
	| { type: 'loyalty-code'; code: string }
	| { type: 'loyalty-reset' }

export function lineDetail(line: CartLine): string | null {
	const parts = [
		line.variantLabel ?? '',
		...line.options.map((o) =>
			o.quantity > 1 ? `${o.optionName} ×${o.quantity}` : o.optionName,
		),
	].filter((part) => part.trim() !== '')
	return parts.length ? parts.join(', ') : null
}

export function guestLines(lines: readonly CartLine[]): GuestLine[] {
	return lines.map((line) => ({
		id: line.id,
		name: line.name,
		detail: lineDetail(line),
		quantity: line.quantity,
		totalCents: lineTotalCents(line),
	}))
}

export type GuestInputs = {
	seq: number
	/** `idle` is chosen here: no lines and no checkout. */
	checkout: boolean
	businessName: string
	currency: string
	locale: string
	rtl: boolean
	lines: readonly CartLine[]
	totals: Totals
	taxInclusive: boolean
	tip: GuestTip | null
	loyalty: GuestLoyalty | null
	idleImageUrl: string | null
	orderType?: OrderType
}

/** What the second screen shows for the order on the till. */
export function buildGuestState(input: GuestInputs): GuestState {
	const idle = !input.checkout && input.lines.length === 0
	return {
		v: 1,
		seq: input.seq,
		view: idle ? 'idle' : input.checkout ? 'checkout' : 'order',
		businessName: input.businessName,
		currency: input.currency,
		locale: input.locale,
		rtl: input.rtl,
		lines: idle ? [] : guestLines(input.lines),
		subtotalCents: input.totals.subtotalCents,
		discountCents: input.totals.adjustmentCents,
		taxCents: input.totals.taxCents,
		tipCents: input.totals.tipCents,
		totalCents: input.totals.totalCents,
		taxInclusive: input.taxInclusive,
		// A tip is asked for only at the end, when the guest is about to pay.
		tip: input.checkout ? input.tip : null,
		loyalty: idle ? null : input.loyalty,
		idleImageUrl: parseGuestDisplayImageUrl(input.idleImageUrl),
	}
}

const int = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null

/**
 * Reads a message the second screen received. The page trusts only the shape it
 * knows: anything else (another page on the same origin) is dropped.
 */
export function readGuestState(value: unknown): GuestState | null {
	if (!value || typeof value !== 'object') return null
	const v = value as Record<string, unknown>
	if (v.v !== 1 || int(v.seq) === null) return null
	if (v.view !== 'idle' && v.view !== 'order' && v.view !== 'checkout')
		return null
	if (!Array.isArray(v.lines)) return null
	const lines: GuestLine[] = []
	for (const raw of v.lines.slice(0, 200)) {
		const line = raw as Record<string, unknown>
		if (
			typeof line?.id !== 'string' ||
			typeof line.name !== 'string' ||
			int(line.quantity) === null ||
			int(line.totalCents) === null
		)
			return null
		lines.push({
			id: line.id,
			name: line.name,
			detail: typeof line.detail === 'string' ? line.detail : null,
			quantity: int(line.quantity)!,
			totalCents: int(line.totalCents)!,
		})
	}
	const cents = (key: string) => int(v[key])
	const money = [
		'subtotalCents',
		'discountCents',
		'taxCents',
		'tipCents',
		'totalCents',
	].map(cents)
	if (money.some((x) => x === null)) return null
	const tip = v.tip as { choices?: unknown; selected?: unknown } | null
	return {
		v: 1,
		seq: int(v.seq)!,
		view: v.view,
		businessName: typeof v.businessName === 'string' ? v.businessName : '',
		currency:
			typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency)
				? v.currency
				: 'USD',
		locale: typeof v.locale === 'string' ? v.locale : 'en',
		rtl: v.rtl === true,
		lines,
		subtotalCents: money[0]!,
		discountCents: money[1]!,
		taxCents: money[2]!,
		tipCents: money[3]!,
		totalCents: money[4]!,
		taxInclusive: v.taxInclusive === true,
		tip:
			tip && Array.isArray(tip.choices) && int(tip.selected) !== null
				? {
						choices: tip.choices
							.map(int)
							.filter((p): p is number => p !== null && p >= 0 && p <= 100)
							.slice(0, 6),
						selected: int(tip.selected)!,
					}
				: null,
		loyalty: readLoyalty(v.loyalty),
		idleImageUrl: parseGuestDisplayImageUrl(v.idleImageUrl),
	}
}

function readLoyalty(value: unknown): GuestLoyalty | null {
	if (!value || typeof value !== 'object') return null
	const v = value as Record<string, unknown>
	const error = typeof v.error === 'string' ? v.error : null
	switch (v.stage) {
		case 'invite':
			return { stage: 'invite' }
		case 'phone':
			return { stage: 'phone', error }
		case 'code':
			return {
				stage: 'code',
				maskedPhone: typeof v.maskedPhone === 'string' ? v.maskedPhone : '',
				error,
			}
		case 'busy':
			return { stage: 'busy' }
		case 'member':
			return {
				stage: 'member',
				firstName: typeof v.firstName === 'string' ? v.firstName : null,
				points: int(v.points) ?? 0,
				unitLabel: typeof v.unitLabel === 'string' ? v.unitLabel : '',
			}
		default:
			return null
	}
}

/** Reads a message from the second screen to the till. */
export function readGuestMessage(value: unknown): GuestMessage | null {
	if (!value || typeof value !== 'object') return null
	const v = value as Record<string, unknown>
	switch (v.type) {
		case 'hello':
			return { type: 'hello' }
		case 'tip': {
			const percent = int(v.percent)
			return percent !== null && percent >= 0 && percent <= 100
				? { type: 'tip', percent }
				: null
		}
		case 'loyalty-start':
			return { type: 'loyalty-start' }
		case 'loyalty-phone':
			return typeof v.phone === 'string' && v.phone.length <= 32
				? { type: 'loyalty-phone', phone: v.phone }
				: null
		case 'loyalty-code':
			return typeof v.code === 'string' && v.code.length <= 12
				? { type: 'loyalty-code', code: v.code }
				: null
		case 'loyalty-reset':
			return { type: 'loyalty-reset' }
		default:
			return null
	}
}
