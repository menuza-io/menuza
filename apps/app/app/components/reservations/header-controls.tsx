import { useLingui } from '@lingui/react/macro'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	isHostRoute,
	reservationsRouteKey,
} from '#app/utils/reservations/shell-routes.ts'

/**
 * The date, service and area controls belong to the day views only (Today,
 * List, Timeline, Floor, Calendar, Overview). Guests, Reports, Waitlist,
 * Experiences and Settings do not read the `date` search param, so no date
 * control is shown there. Location applies everywhere. There is no made-up
 * Service control: the day views build theirs from the location's services.
 */
export function reservationsHeaderShowsDate(
	pathname: string,
	orgSlug: string,
): boolean {
	return isHostRoute(reservationsRouteKey(pathname, orgSlug))
}

export type HeaderControlsLocation = { id: string; name: string }

/** The location picker: no control at all for a single location. */
export function ReservationsHeaderControls({
	locations,
	selectedLocationId,
	onChange,
}: {
	locations: readonly HeaderControlsLocation[]
	selectedLocationId: string
	onChange: (key: 'locationId', value: string) => void
}) {
	const { t } = useLingui()
	return locations.length > 1 ? (
		<FilterSelect
			id="reservations-location-select"
			testId="reservations-location-select"
			label={t`Location`}
			options={locations.map((loc) => ({ value: loc.id, label: loc.name }))}
			value={selectedLocationId}
			onValueChange={(value) => onChange('locationId', value)}
		/>
	) : null
}
