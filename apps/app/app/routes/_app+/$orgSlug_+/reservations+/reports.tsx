import { redirect } from 'react-router'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { reservationsReportsHref } from '#app/utils/reservations/reports-link.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/reports.ts'

/**
 * Reservation reports live in the generic Reports page. This route only keeps
 * old links and bookmarks working: it sends the person to Reports on the
 * Reservations category, keeping the location and the language.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.reports,
	)
	const url = new URL(request.url)
	throw redirect(
		reservationsReportsHref(access.organizationSlug, {
			locationId:
				url.searchParams.get('locationId') ?? url.searchParams.get('location'),
			lng: url.searchParams.get('lng'),
		}),
	)
}
