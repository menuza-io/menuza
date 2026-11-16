import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert } from '@repo/ui/alert'

import { type LocationOrderingControl } from '#app/utils/location/ordering-pause.ts'

export function PrepScheduleBanner({
	locations,
}: {
	locations: LocationOrderingControl[]
}) {
	const { _, i18n } = useLingui()
	const active = locations.filter((loc) => loc.variablePrepMinutes != null)
	if (!active.length) return null

	return (
		<div className="space-y-2">
			{active.map((loc) => {
				const minutes = loc.variablePrepMinutes ?? 0
				const until = loc.variablePrepUntil
					? new Intl.DateTimeFormat(i18n.locale, {
							timeZone: loc.timezone,
							hour: 'numeric',
							minute: '2-digit',
						}).format(new Date(loc.variablePrepUntil))
					: null
				const body = until
					? _(msg`Variable prep in force: ${minutes} minutes until ${until}.`)
					: _(msg`Variable prep in force: ${minutes} minutes.`)
				return (
					<Alert key={loc.id}>
						<p className="text-sm">
							<strong>{loc.name}</strong>
							{': '}
							{body}
						</p>
					</Alert>
				)
			})}
		</div>
	)
}
