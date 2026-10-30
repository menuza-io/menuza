import { z } from 'zod'

export const PLATFORM_FEE_FLAG_KEY = 'reservations.platform_fee_bp'
export const PLATFORM_FEE_BP_ERROR =
	'Enter a whole number of basis points from 0 to 10000.'

/**
 * Basis points typed in a text field. Anything that is not plain digits (a
 * fraction, a sign, an exponent, empty text) becomes NaN so Zod refuses it.
 * The message never echoes the rejected text.
 */
export const PlatformFeeBpSchema = z.preprocess(
	(raw) =>
		typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())
			? Number(raw.trim())
			: Number.NaN,
	z
		.number({ error: PLATFORM_FEE_BP_ERROR })
		.int(PLATFORM_FEE_BP_ERROR)
		.min(0, PLATFORM_FEE_BP_ERROR)
		.max(10_000, PLATFORM_FEE_BP_ERROR),
)

/** 250 -> `2.50%`. */
export function formatBpAsPercent(bp: number): string {
	return `${(bp / 100).toFixed(2)}%`
}

/** Reads a stored ConfigFlag value; `null` when it is not an integer 0..10000. */
export function readStoredBp(value: unknown): number | null {
	return typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= 10_000
		? value
		: null
}

export const FeeActionSchema = z.discriminatedUnion('_action', [
	z.object({ _action: z.literal('set-system'), bp: PlatformFeeBpSchema }),
	z.object({
		_action: z.literal('set-override'),
		organization: z.string().trim().min(1, 'Enter an organization').max(120),
		bp: PlatformFeeBpSchema,
	}),
	z.object({
		_action: z.literal('remove-override'),
		id: z.string().trim().min(1).max(64),
	}),
])

export type FeeActionResult =
	| { ok: true }
	| { ok: false; error: string; fieldErrors?: Record<string, string> }
