import { useLoaderData } from 'react-router'
import { ReportsScreen } from '#app/components/reservations/reports/reports-screen.tsx'
import { useReservationsScopeClient } from '#app/hooks/use-reservations-client.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/reports.ts'
import { useReservationsLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.reports,
	)
	return { orgSlug: access.organizationSlug }
}

export default function ReservationsReportsRoute() {
	const { orgSlug } = useLoaderData<typeof loader>()
	const { activeLocationId, locations, todayDate } = useReservationsLayoutData()
	const locationId =
		locations.find((loc) => loc.id === activeLocationId)?.id ??
		locations[0]?.id ??
		''
	const client = useReservationsScopeClient(
		orgSlug,
		'reports',
		locationId ? [locationId] : undefined,
	)
	return (
		<ReportsScreen client={client} locationId={locationId} today={todayDate} />
	)
}
