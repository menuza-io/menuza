import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { Item, ItemContent, ItemGroup } from '@repo/ui/item'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'
import { type StaffPositionRow } from '#app/utils/staffing/staff-types.ts'
import { formatClockTime } from '#app/utils/staffing/timeclock-format.ts'
import {
	changedFields,
	type ChangedField,
} from '#app/utils/staffing/timesheet-history.ts'
import {
	type EditLogRow,
	type PunchRow,
} from '#app/utils/staffing/timesheet-types.ts'
import {
	calendarDateOf,
	formatDateLabel,
	formatHours,
} from '#app/utils/staffing/timesheet-view.ts'

type Props = {
	edits: readonly EditLogRow[]
	punches: readonly PunchRow[]
	timeZone: string
	locale: string
	currency: string | null
	positions: ReadonlyMap<string, StaffPositionRow>
}

/**
 * Everything that happened to a card, newest first, in plain words: who did
 * what, when, why, and what it did to the paid hours. The punches the tablet
 * recorded sit underneath, because "what did they actually punch" is the
 * question behind most edits. Nothing here can be changed or removed.
 */
export function CardHistory({
	edits,
	punches,
	timeZone,
	locale,
	currency,
	positions,
}: Props) {
	const { _ } = useLingui()
	const actions: Record<string, string> = {
		create: _(t`Added by a manager`),
		update: _(t`Edited`),
		void: _(t`Deleted`),
		review: _(t`Marked as reviewed`),
		approve: _(t`Approved`),
		lock: _(t`Locked`),
		unlock: _(t`Unlocked`),
		reopen: _(t`Reopened`),
	}
	const punchKinds: Record<string, string> = {
		clock_in: _(t`Clock in`),
		clock_out: _(t`Clock out`),
		break_start: _(t`Break start`),
		break_end: _(t`Break end`),
	}
	const punchSources: Record<string, string> = {
		kiosk: _(t`Tablet`),
		pos: _(t`Station`),
		web: _(t`Web`),
		mobile: _(t`Phone`),
		manager: _(t`Manager`),
	}

	function stamp(at: number) {
		return `${formatDateLabel(calendarDateOf(at, timeZone), locale)}, ${formatClockTime(at, timeZone, locale)}`
	}
	function time(at: number | null) {
		return at === null ? _(t`none`) : formatClockTime(at, timeZone, locale)
	}
	function money(minor: number | null) {
		if (minor === null) return _(t`none`)
		return currency
			? formatMoneyMinor(minor, currency, locale)
			: (minor / 100).toFixed(2)
	}

	function describe(change: ChangedField): string {
		switch (change.field) {
			case 'clockInAt': {
				const from = time(change.before)
				const to = time(change.after)
				return _(t`Clock in: ${from} to ${to}`)
			}
			case 'clockOutAt': {
				const from = time(change.before)
				const to = time(change.after)
				return _(t`Clock out: ${from} to ${to}`)
			}
			case 'cashTipsMinor': {
				const from = money(change.before)
				const to = money(change.after)
				return _(t`Cash tips: ${from} to ${to}`)
			}
			case 'creditTipsMinor': {
				const from = money(change.before)
				const to = money(change.after)
				return _(t`Credit tips: ${from} to ${to}`)
			}
			case 'positionId': {
				const from = change.before
					? (positions.get(change.before)?.name ?? _(t`another position`))
					: _(t`none`)
				const to = change.after
					? (positions.get(change.after)?.name ?? _(t`another position`))
					: _(t`none`)
				return _(t`Position: ${from} to ${to}`)
			}
			case 'managerNote':
				return change.after ? _(t`Note changed`) : _(t`Note removed`)
			case 'breaks': {
				const before = change.before.length
				const after = change.after.length
				return _(t`Breaks: ${before} to ${after}`)
			}
		}
	}

	function hoursDelta(delta: number): string {
		const hours = formatHours(Math.abs(delta), locale)
		return delta > 0 ? _(t`Paid hours +${hours}`) : _(t`Paid hours −${hours}`)
	}

	return (
		<div className="flex flex-col gap-6">
			<section aria-labelledby="card-history" className="flex flex-col gap-3">
				<h3 id="card-history" className="text-sm font-medium">
					<Trans>History</Trans>
				</h3>
				{edits.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							Nobody has changed this card. It is exactly as it was punched.
						</Trans>
					</p>
				) : (
					<ol className="border-border ms-1.5 flex flex-col gap-5 border-s ps-4">
						{edits.map((edit) => {
							const changes = changedFields(edit)
							const delta = edit.hoursDeltaMinutes
							return (
								<li key={edit.id} className="relative flex flex-col gap-1">
									<span
										aria-hidden="true"
										className="bg-border ring-background absolute -start-[1.3125rem] top-1.5 size-2 rounded-full ring-4"
									/>
									<p className="text-sm">
										<span className="font-medium">
											{actions[edit.action] ?? edit.action}
										</span>
										<span className="text-muted-foreground">
											{' '}
											·{' '}
											{edit.via === 'manager'
												? _(t`by a manager`)
												: _(t`by the time clock`)}{' '}
											· {stamp(edit.createdAt)}
										</span>
									</p>
									<p className="text-sm">“{edit.reason}”</p>
									{changes.length > 0 ? (
										<ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
											{changes.map((change) => (
												<li key={change.field}>{describe(change)}</li>
											))}
										</ul>
									) : null}
									{delta !== null && delta !== 0 ? (
										<p className="text-xs font-medium tabular-nums">
											{hoursDelta(delta)}
										</p>
									) : null}
								</li>
							)
						})}
					</ol>
				)}
			</section>

			{punches.length > 0 ? (
				<section aria-labelledby="card-punches" className="flex flex-col gap-3">
					<h3 id="card-punches" className="text-sm font-medium">
						<Trans>As punched</Trans>
					</h3>
					<ItemGroup className="gap-2">
						{punches.map((punch) => (
							<Item key={punch.id} variant="outline" size="sm">
								<ItemContent>
									<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
										<span className="flex items-center gap-2">
											<Icon
												name="clock"
												className="text-muted-foreground size-4"
											/>
											{punchKinds[punch.kind] ?? punch.kind}
										</span>
										<span className="text-muted-foreground tabular-nums">
											{formatClockTime(
												punch.effectiveAt ?? punch.serverAt,
												timeZone,
												locale,
											)}{' '}
											· {punchSources[punch.source] ?? punch.source}
											{punch.flags.includes('offline_punch')
												? ` · ${_(t`sent later`)}`
												: ''}
										</span>
									</div>
								</ItemContent>
							</Item>
						))}
					</ItemGroup>
				</section>
			) : null}
		</div>
	)
}
