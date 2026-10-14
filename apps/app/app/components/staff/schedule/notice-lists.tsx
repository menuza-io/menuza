import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SchedulePersonRow } from '#app/utils/staffing/schedule-types.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'

/**
 * Who a publication could not reach and why, shared by the publish result and
 * the publish history. Names come from the week on screen (the schedule scope
 * already names people); anyone no longer on it is "A former team member".
 */

export function useReasonLabel() {
	const { _ } = useLingui()
	return (reason: string | null): string => {
		switch (reason) {
			case 'no_email':
				return _(t`No email address on file`)
			case 'inactive':
				return _(t`No longer on the team`)
			case 'email_disabled':
				return _(t`Email is switched off`)
			case 'superseded':
				return _(t`Replaced by a newer message`)
			case 'stale':
				return _(t`Too old to send`)
			case 'staff_inactive':
				return _(t`No longer on the team`)
			case 'staff_missing':
				return _(t`No longer on the roster`)
			default:
				return reason ? _(t`Could not be sent`) : _(t`Not sent`)
		}
	}
}

export function usePersonName(
	people: readonly SchedulePersonRow[],
	locale: string,
) {
	const { _ } = useLingui()
	const byId = new Map(people.map((person) => [person.id, person]))
	return (staffId: string): string => {
		const person = byId.get(staffId)
		return person
			? staffDisplayName(person, locale)
			: _(t`A former team member`)
	}
}

export function NotReachedList({
	entries,
	people,
	locale,
}: {
	entries: ReadonlyArray<{ staffId: string; reason: string }>
	people: readonly SchedulePersonRow[]
	locale: string
}) {
	const reasonLabel = useReasonLabel()
	const nameOf = usePersonName(people, locale)
	if (entries.length === 0) return null
	return (
		<div className="flex flex-col gap-2">
			<h3 className="text-sm font-medium">
				<Trans>Not notified</Trans>
			</h3>
			<ul className="divide-border divide-y text-sm">
				{entries.map((entry) => (
					<li
						key={entry.staffId}
						className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 first:pt-0 last:pb-0"
					>
						<span>{nameOf(entry.staffId)}</span>
						<span className="text-muted-foreground text-xs">
							{reasonLabel(entry.reason)}
						</span>
					</li>
				))}
			</ul>
		</div>
	)
}
