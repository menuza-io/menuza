import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ReservationsSectionPlaceholder } from '#app/components/reservations/section-placeholder.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/book.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.book,
	)
	return null
}

export default function ReservationsBookRoute() {
	const { _ } = useLingui()
	return (
		<ReservationsSectionPlaceholder
			title={_(t`Book`)}
			description={_(
				t`Reservation book, timeline grid, shift notes, and booking management.`,
			)}
			emptyTitle={_(t`Reservation book is ready`)}
			emptyDescription={_(
				t`Browse reservations by date and service, view table timeline blocks, and create new bookings.`,
			)}
			icons={['calendar', 'users', 'clock']}
		/>
	)
}
