import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ReservationsSectionPlaceholder } from '#app/components/reservations/section-placeholder.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/reports.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.reports,
	)
	return null
}

export default function ReservationsReportsRoute() {
	const { _ } = useLingui()
	return (
		<ReservationsSectionPlaceholder
			title={_(t`Reports`)}
			description={_(
				t`Covers, utilization, no-show rates, pacing, and deposit/fee reconciliation.`,
			)}
			emptyTitle={_(t`Reservations analytics`)}
			emptyDescription={_(
				t`Track covers by service and channel, turn durations, waitlist conversions, and payment settlements.`,
			)}
			icons={['calendar', 'clock', 'users']}
		/>
	)
}
