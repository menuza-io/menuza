import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ReservationsSectionPlaceholder } from '#app/components/reservations/section-placeholder.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/today.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.today,
	)
	return null
}

export default function ReservationsTodayRoute() {
	const { _ } = useLingui()
	return (
		<ReservationsSectionPlaceholder
			title={_(t`Today`)}
			description={_(
				t`Live floor plan, upcoming reservations, seated tables, and walk-in seating.`,
			)}
			emptyTitle={_(t`No reservations scheduled for today`)}
			emptyDescription={_(
				t`Seated parties, upcoming arrivals, and floor status for the selected location and service appear here.`,
			)}
			icons={['calendar', 'clock', 'users']}
		/>
	)
}
