import { z } from 'zod'

/**
 * ConfigFlag keys for the Reservations module. Every flag defaults to off (`false`)
 * and must be enabled per organization. Only a literal boolean `true` is treated
 * as enabled. `reservations.enabled` is the master flag; all child flags evaluate
 * to `false` whenever the master flag is not `true`.
 */
export const RESERVATIONS_FLAG_KEYS = {
	enabled: 'reservations.enabled',
	online: 'reservations.online',
	waitlist: 'reservations.waitlist',
	payments: 'reservations.payments',
	experiences: 'reservations.experiences',
	voice: 'reservations.voice',
} as const

/** Alias for `RESERVATIONS_FLAG_KEYS`. */
export const RESERVATIONS_FLAGS = RESERVATIONS_FLAG_KEYS

export type ReservationsFlagName = keyof typeof RESERVATIONS_FLAG_KEYS
export type ReservationsFlagKey =
	(typeof RESERVATIONS_FLAG_KEYS)[ReservationsFlagName]

export const RESERVATIONS_FLAG_KEY_LIST: readonly ReservationsFlagKey[] =
	Object.values(RESERVATIONS_FLAG_KEYS)

export const RESERVATIONS_CHILD_FEATURES = [
	'online',
	'waitlist',
	'payments',
	'experiences',
	'voice',
] as const

export type ReservationsChildFeature =
	(typeof RESERVATIONS_CHILD_FEATURES)[number]

export type ReservationsFeatureState = {
	enabled: boolean
	online: boolean
	waitlist: boolean
	payments: boolean
	experiences: boolean
	voice: boolean
}

export const reservationsFeaturesSchema = z
	.object({
		enabled: z.boolean(),
		online: z.boolean(),
		waitlist: z.boolean(),
		payments: z.boolean(),
		experiences: z.boolean(),
		voice: z.boolean(),
	})
	.strict()

/** Only a literal boolean `true` counts as enabled. */
export function isFlagOn(value: unknown): boolean {
	return value === true
}

/**
 * Fold raw flag values into a `ReservationsFeatureState`. Supports both short
 * keys (`enabled`, `online`, ...) and full ConfigFlag keys (`reservations.enabled`, ...).
 * Child flags are forced `false` whenever the master flag is not `true`.
 */
export function foldReservationsFeatures(
	raw: Partial<Record<ReservationsFlagName | ReservationsFlagKey, unknown>>,
): ReservationsFeatureState {
	const read = (name: ReservationsFlagName): boolean => {
		const fullKey = RESERVATIONS_FLAG_KEYS[name]
		if (name in raw) return isFlagOn(raw[name])
		if (fullKey in raw) return isFlagOn(raw[fullKey])
		return false
	}
	const enabled = read('enabled')
	return {
		enabled,
		online: enabled && read('online'),
		waitlist: enabled && read('waitlist'),
		payments: enabled && read('payments'),
		experiences: enabled && read('experiences'),
		voice: enabled && read('voice'),
	}
}

export const PLATFORM_FEE_FLAG_KEY = 'reservations.platform_fee_bp' as const
export const DEFAULT_PLATFORM_FEE_BP = 0
export const MAX_PLATFORM_FEE_BP = 10_000

/**
 * Parse `reservations.platform_fee_bp` (integer or integer string in `0..10000`).
 * Missing (`undefined` / `null` / `''`) returns `0` silently. Non-integers or
 * out-of-range values return `0` and invoke `onWarning` if provided.
 */
export function parsePlatformFeeBp(
	raw: unknown,
	onWarning?: (message: string) => void,
): number {
	if (raw === undefined || raw === null || raw === '') {
		return DEFAULT_PLATFORM_FEE_BP
	}
	let num: number
	if (typeof raw === 'number') {
		num = raw
	} else if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
		num = Number(raw.trim())
	} else {
		onWarning?.(
			`Invalid ${PLATFORM_FEE_FLAG_KEY}: expected integer 0..${MAX_PLATFORM_FEE_BP}`,
		)
		return DEFAULT_PLATFORM_FEE_BP
	}
	if (!Number.isInteger(num) || num < 0 || num > MAX_PLATFORM_FEE_BP) {
		onWarning?.(
			`Out-of-range ${PLATFORM_FEE_FLAG_KEY}: expected integer 0..${MAX_PLATFORM_FEE_BP}`,
		)
		return DEFAULT_PLATFORM_FEE_BP
	}
	return num
}
