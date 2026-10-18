import { Trans, useLingui } from '@lingui/react/macro'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'

/**
 * Sections whose screens do not read the `date` search param: the date control
 * would change nothing there (Reports has its own range filter). Location still
 * applies everywhere. There is no Service control in this header: the host
 * stand views carry their own, built from the location's real services.
 */
const SECTIONS_WITHOUT_DATE = new Set([
	'guests',
	'reports',
	'experiences',
	'settings',
])

export function reservationsHeaderShowsDate(
	pathname: string,
	orgSlug: string,
): boolean {
	const prefix = `/${orgSlug}/reservations/`
	if (!pathname.startsWith(prefix)) return true
	const section = pathname.slice(prefix.length).split(/[/?#]/)[0] ?? ''
	return !SECTIONS_WITHOUT_DATE.has(section)
}

export type HeaderControlsLocation = { id: string; name: string }

export function ReservationsHeaderControls({
	locations,
	selectedLocationId,
	selectedDate,
	showDate,
	onChange,
}: {
	locations: readonly HeaderControlsLocation[]
	selectedLocationId: string
	selectedDate: string
	showDate: boolean
	onChange: (key: 'locationId' | 'date', value: string) => void
}) {
	const { t } = useLingui()
	return (
		<div className="flex flex-wrap items-center gap-3">
			{locations.length > 1 ? (
				<div className="flex items-center gap-2">
					<Label
						htmlFor="reservations-location-select"
						className="text-muted-foreground text-xs font-medium"
					>
						<Trans>Location</Trans>
					</Label>
					<select
						id="reservations-location-select"
						aria-label={t`Location`}
						value={selectedLocationId}
						onChange={(event) => onChange('locationId', event.target.value)}
						className="border-input bg-background text-foreground h-9 rounded-md border px-2.5 text-sm"
					>
						{locations.map((loc) => (
							<option key={loc.id} value={loc.id}>
								{loc.name}
							</option>
						))}
					</select>
				</div>
			) : null}

			{showDate ? (
				<div className="flex items-center gap-2">
					<Label
						htmlFor="reservations-date-input"
						className="text-muted-foreground text-xs font-medium"
					>
						<Trans>Date</Trans>
					</Label>
					<Input
						id="reservations-date-input"
						aria-label={t`Date`}
						type="date"
						value={selectedDate}
						onChange={(event) => onChange('date', event.target.value)}
						className="h-9 w-40"
					/>
				</div>
			) : null}
		</div>
	)
}
