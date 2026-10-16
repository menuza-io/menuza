import { redirect } from 'react-router'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { firstVisibleReservationsPath } from '#app/utils/reservations/nav.ts'
import { RESERVATIONS_SECTION_PERMISSIONS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/_index.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: RESERVATIONS_SECTION_PERMISSIONS,
	})
	const target =
		firstVisibleReservationsPath(access.organizationSlug, {
			enabled: true,
			features: access.features,
			grants: access.grants,
		}) ?? `/${access.organizationSlug}/reservations/today`

	return redirect(target)
}

export default function ReservationsIndexRoute() {
	return null
}
