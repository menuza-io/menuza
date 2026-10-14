import { z } from 'zod'

export const PIN_MIN_LENGTH = 4
export const PIN_MAX_LENGTH = 6
export const PIN_DEFAULT_LENGTH = 4

export const pinLengthSchema = z
	.number()
	.int()
	.min(PIN_MIN_LENGTH)
	.max(PIN_MAX_LENGTH)

export type PinProblem =
	'not_digits' | 'wrong_length' | 'all_same_digit' | 'sequential'

/**
 * Convert Arabic-Indic and Eastern Arabic-Indic digits to ASCII so a PIN typed
 * on an Arabic keypad matches the one that was generated.
 */
export function normalizePinDigits(input: string): string {
	return input
		.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
		.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
}

function isRun(pin: string, step: 1 | -1): boolean {
	for (let i = 1; i < pin.length; i++) {
		if (Number(pin[i]) - Number(pin[i - 1]) !== step) return false
	}
	return true
}

/**
 * Format and weakness rules for a manager-chosen PIN. System-generated PINs
 * pass through `generatePin`, which never produces a weak PIN. Returns the first
 * problem found, or null when the PIN is acceptable.
 */
export function checkPin(
	pin: string,
	length: number = PIN_DEFAULT_LENGTH,
): PinProblem | null {
	const normalized = normalizePinDigits(pin)
	if (!/^\d+$/.test(normalized)) return 'not_digits'
	if (normalized.length !== length) return 'wrong_length'
	if (/^(\d)\1+$/.test(normalized)) return 'all_same_digit'
	if (isRun(normalized, 1) || isRun(normalized, -1)) return 'sequential'
	return null
}

export type RandomIntFn = (maxExclusive: number) => number

/** Uniform random integer in [0, maxExclusive) from Web Crypto, no modulo bias. */
export function secureRandomInt(maxExclusive: number): number {
	if (
		!Number.isInteger(maxExclusive) ||
		maxExclusive <= 0 ||
		maxExclusive > 2 ** 32
	) {
		throw new RangeError('maxExclusive must be an integer in 1..2^32')
	}
	const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive
	const buf = new Uint32Array(1)
	let value: number
	do {
		crypto.getRandomValues(buf)
		value = buf[0]!
	} while (value >= limit)
	return value % maxExclusive
}

/**
 * Generate a PIN that passes `checkPin`. `randomInt` is injectable so tests are
 * deterministic; production uses Web Crypto. Gives up after a bounded number of
 * attempts rather than looping forever on a broken random source.
 */
export function generatePin(
	length: number = PIN_DEFAULT_LENGTH,
	randomInt: RandomIntFn = secureRandomInt,
): string {
	pinLengthSchema.parse(length)
	for (let attempt = 0; attempt < 1000; attempt++) {
		let pin = ''
		for (let i = 0; i < length; i++) pin += String(randomInt(10))
		if (checkPin(pin, length) === null) return pin
	}
	throw new Error('Could not generate an acceptable PIN')
}

/**
 * The exact message that tenant-api feeds to HMAC-SHA256 (keyed by
 * AUTH_HMAC_SECRET) to build `pin_lookup`. The lookup is unique per scope so
 * two scopes can reuse a PIN, and it never contains the staff id. The secret
 * lives only in tenant-api; this package never sees it.
 */
export function pinLookupMessage(
	orgId: string,
	scopeId: string,
	pin: string,
): string {
	if (!orgId || !scopeId) throw new Error('orgId and scopeId are required')
	if (orgId.includes(':') || scopeId.includes(':')) {
		throw new Error('ids must not contain ":"')
	}
	return `staff-pin:${orgId}:${scopeId}:${normalizePinDigits(pin)}`
}

/**
 * Per-device PIN backoff. Failures are counted in a rolling window; the count
 * and window start are stored in the org database (the tenant-api in-process
 * limiter resets per isolate and cannot be trusted for this).
 *
 * Below the threshold there is no delay, so a few typos never lock a person out.
 * From the threshold, each further failure doubles the delay, from 30 seconds
 * up to a 5 minute cap.
 */
export const PIN_BACKOFF = {
	freeFailures: 4,
	baseDelaySeconds: 30,
	maxDelaySeconds: 5 * 60,
	windowSeconds: 5 * 60,
	hourlyAlertThreshold: 30,
} as const

export function pinBackoffDelaySeconds(failuresInWindow: number): number {
	if (
		Number.isNaN(failuresInWindow) ||
		failuresInWindow <= PIN_BACKOFF.freeFailures
	) {
		return 0
	}
	if (!Number.isFinite(failuresInWindow)) return PIN_BACKOFF.maxDelaySeconds
	const over = Math.floor(failuresInWindow) - PIN_BACKOFF.freeFailures - 1
	// Clamp the exponent so a huge counter cannot overflow before the cap applies.
	const delay = PIN_BACKOFF.baseDelaySeconds * 2 ** Math.min(over, 10)
	return Math.min(delay, PIN_BACKOFF.maxDelaySeconds)
}

/** True when a coarse hourly failure ceiling should alert a manager. */
export function shouldAlertManagerOnPinFailures(
	failuresLastHour: number,
): boolean {
	return failuresLastHour >= PIN_BACKOFF.hourlyAlertThreshold
}

