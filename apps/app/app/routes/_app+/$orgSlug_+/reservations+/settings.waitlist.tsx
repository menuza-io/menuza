import { Trans } from '@lingui/react/macro'
import { WaitlistSettingsScreen } from '#app/components/reservations/waitlist/waitlist-settings.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/settings.waitlist.ts'
import { useReservationsSetupContext } from './settings.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(request, params.orgSlug, {
		feature: 'waitlist',
		anyOf: RESERVATIONS_SECTION_REQUIREMENTS.settings.anyOf,
	})
	return null
}

export default function ReservationsSettingsWaitlistRoute() {
	const { selectedLocationId, canWrite, client, refreshSummary } =
		useReservationsSetupContext()

	if (!selectedLocationId) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Add a location to set up the waitlist.</Trans>
			</p>
		)
	}

	return (
		<WaitlistSettingsScreen
			key={selectedLocationId}
			client={client}
			locationId={selectedLocationId}
			canWrite={canWrite}
			onSaved={refreshSummary}
		/>
	)
}
