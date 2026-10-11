export const PIN_MIN_LENGTH = 4
export const PIN_MAX_LENGTH = 6

export type PinProblem = 'format' | 'repeated' | 'sequence'

/**
 * Kiosk PINs are short, so the real controls are device trust and lockout.
 * This only rejects the guesses an attacker tries first.
 */
export function pinProblem(pin: string): PinProblem | null {
	if (!new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin)) {
		return 'format'
	}
	if (/^(\d)\1+$/.test(pin)) return 'repeated'
	const digits = [...pin].map(Number)
	const steps = digits.slice(1).map((digit, index) => digit - digits[index]!)
	if (steps.every((step) => step === 1) || steps.every((step) => step === -1)) {
		return 'sequence'
	}
	return null
}
