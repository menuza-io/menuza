import { type Json } from '../util'

export const STRIPE_API_VERSION = '2025-08-27.basil'

export type StripeErrorType =
	'invalid_request_error' | 'card_error' | 'idempotency_error' | 'api_error'

/** Thrown by handlers; the router turns it into Stripe's error envelope. */
export class StripeApiError extends Error {
	constructor(
		readonly status: number,
		readonly type: StripeErrorType,
		message: string,
		readonly extra: {
			code?: string
			param?: string
			declineCode?: string
			paymentIntent?: Json
			paymentMethod?: Json
			setupIntent?: Json
		} = {},
	) {
		super(message)
		this.name = 'StripeApiError'
	}

	toEnvelope() {
		const {
			code,
			param,
			declineCode,
			paymentIntent,
			paymentMethod,
			setupIntent,
		} = this.extra
		return {
			error: {
				type: this.type,
				...(code ? { code } : {}),
				...(declineCode ? { decline_code: declineCode } : {}),
				...(param ? { param } : {}),
				message: this.message,
				...(code
					? {
							doc_url: `https://stripe.com/docs/error-codes/${code.replaceAll('_', '-')}`,
						}
					: {}),
				...(paymentIntent ? { payment_intent: paymentIntent } : {}),
				...(paymentMethod ? { payment_method: paymentMethod } : {}),
				...(setupIntent ? { setup_intent: setupIntent } : {}),
			},
		}
	}
}

export function invalidRequest(
	message: string,
	extra: { code?: string; param?: string } = {},
) {
	return new StripeApiError(400, 'invalid_request_error', message, extra)
}

export function missingParam(param: string) {
	return invalidRequest(`Missing required param: ${param}.`, {
		code: 'parameter_missing',
		param,
	})
}

export function noSuchResource(label: string, id: string, param?: string) {
	return new StripeApiError(
		404,
		'invalid_request_error',
		`No such ${label}: '${id}'`,
		{
			code: 'resource_missing',
			...(param ? { param } : {}),
		},
	)
}

export function cardError(
	message: string,
	extra: {
		code: string
		declineCode?: string
		paymentIntent?: Json
		paymentMethod?: Json
		setupIntent?: Json
		param?: string
	},
) {
	return new StripeApiError(402, 'card_error', message, extra)
}
