import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ReservationsSectionPlaceholder } from '#app/components/reservations/section-placeholder.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/settings.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.settings,
	)
	return null
}

export default function ReservationsSettingsRoute() {
	const { _ } = useLingui()
	return (
		<ReservationsSectionPlaceholder
			title={_(t`Settings`)}
			description={_(
				t`Areas, tables, combinations, services, turn times, pacing, policies, and blackout dates.`,
			)}
			emptyTitle={_(t`Reservations configuration`)}
			emptyDescription={_(
				t`Configure dining areas, floor plan tables, service periods, turn times, and cancellation policies.`,
			)}
			icons={['calendar', 'clock', 'users']}
		/>
	)
}
