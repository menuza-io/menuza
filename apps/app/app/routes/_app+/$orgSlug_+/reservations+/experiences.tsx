import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ReservationsSectionPlaceholder } from '#app/components/reservations/section-placeholder.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/experiences.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.experiences,
	)
	return null
}

export default function ReservationsExperiencesRoute() {
	const { _ } = useLingui()
	return (
		<ReservationsSectionPlaceholder
			title={_(t`Experiences`)}
			description={_(
				t`Prepaid tasting menus, chef's tables, ticketed events, and add-ons.`,
			)}
			emptyTitle={_(t`No experiences configured yet`)}
			emptyDescription={_(
				t`Create prepaid or deposit-backed dining experiences, schedules, and optional add-ons.`,
			)}
			icons={['calendar', 'users', 'clock']}
		/>
	)
}
