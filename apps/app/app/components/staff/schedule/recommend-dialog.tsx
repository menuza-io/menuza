import { Trans, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { addDays } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SelectField } from '#app/components/staff/controls.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { recommendWeek } from '#app/utils/staffing/schedule-api.ts'
import {
	describeScheduleError,
	OPEN_REASON_COPY,
} from '#app/utils/staffing/schedule-errors.ts'
import {
	EMPTY_SCOPE,
	scopeFromState,
	weekChoices,
	type ScopeState,
} from '#app/utils/staffing/schedule-form.ts'
import {
	type RecommendRow,
	type ScheduleWeek,
} from '#app/utils/staffing/schedule-types.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { formatPeriodLabel } from '#app/utils/staffing/timesheet-view.ts'
import { ScopePicker } from './scope-picker.tsx'

/**
 * "Recommend a schedule": take a past week as the base, keep each person who
 * can still work the same shift, and leave a shift open when its person is on
 * time off, unavailable, double booked or gone. The proposal is shown first and
 * nothing is written until Apply. It is a starting point, not a forecast.
 */
export function RecommendDialog({
	open,
	onClose,
	client,
	scopeId,
	week,
	locale,
	onDone,
}: {
	open: boolean
	onClose: () => void
	client: StaffClient
	scopeId: string
	week: ScheduleWeek
	locale: string
	onDone: () => void
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
				{open ? (
					<Body
						client={client}
						scopeId={scopeId}
						week={week}
						locale={locale}
						onClose={onClose}
						onDone={onDone}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	)
}

function Body({
	client,
	scopeId,
	week,
	locale,
	onClose,
	onDone,
}: Omit<Parameters<typeof RecommendDialog>[0], 'open'>) {
	const { _ } = useLingui()
	const action = useStaffAction(describeScheduleError)
	const [base, setBase] = useState(addDays(week.weekStart, -7))
	const [scope, setScope] = useState<ScopeState>(EMPTY_SCOPE)
	const [proposal, setProposal] = useState<RecommendRow | null>(null)
	const options = useMemo(
		() =>
			weekChoices(week.weekStart, 12, 0)
				.filter((start) => start !== week.weekStart)
				.reverse()
				.map((start) => ({
					value: start,
					label: formatPeriodLabel(start, addDays(start, 6), locale),
				})),
		[week.weekStart, locale],
	)
	const resolved = scopeFromState(scope)

	async function run(apply: boolean) {
		if (!resolved) return
		const result = await action.run(() =>
			recommendWeek(client, {
				scopeId,
				baseWeekStart: base,
				targetWeekStart: week.weekStart,
				scope: resolved,
				apply,
			}),
		)
		if (!result.ok) return
		if (!apply) {
			setProposal(result.value)
			return
		}
		const created = result.value.counts.created
		toast.success(
			plural(created, {
				one: '# draft shift added.',
				other: '# draft shifts added.',
			}),
		)
		onDone()
		onClose()
	}

	const reasons = new Map<string, number>()
	for (const shift of proposal?.shifts ?? []) {
		if (shift.openReason)
			reasons.set(shift.openReason, (reasons.get(shift.openReason) ?? 0) + 1)
	}

	return (
		<div className="flex flex-col gap-5">
			<DialogHeader>
				<DialogTitle>
					<Trans>Recommend a schedule</Trans>
				</DialogTitle>
				<DialogDescription>
					<Trans>
						Start from a past week. Shifts keep their people when they can work
						them, and open up when they cannot.
					</Trans>
				</DialogDescription>
			</DialogHeader>
			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
			<SelectField
				label={<Trans>Base it on</Trans>}
				value={base}
				options={options}
				onValueChange={(next) => {
					setBase(next)
					setProposal(null)
				}}
			/>
			<ScopePicker
				value={scope}
				onChange={(next) => {
					setScope(next)
					setProposal(null)
				}}
				week={week}
				locale={locale}
			/>
			{proposal ? (
				<div
					role="status"
					className="border-border flex flex-col gap-1 rounded-lg border p-3 text-sm"
				>
					{proposal.counts.total === 0 ? (
						<p>
							<Trans>That week has no shifts to start from.</Trans>
						</p>
					) : (
						<>
							<p className="font-medium">
								{plural(proposal.counts.total, {
									one: '# shift would be added as a draft.',
									other: '# shifts would be added as drafts.',
								})}
							</p>
							{proposal.counts.opened > 0 ? (
								<>
									<p>
										{plural(proposal.counts.opened, {
											one: '# would be an open shift, because its person cannot work it:',
											other:
												'# would be open shifts, because their people cannot work them:',
										})}
									</p>
									<ul className="text-muted-foreground ps-5">
										{[...reasons].map(([reason, count]) => (
											<li key={reason} className="list-disc">
												{count}{' '}
												{OPEN_REASON_COPY[reason]
													? _(OPEN_REASON_COPY[reason])
													: reason}
											</li>
										))}
									</ul>
								</>
							) : null}
							{proposal.counts.skippedDuplicates > 0 ? (
								<p className="text-muted-foreground">
									{plural(proposal.counts.skippedDuplicates, {
										one: '# is already on the schedule and is skipped.',
										other: '# are already on the schedule and are skipped.',
									})}
								</p>
							) : null}
						</>
					)}
				</div>
			) : null}
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={onClose}>
					<Trans>Cancel</Trans>
				</Button>
				{proposal && proposal.counts.total > 0 ? (
					<Button
						type="button"
						disabled={action.pending}
						onClick={() => void run(true)}
					>
						<Trans>Add these shifts</Trans>
					</Button>
				) : (
					<Button
						type="button"
						disabled={action.pending || !resolved}
						onClick={() => void run(false)}
					>
						<Trans>Preview</Trans>
					</Button>
				)}
			</DialogFooter>
		</div>
	)
}
