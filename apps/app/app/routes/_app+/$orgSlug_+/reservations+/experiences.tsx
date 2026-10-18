import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { useLoaderData, useOutlet } from 'react-router'
import { ExperiencesScreen } from '#app/components/reservations/experiences/experiences-screen.tsx'
import { useReservationsClient } from '#app/hooks/use-reservations-client.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/experiences.ts'
import { useReservationsLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.experiences,
	)
	const impersonated = await isImpersonating(request)
	return {
		orgSlug: access.organizationSlug,
		canWrite:
			!impersonated &&
			access.grants.includes(
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
			),
		paymentsEnabled: access.features.payments,
	}
}

/** The experience list, or the editor route nested under it when one is open. */
export default function ReservationsExperiencesRoute() {
	const { orgSlug, canWrite } = useLoaderData<typeof loader>()
	const layout = useReservationsLayoutData()
	const editor = useOutlet(layout)
	const locationId = layout.activeLocationId
	const client = useReservationsClient(
		'setup',
		locationId ? [locationId] : undefined,
	)
	if (editor) return editor
	if (!locationId) {
		return null
	}
	return (
		<ExperiencesScreen
			key={locationId}
			client={client}
			orgSlug={orgSlug}
			locationId={locationId}
			canWrite={canWrite}
		/>
	)
}