/**
 * Persisted per-device PIN failure state (one `kiosk_attempts` row). The state
 * lives in the org database because the tenant-api in-process limiter resets
 * per isolate.
 *
 * Failures decay one at a time: every `windowSeconds` of quiet forgives one
 * failure, instead of resetting the whole counter. A full reset would hand an
 * attacker a fresh set of free guesses every five minutes, and a reset on
 * success would let anyone who knows one valid PIN clear the counter between
 * guesses. A success only forgives one failure.
 */
export type PinBackoffState = {
	failures: number
	lastFailureAt: number | null
	blockedUntil: number | null
	hourStartedAt: number | null
	hourFailures: number
	hourAlertedAt: number | null
}

export const EMPTY_PIN_BACKOFF_STATE: PinBackoffState = {
	failures: 0,
	lastFailureAt: null,
	blockedUntil: null,
	hourStartedAt: null,
	hourFailures: 0,
	hourAlertedAt: null,
}

const HOUR_MS = 60 * 60 * 1000

/** Failures still counted at `nowMs` after decay. */
export function decayedPinFailures(
	state: Pick<PinBackoffState, 'failures' | 'lastFailureAt'>,
	nowMs: number,
): number {
	if (state.failures <= 0 || state.lastFailureAt === null) return 0
	const quiet = Math.max(0, nowMs - state.lastFailureAt)
	const forgiven = Math.floor(quiet / (PIN_BACKOFF.windowSeconds * 1000))
	return Math.max(0, state.failures - forgiven)
}

/** Seconds until attempts are accepted again; 0 when the device is not backing off. */
export function pinBackoffRemainingSeconds(
	state: Pick<PinBackoffState, 'blockedUntil'>,
	nowMs: number,
): number {
	if (state.blockedUntil === null || state.blockedUntil <= nowMs) return 0
	return Math.ceil((state.blockedUntil - nowMs) / 1000)
}

export type PinFailureOutcome = {
	state: PinBackoffState
	/** Delay now imposed on the whole device (0 for the first few typos). */
	delaySeconds: number
	/** True once per hour window when the hourly ceiling is first crossed. */
	alertManager: boolean
}

/**
 * Counts one attempt (failed, or refused during a delay) in the hourly window
 * and says whether this is the first to cross the ceiling in that window.
 * Refused attempts count too: a device being hammered while it backs off is
 * the signal worth telling a manager about, and a throttled attacker could
 * otherwise never reach the ceiling.
 */
function countHourlyAttempt(
	state: PinBackoffState,
	nowMs: number,
): Pick<PinBackoffState, 'hourStartedAt' | 'hourFailures' | 'hourAlertedAt'> & {
	alertManager: boolean
} {
	const sameHour =
		state.hourStartedAt !== null && nowMs - state.hourStartedAt < HOUR_MS
	const hourStartedAt = sameHour ? state.hourStartedAt : nowMs
	const hourFailures = (sameHour ? state.hourFailures : 0) + 1
	const alreadyAlerted =
		sameHour &&
		state.hourAlertedAt !== null &&
		state.hourAlertedAt >= (hourStartedAt ?? 0)
	const alertManager =
		!alreadyAlerted && shouldAlertManagerOnPinFailures(hourFailures)
	return {
		hourStartedAt,
		hourFailures,
		hourAlertedAt: alertManager ? nowMs : sameHour ? state.hourAlertedAt : null,
		alertManager,
	}
}

/** Record one failed PIN attempt. Callers must have refused blocked attempts. */
export function applyPinFailure(
	state: PinBackoffState,
	nowMs: number,
): PinFailureOutcome {
	const failures = decayedPinFailures(state, nowMs) + 1
	const delaySeconds = pinBackoffDelaySeconds(failures)
	const { alertManager, ...hour } = countHourlyAttempt(state, nowMs)
	return {
		delaySeconds,
		alertManager,
		state: {
			failures,
			lastFailureAt: nowMs,
			blockedUntil: delaySeconds > 0 ? nowMs + delaySeconds * 1000 : null,
			...hour,
		},
	}
}

/**
 * Record an attempt that was refused because the device is backing off. It
 * never extends the delay and never changes the failure count; it only feeds
 * the hourly alert.
 */
export function applyRefusedAttempt(
	state: PinBackoffState,
	nowMs: number,
): { state: PinBackoffState; alertManager: boolean } {
	const { alertManager, ...hour } = countHourlyAttempt(state, nowMs)
	return { alertManager, state: { ...state, ...hour } }
}

/**
 * A correct PIN forgives one failure; it never clears the counter. The decay
 * clock restarts so the forgiven failure is not also decayed a second time.
 */
export function applyPinSuccess(
	state: PinBackoffState,
	nowMs: number,
): PinBackoffState {
	const failures = Math.max(0, decayedPinFailures(state, nowMs) - 1)
	return {
		...state,
		failures,
		lastFailureAt: failures === 0 ? null : nowMs,
		blockedUntil:
			state.blockedUntil !== null && state.blockedUntil > nowMs
				? state.blockedUntil
				: null,
	}
}

/**
 * Optional "pick your name, then PIN" mode: after this many wrong PINs for one
 * person, only that person is locked out (for a while); nobody else is.
 */
export const PERSON_PIN_LOCK = {
	maxFailures: 5,
	lockSeconds: 15 * 60,
} as const
