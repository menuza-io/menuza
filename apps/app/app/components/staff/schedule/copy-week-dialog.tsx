import { Trans, plural, t } from '@lingui/macro'
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
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { type FormEvent, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SelectField } from '#app/components/staff/controls.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { copyWeek } from '#app/utils/staffing/schedule-api.ts'
import { describeScheduleError } from '#app/utils/staffing/schedule-errors.ts'
import {
	EMPTY_SCOPE,
	scopeFromState,
	weekChoices,
	type ScopeState,
} from '#app/utils/staffing/schedule-form.ts'
import {
	type CopyResultRow,
	type ScheduleWeek,
} from '#app/utils/staffing/schedule-types.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { formatPeriodLabel } from '#app/utils/staffing/timesheet-view.ts'
import { ScopePicker } from './scope-picker.tsx'

/** The sentence after a copy or a template: what was added and what was left out. */
export function describeCopyResult(result: CopyResultRow): string {
	const parts = [
		plural(result.created, { one: '# shift added.', other: '# shifts added.' }),
	]
	if (result.skippedDuplicates > 0) {
		parts.push(
			plural(result.skippedDuplicates, {
				one: '# was already on the schedule.',
				other: '# were already on the schedule.',
			}),
		)
	}
	if (result.openedForInactive > 0) {
		parts.push(
			plural(result.openedForInactive, {
				one: '# became an open shift because the person has left.',
				other: '# became open shifts because their people have left.',
			}),
		)
	}
	if (result.skippedUnplaceable > 0) {
		parts.push(
			plural(result.skippedUnplaceable, {
				one: '# could not be placed in that week.',
				other: '# could not be placed in that week.',
			}),
		)
	}
	return parts.join(' ')
}

/**
 * Copy a week's shifts into another week. Shifts keep their wall-clock times
 * (a 9:00 shift stays at 9:00 across a clock change), people who have left
 * become open shifts, and shifts already there are not doubled.
 */
export function CopyWeekDialog({
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
	onDone: (weekStart: string) => void
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
				{open ? (
					<CopyBody
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

function CopyBody({
	client,
	scopeId,
	week,
	locale,
	onClose,
	onDone,
}: Omit<Parameters<typeof CopyWeekDialog>[0], 'open'>) {
	const { _ } = useLingui()
	const action = useStaffAction(describeScheduleError)
	const [direction, setDirection] = useState<'into' | 'from'>('into')
	const [other, setOther] = useState(addDays(week.weekStart, -7))
	const [scope, setScope] = useState<ScopeState>(EMPTY_SCOPE)
	const [includeOpen, setIncludeOpen] = useState(true)
	const [showScopeError, setShowScopeError] = useState(false)
	const options = useMemo(
		() =>
			weekChoices(week.weekStart, 8, 8)
				.filter((start) => start !== week.weekStart)
				.map((start) => ({
					value: start,
					label: formatPeriodLabel(start, addDays(start, 6), locale),
				})),
		[week.weekStart, locale],
	)
	const resolved = scopeFromState(scope)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!resolved) {
			setShowScopeError(true)
			return
		}
		const result = await action.run(() =>
			copyWeek(client, {
				scopeId,
				fromWeekStart: direction === 'into' ? other : week.weekStart,
				toWeekStart: direction === 'into' ? week.weekStart : other,
				scope: resolved,
				includeOpenShifts: includeOpen,
			}),
		)
		if (!result.ok) return
		toast.success(describeCopyResult(result.value))
		onDone(result.value.weekStart)
		onClose()
	}

	return (
		<form onSubmit={submit} noValidate className="flex flex-col gap-5">
			<DialogHeader>
				<DialogTitle>
					<Trans>Copy a week</Trans>
				</DialogTitle>
				<DialogDescription>
					<Trans>
						Copied shifts arrive as drafts. Nothing reaches your team until you
						publish.
					</Trans>
				</DialogDescription>
			</DialogHeader>
			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
			<ToggleGroup
				variant="outline"
				spacing={1}
				value={[direction]}
				aria-label={_(t`Direction`)}
				onValueChange={(next) => {
					const picked = next[0] as 'into' | 'from' | undefined
					if (picked) setDirection(picked)
				}}
			>
				<ToggleGroupItem className="h-11" value="into">
					<Trans>Copy into this week</Trans>
				</ToggleGroupItem>
				<ToggleGroupItem className="h-11" value="from">
					<Trans>Copy this week elsewhere</Trans>
				</ToggleGroupItem>
			</ToggleGroup>
			<SelectField
				label={
					direction === 'into' ? (
						<Trans>Copy from</Trans>
					) : (
						<Trans>Copy to</Trans>
					)
				}
				value={other}
				options={options}
				onValueChange={setOther}
			/>
			<ScopePicker
				value={scope}
				onChange={setScope}
				week={week}
				locale={locale}
			/>
			{showScopeError && !resolved ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>Choose at least one to copy.</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			<SwitchField
				label={<Trans>Include open shifts</Trans>}
				description={
					<Trans>
						Open shifts are left out when you copy only some people.
					</Trans>
				}
				checked={includeOpen}
				onCheckedChange={setIncludeOpen}
			/>
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={onClose}>
					<Trans>Cancel</Trans>
				</Button>
				<Button type="submit" disabled={action.pending}>
					{action.pending ? (
						<Trans>Copying…</Trans>
					) : (
						<Trans>Copy shifts</Trans>
					)}
				</Button>
			</DialogFooter>
		</form>
	)
}
