import { forwardReservationPayment } from '~/lib/reservations/payment-forward.server'

export const prerender = false
export async function POST({
	request,
	locals,
}: {
	request: Request
	locals: { orgSlug?: string | null; customHost?: string | null }
}) {
	return forwardReservationPayment(request, 'checkout', {
		slug: locals.orgSlug,
		host: locals.customHost,
	})
}
