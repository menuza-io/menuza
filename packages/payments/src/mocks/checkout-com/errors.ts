import { checkoutId } from '../ids'
import { jsonResponse } from '../util'

/** Thrown by handlers; the router answers with Checkout.com's error shapes. */
export class CheckoutApiError extends Error {
	constructor(
		readonly status: number,
		readonly errorType: string | null,
		readonly errorCodes: string[] = [],
	) {
		super(
			`Checkout.com mock ${status} ${errorType ?? ''} ${errorCodes.join(',')}`,
		)
		this.name = 'CheckoutApiError'
	}

	toResponse() {
		const requestId = checkoutId('req_')
		// 401 and 404 carry no body on the real API.
		if (this.status === 401 || this.status === 404) {
			return new Response(null, {
				status: this.status,
				headers: { 'cko-request-id': requestId },
			})
		}
		return jsonResponse(
			this.status,
			{
				request_id: requestId,
				error_type: this.errorType,
				error_codes: this.errorCodes,
			},
			{ 'cko-request-id': requestId },
		)
	}
}

export function invalidRequest(...codes: string[]) {
	return new CheckoutApiError(422, 'request_invalid', codes)
}

export function notFound() {
	return new CheckoutApiError(404, null)
}
