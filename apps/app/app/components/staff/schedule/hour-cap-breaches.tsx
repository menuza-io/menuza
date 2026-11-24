import { Plural, Trans } from '@lingui/macro'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { type HourCapBreachRow } from '#app/utils/staffing/schedule-types.ts'
import { formatDuration } from '#app/utils/staffing/schedule-view.ts'

/**
 * Who a publish or an approval would take over an hour cap (#527), with the
 * reason the manager gives to go ahead. A warning, not a block: nothing is
 * published until the manager writes why, and the reason is audited.
 */
export function HourCapBreaches({
	breaches,
	total,
	nameOf,
	reason,
	onReason,
}: {
	breaches: readonly HourCapBreachRow[]
	total: number
	/** A person's display name from their id. */
	nameOf: (staffId: string) => string
	reason: string
	onReason: (value: string) => void
}) {
	return (
		<div className="flex flex-col gap-3">
			<Alert>
				<AlertTitle>
					<Plural
						value={total}
						one="# person would go over an hour limit"
						other="# shifts would take people over an hour limit"
					/>
				</AlertTitle>
				<AlertDescription>
					<ul className="mt-2 flex flex-col gap-1 text-sm">
						{breaches.map((breach) => {
							const scheduled = formatDuration(breach.scheduledMinutes)
							const limit = formatDuration(breach.capMinutes)
							return (
								<li key={`${breach.shiftId}:${breach.kind}`}>
									<bdi>{nameOf(breach.staffId)}</bdi>
									{' · '}
									<bdi>{breach.date}</bdi>
									{' · '}
									{breach.kind === 'daily' ? (
										<Trans>
											<bdi>{scheduled}</bdi> in a day, limit <bdi>{limit}</bdi>
										</Trans>
									) : (
										<Trans>
											<bdi>{scheduled}</bdi> in a week, limit <bdi>{limit}</bdi>
										</Trans>
									)}
								</li>
							)
						})}
					</ul>
				</AlertDescription>
			</Alert>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="hour-cap-reason">
					<Trans>Why go ahead?</Trans>
				</Label>
				<Textarea
					id="hour-cap-reason"
					value={reason}
					maxLength={500}
					rows={2}
					onChange={(event) => onReason(event.target.value)}
				/>
				<p className="text-muted-foreground text-sm">
					<Trans>Your reason is kept in the audit log.</Trans>
				</p>
			</div>
		</div>
	)
}
