import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { useLoaderData } from 'react-router'
import { ExperienceEditor } from '#app/components/reservations/experiences/experience-editor.tsx'
import { useReservationsClient } from '#app/hooks/use-reservations-client.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/experiences.$id.ts'
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
		experienceId: params.id,
		canWrite:
			!impersonated &&
			access.grants.includes(
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
			),
		paymentsEnabled: access.features.payments,
	}
}

export default function ReservationsExperienceEditorRoute() {
	const { orgSlug, experienceId, canWrite, paymentsEnabled } =
		useLoaderData<typeof loader>()
	const layout = useReservationsLayoutData()
	const locationId = layout.activeLocationId
	const client = useReservationsClient(
		'setup',
		locationId ? [locationId] : undefined,
	)
	if (!locationId) return null
	return (
		<ExperienceEditor
			key={`${locationId}:${experienceId}`}
			client={client}
			locationId={locationId}
			experienceId={experienceId}
			listHref={`/${orgSlug}/reservations/experiences?locationId=${encodeURIComponent(locationId)}`}
			canWrite={canWrite}
			paymentsEnabled={paymentsEnabled}
			today={layout.todayDate}
		/>
	)
}
