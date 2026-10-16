import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ReservationsSectionPlaceholder } from '#app/components/reservations/section-placeholder.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/guests.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.guests,
	)
	return null
}

export default function ReservationsGuestsRoute() {
	const { _ } = useLingui()
	return (
		<ReservationsSectionPlaceholder
			title={_(t`Guests`)}
			description={_(
				t`Guest directory, VIP tags, dietary preferences, visit history, and profile merges.`,
			)}
			emptyTitle={_(t`No guest profiles found`)}
			emptyDescription={_(
				t`Guest profiles, preferences, visit history, and notes live in your regional database.`,
			)}
			icons={['users', 'calendar', 'clock']}
		/>
	)
}
