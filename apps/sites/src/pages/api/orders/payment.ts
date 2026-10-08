import { forwardPaymentReference } from '~/lib/ordering/payment-reference.server'

export const prerender = false
export async function POST({ request }: { request: Request }) {
	return forwardPaymentReference(request, 'checkout')
}
