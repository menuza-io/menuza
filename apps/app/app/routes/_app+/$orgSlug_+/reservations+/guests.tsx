import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { useLoaderData, useOutlet, useOutletContext } from 'react-router'
import { GuestListScreen } from '#app/components/reservations/guests/guest-list-screen.tsx'
import { useReservationsScopeClient } from '#app/hooks/use-reservations-client.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/guests.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.guests,
	)
	const impersonated = await isImpersonating(request)
	return {
		orgSlug: access.organizationSlug,
		canManage:
			!impersonated &&
			access.grants.includes(RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST),
	}
}

/** Shows the guest list, or the profile route nested under it when one is open. */
export default function ReservationsGuestsRoute() {
	const { orgSlug } = useLoaderData<typeof loader>()
	const profile = useOutlet()
	const client = useReservationsScopeClient(orgSlug, 'guests')
	const layout = useOutletContext<{ nav?: { book?: boolean } } | null>()
	if (profile) return profile
	return (
		<GuestListScreen
			client={client}
			orgSlug={orgSlug}
			canBook={Boolean(layout?.nav?.book)}
		/>
	)
}
