/**
 * Guest order messages (control plane): the org flag, the operator switches
 * and the large-order fields of the order context. Policy only, no PII: the
 * guest's email and number live in the regional database.
 */
import { z } from 'zod'

/** Org flag, default off, only a literal `true` counts. */
export const GUEST_MESSAGES_FLAG_KEY = 'ordering.guest_messages'

/**
 * Org-level `ConfigFlag` row holding the three switches as one JSON object
 * (`{ receipt, ready, cancelled }`). There is no per-organization settings
 * column, so no migration is needed. Missing or malformed reads as all on.
 */
export const GUEST_MESSAGES_SETTINGS_KEY = 'ordering.guest_messages.settings'

export const guestMessageSwitchesSchema = z.object({
	receipt: z.boolean(),
	ready: z.boolean(),
	cancelled: z.boolean(),
})

export type GuestMessageSwitches = z.infer<typeof guestMessageSwitchesSchema>

export const DEFAULT_GUEST_MESSAGE_SWITCHES: GuestMessageSwitches = {
	receipt: true,
	ready: true,
	cancelled: true,
}

/** `guestMessages` field of `GET /resources/order-context`. */
export type GuestMessagesContext = GuestMessageSwitches & { enabled: boolean }

export const GUEST_MESSAGES_OFF: GuestMessagesContext = {
	enabled: false,
	receipt: false,
	ready: false,
	cancelled: false,
}

/** Reads a stored value; each switch missing or not a boolean stays on. */
export function parseGuestMessageSwitches(
	value: unknown,
): GuestMessageSwitches {
	let candidate: unknown = value
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate)
		} catch {
			return { ...DEFAULT_GUEST_MESSAGE_SWITCHES }
		}
	}
	const raw =
		candidate && typeof candidate === 'object'
			? (candidate as Record<string, unknown>)
			: {}
	const pick = (key: keyof GuestMessageSwitches) =>
		typeof raw[key] === 'boolean' ? raw[key] : true
	return {
		receipt: pick('receipt'),
		ready: pick('ready'),
		cancelled: pick('cancelled'),
	}
}

/** Folds the flag and the switches; the switches count only while the flag is on. */
export function foldGuestMessages(
	flag: unknown,
	switches: GuestMessageSwitches,
): GuestMessagesContext {
	if (flag !== true) return { ...GUEST_MESSAGES_OFF }
	return { enabled: true, ...switches }
}

/**
 * `largeOrder` of the order context, per location id. `threshold` is in MAJOR
 * currency units for `amount` (exactly as stored: 100 is 100.00) and a count of
 * items for `items`.
 */
export type LargeOrderContext = Record<
	string,
	{
		threshold: number
		thresholdType: 'amount' | 'items'
		extraPrepMinutes: number
	}
>

type LocationLargeOrderRow = {
	id: string
	largeOrderThreshold: number | null
	largeOrderThresholdType: string | null
	largeOrderExtraPrepTime: number | null
}

/**
 * The location form stores `'dollars'` (order total) or `'items'`. Only
 * locations with a positive threshold and extra prep time are listed; an
 * unknown type is skipped (no extra prep rather than a wrong one).
 */
export function foldLargeOrder(
	rows: LocationLargeOrderRow[],
): LargeOrderContext {
	const out: LargeOrderContext = {}
	for (const row of rows) {
		const threshold = row.largeOrderThreshold
		const minutes = row.largeOrderExtraPrepTime
		if (
			typeof threshold !== 'number' ||
			!Number.isFinite(threshold) ||
			threshold <= 0
		)
			continue
		if (
			typeof minutes !== 'number' ||
			!Number.isFinite(minutes) ||
			minutes <= 0
		)
			continue
		const type =
			row.largeOrderThresholdType === 'dollars'
				? 'amount'
				: row.largeOrderThresholdType === 'items'
					? 'items'
					: null
		if (!type) continue
		out[row.id] = {
			threshold,
			thresholdType: type,
			extraPrepMinutes: Math.round(minutes),
		}
	}
	return out
}
