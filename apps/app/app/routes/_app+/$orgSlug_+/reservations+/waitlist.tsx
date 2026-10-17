import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { useLoaderData } from 'react-router'
import { WaitlistScreen } from '#app/components/reservations/waitlist/waitlist-screen.tsx'
import { useReservationsScopeClient } from '#app/hooks/use-reservations-client.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/waitlist.ts'
import { useReservationsLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.waitlist,
	)
	const impersonated = await isImpersonating(request)
	return {
		orgSlug: access.organizationSlug,
		canManage:
			!impersonated &&
			access.grants.includes(RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION),
	}
}

export default function ReservationsWaitlistRoute() {
	const { orgSlug, canManage } = useLoaderData<typeof loader>()
	const { activeLocationId, locations } = useReservationsLayoutData()
	const locationId =
		locations.find((loc) => loc.id === activeLocationId)?.id ??
		locations[0]?.id ??
		''
	const client = useReservationsScopeClient(
		orgSlug,
		'book',
		locationId ? [locationId] : undefined,
	)
	return (
		<WaitlistScreen
			client={client}
			locationId={locationId}
			canManage={canManage}
		/>
	)
}
