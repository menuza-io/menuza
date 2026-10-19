import { RESERVATIONS_PERMISSIONS as P } from '@repo/reservations'
import { redirect } from 'react-router'
import { customersHref } from '#app/utils/people/customers-link.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { type Route } from './+types/guests.ts'

/**
 * Guests are part of Customers now. This route only keeps old links and
 * bookmarks working: it sends the person to the Customers list, keeping the
 * language.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: [P.READ_RESERVATION_GUEST, P.UPDATE_RESERVATION_GUEST],
	})
	const url = new URL(request.url)
	throw redirect(
		customersHref(access.organizationSlug, {
			lng: url.searchParams.get('lng'),
		}),
	)
}
