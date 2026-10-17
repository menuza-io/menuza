import { Trans } from '@lingui/react/macro'
import { useLoaderData } from 'react-router'
import { MessageSettingsScreen } from '#app/components/reservations/messages/message-settings.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/settings.messages.ts'
import { useReservationsSetupContext } from './settings.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.settings,
	)
	return {
		waitlistEnabled: access.features.waitlist,
		dataRegion: access.dataRegion,
	}
}

export default function ReservationsSettingsMessagesRoute() {
	const { waitlistEnabled, dataRegion } = useLoaderData<typeof loader>()
	const { selectedLocationId, canWrite, client } = useReservationsSetupContext()

	if (!selectedLocationId) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Add a location to set up guest messages.</Trans>
			</p>
		)
	}

	return (
		<MessageSettingsScreen
			key={selectedLocationId}
			client={client}
			locationId={selectedLocationId}
			canWrite={canWrite}
			waitlistEnabled={waitlistEnabled}
			dataRegion={dataRegion}
		/>
	)
}
