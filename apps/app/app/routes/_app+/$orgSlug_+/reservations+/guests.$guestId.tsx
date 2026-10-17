import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { useLoaderData } from 'react-router'
import { GuestProfileScreen } from '#app/components/reservations/guests/guest-profile-screen.tsx'
import { useReservationsScopeClient } from '#app/hooks/use-reservations-client.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/guests.$guestId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.guests,
	)
	const impersonated = await isImpersonating(request)
	return {
		orgSlug: access.organizationSlug,
		guestId: params.guestId,
		canManage:
			!impersonated &&
			access.grants.includes(RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST),
	}
}

export default function ReservationsGuestProfileRoute() {
	const { orgSlug, guestId, canManage } = useLoaderData<typeof loader>()
	const client = useReservationsScopeClient(orgSlug, 'guests')
	return (
		<GuestProfileScreen
			client={client}
			orgSlug={orgSlug}
			guestId={guestId}
			canManage={canManage}
		/>
	)
}
