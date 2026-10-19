import { RESERVATIONS_PERMISSIONS as P } from '@repo/reservations'
import { redirect } from 'react-router'
import { customersHref } from '#app/utils/people/customers-link.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { type Route } from './+types/guests.$guestId.ts'

/**
 * Old guest profile links land on the Customers profile (`g_<guestId>`; the
 * profile resolves it to the linked customer or the surviving merged guest).
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: [P.READ_RESERVATION_GUEST, P.UPDATE_RESERVATION_GUEST],
	})
	const url = new URL(request.url)
	throw redirect(
		customersHref(access.organizationSlug, {
			personKey: `g_${params.guestId}`,
			lng: url.searchParams.get('lng'),
		}),
	)
}
