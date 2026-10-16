import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ReservationsSectionPlaceholder } from '#app/components/reservations/section-placeholder.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/waitlist.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.waitlist,
	)
	return null
}

export default function ReservationsWaitlistRoute() {
	const { _ } = useLingui()
	return (
		<ReservationsSectionPlaceholder
			title={_(t`Waitlist`)}
			description={_(
				t`Live walk-in queue, quoted wait times, table-ready notifications, and seating.`,
			)}
			emptyTitle={_(t`Waitlist is currently empty`)}
			emptyDescription={_(
				t`Add walk-in parties to quote wait times, send table-ready notifications, and seat guests.`,
			)}
			icons={['clock', 'users', 'calendar']}
		/>
	)
}
