/**
 * Tips at online checkout (#118): the request shape, the cap, and the one
 * function that turns a guest's choice into cents.
 *
 * - A percentage tip is a share of the order subtotal before discounts and
 *   before tax, as it always was (see docs/discounts-plan.md).
 * - A custom amount is charged exactly. It may be at most the larger of half
 *   the subtotal or a per-currency cap; above that the region answers 422
 *   `tip_too_large`.
 * - `tipPercent` stays on the wire for clients that predate `tip`.
 *
 * No I/O and no UI strings. Sites, tenant-api and the App import this file.
 */
import { z } from 'zod'

export const TIP_MIN_PERCENT = 0
export const TIP_MAX_PERCENT = 30

/** A sanity bound on a posted amount; the real limit is `maxTipMinor`. */
export const TIP_MAX_POSTED_MINOR = 1_000_000_000

/** The cap on a custom tip, in major units. */
export const TIP_CAP_MAJOR: Readonly<Record<string, number>> = {
	USD: 200,
	SAR: 750,
}
/** An unknown currency uses 200 major units. */
export const TIP_FALLBACK_CAP_MAJOR = 200

export const TIP_TOO_LARGE_CODE = 'tip_too_large'

/** What a guest chose: a share of the subtotal or an exact amount. */
export const orderTipSchema = z.union([
	z.strictObject({
		percent: z.number().int().min(TIP_MIN_PERCENT).max(TIP_MAX_PERCENT),
	}),
	z.strictObject({
		amountMinor: z.number().int().min(0).max(TIP_MAX_POSTED_MINOR),
	}),
])
export type OrderTip = z.infer<typeof orderTipSchema>

/** The most a tip may be: the larger of half the subtotal or the currency cap. */
export function maxTipMinor(subtotalCents: number, currency: string): number {
	const capMajor =
		TIP_CAP_MAJOR[currency.toUpperCase()] ?? TIP_FALLBACK_CAP_MAJOR
	return Math.max(
		Math.round(capMajor * 100),
		Math.round(Math.max(0, subtotalCents) / 2),
	)
}

/**
 * The tip a request carries: `tip` when sent, otherwise the legacy
 * `tipPercent` (0 when neither).
 */
export function requestedTip(request: {
	tip?: OrderTip | undefined
	tipPercent?: number | undefined
}): OrderTip {
	return request.tip ?? { percent: request.tipPercent ?? 0 }
}

/** True when the request asks for any tip at all. */
export function requestsTip(request: {
	tip?: OrderTip | undefined
	tipPercent?: number | undefined
}): boolean {
	const tip = requestedTip(request)
	return 'percent' in tip ? tip.percent > 0 : tip.amountMinor > 0
}

export type TipResult =
	| {
			ok: true
			tipCents: number
			/** Null for an exact amount. */
			tipPercent: number | null
	  }
	| { ok: false; code: typeof TIP_TOO_LARGE_CODE }

/** Cents for a choice on a subtotal; `tip_too_large` above the cap. */
export function computeTip(input: {
	tip: OrderTip
	subtotalCents: number
	currency: string
}): TipResult {
	const { tip, subtotalCents } = input
	if ('percent' in tip) {
		return {
			ok: true,
			tipCents: Math.round((subtotalCents * tip.percent) / 100),
			tipPercent: tip.percent,
		}
	}
	if (tip.amountMinor > maxTipMinor(subtotalCents, input.currency)) {
		return { ok: false, code: TIP_TOO_LARGE_CODE }
	}
	return { ok: true, tipCents: tip.amountMinor, tipPercent: null }
}

/** The tip as it is hashed for an idempotent replay: stable, shape-tagged. */
export function canonicalTip(request: {
	tip?: OrderTip | undefined
	tipPercent?: number | undefined
}): { tipPercent: number } | { tipAmountMinor: number } {
	const tip = requestedTip(request)
	return 'percent' in tip
		? { tipPercent: tip.percent }
		: { tipAmountMinor: tip.amountMinor }
}
