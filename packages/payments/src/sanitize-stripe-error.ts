/** Strip Stripe secret key material from error strings before they reach clients. */
export function sanitizeStripeErrorMessage(message: string): string {
	return message.replace(/\bsk_[A-Za-z0-9_-]+/g, '[STRIPE_KEY_REDACTED]')
}

export function toPublicStripeError(error: unknown, prefix: string): Error {
	const detail =
		error instanceof Error
			? sanitizeStripeErrorMessage(error.message)
			: typeof error === 'string'
				? sanitizeStripeErrorMessage(error)
				: ''
	if (!detail) {
		return new Error(`${prefix}. Please try again later.`)
	}
	return new Error(`${prefix}: ${detail}`)
}
