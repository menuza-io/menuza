import { Trans } from '@lingui/react/macro'
import { useLoaderData } from 'react-router'
import { PoliciesScreen } from '#app/components/reservations/policies/policies-screen.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/settings.policies.ts'
import { useReservationsSetupContext } from './settings.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(request, params.orgSlug, {
		feature: 'payments',
		anyOf: RESERVATIONS_SECTION_REQUIREMENTS.settings.anyOf,
	})
	// The region only decides which hint the form shows; it is not guest data.
	return { region: access.dataRegion }
}

export default function ReservationsSettingsPoliciesRoute() {
	const { region } = useLoaderData<typeof loader>()
	const { selectedLocationId, canWrite, client, refreshSummary } =
		useReservationsSetupContext()

	if (!selectedLocationId) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Add a location to set up payment policies.</Trans>
			</p>
		)
	}

	return (
		<PoliciesScreen
			key={selectedLocationId}
			client={client}
			locationId={selectedLocationId}
			canWrite={canWrite}
			region={region}
			onSettingsSaved={() => void refreshSummary()}
		/>
	)
}
