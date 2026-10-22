import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { addDays, formatDate, parseDate } from '@repo/staffing'
import { useDirection } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Calendar } from '@repo/ui/calendar'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Field, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { Switch } from '@repo/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { ar, enUS } from 'date-fns/locale'
import { useId, useState } from 'react'
import { FilterSelect, type Option } from '#app/components/staff/controls.tsx'
import {
	SCHEDULE_VIEWS,
	shiftMonth,
	type ScheduleGroup,
	type ScheduleSearch,
	type ScheduleViewName,
} from '#app/utils/staffing/schedule-view.ts'
import {
	formatDateLabel,
	formatPeriodLabel,
} from '#app/utils/staffing/timesheet-view.ts'

function toLocalDate(date: string): Date {
	const { year, month, day } = parseDate(date)
	return new Date(year, month - 1, day, 12)
}

function fromLocalDate(value: Date): string {
	return formatDate(value.getFullYear(), value.getMonth() + 1, value.getDate())
}

type Props = {
	search: ScheduleSearch
	onChange: (patch: Partial<ScheduleSearch>) => void
	today: string
	locale: string
	/** The week on screen, once loaded (its real start depends on the scope's workweek). */
	weekStart: string | null
	weekEnd: string | null
	scopes: readonly Option[]
	conflictCount: number
	canWrite: boolean
	onAdd: () => void
	onCopyWeek: () => void
	onTemplates: () => void
	onHistory: () => void
	onPrint: () => void
}

/**
 * Where you are and what you can do: move between weeks, days or months,
 * choose the view, scope and grouping, switch conflict flags on or off, add
 * a shift. Less common actions live in one menu so the bar stays calm.
 */
export function ScheduleToolbar({
	search,
	onChange,
	today,
	locale,
	weekStart,
	weekEnd,
	scopes,
	conflictCount,
	canWrite,
	onAdd,
	onCopyWeek,
	onTemplates,
	onHistory,
	onPrint,
}: Props) {
	const { _ } = useLingui()
	const direction = useDirection()
	const rtl = direction === 'rtl'
	const conflictId = useId()
	const [pickerOpen, setPickerOpen] = useState(false)
	const { view, date } = search

	const label =
		view === 'week' && weekStart && weekEnd
			? formatPeriodLabel(weekStart, weekEnd, locale)
			: view === 'month'
				? formatDateLabel(date, locale, { month: 'long', year: 'numeric' })
				: formatDateLabel(date, locale, {
						weekday: 'long',
						month: 'long',
						day: 'numeric',
					})
	const step = (sign: 1 | -1) =>
		view === 'month'
			? shiftMonth(date, sign)
			: addDays(date, (view === 'week' ? 7 : 1) * sign)
	const prevLabel =
		view === 'week'
			? _(t`Previous week`)
			: view === 'day'
				? _(t`Previous day`)
				: _(t`Previous month`)
	const nextLabel =
		view === 'week'
			? _(t`Next week`)
			: view === 'day'
				? _(t`Next day`)
				: _(t`Next month`)
	const todayLabel =
		view === 'week'
			? _(t`This week`)
			: view === 'day'
				? _(t`Today`)
				: _(t`This month`)
	const atToday =
		view === 'week' && weekStart && weekEnd
			? today >= weekStart && today <= weekEnd
			: view === 'month'
				? today.slice(0, 7) === date.slice(0, 7)
				: date === today

	const viewLabels: Record<ScheduleViewName, string> = {
		week: _(t`Week`),
		day: _(t`Day`),
		month: _(t`Month`),
	}
	const groups: Array<{ value: ScheduleGroup; label: string }> = [
		{ value: 'position', label: _(t`Group by position`) },
		{ value: 'none', label: _(t`No grouping`) },
	]
	const selectedRange =
		view === 'week' && weekStart && weekEnd
			? { from: toLocalDate(weekStart), to: toLocalDate(weekEnd) }
			: undefined

	return (
		<div
			role="toolbar"
			aria-label={_(t`Schedule controls`)}
			className="flex flex-col gap-3 print:hidden"
		>
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex max-w-full flex-wrap items-center gap-1.5">
					<Button
						variant="outline"
						size="icon"
						aria-label={prevLabel}
						onClick={() => onChange({ date: step(-1) })}
					>
						<Icon name={rtl ? 'chevron-right' : 'chevron-left'} />
					</Button>
					<Popover open={pickerOpen} onOpenChange={setPickerOpen}>
						<PopoverTrigger
							render={
								<Button
									variant="outline"
									className="h-11 min-w-0 flex-1 justify-between gap-3 rounded-md sm:min-w-48 sm:flex-none md:h-8"
									aria-label={_(t`Choose a date: ${label}`)}
								>
									<span className="tabular-nums">{label}</span>
									<Icon name="calendar" />
								</Button>
							}
						/>
						<PopoverContent align="start" className="w-auto p-1">
							<Calendar
								mode="single"
								selected={toLocalDate(date)}
								defaultMonth={toLocalDate(date)}
								modifiers={selectedRange ? { week: selectedRange } : undefined}
								onSelect={(picked) => {
									if (!picked) return
									onChange({ date: fromLocalDate(picked) })
									setPickerOpen(false)
								}}
								locale={locale.startsWith('ar') ? ar : enUS}
								dir={direction}
							/>
						</PopoverContent>
					</Popover>
					<Button
						variant="outline"
						size="icon"
						aria-label={nextLabel}
						onClick={() => onChange({ date: step(1) })}
					>
						<Icon name={rtl ? 'chevron-left' : 'chevron-right'} />
					</Button>
					<Button
						variant="ghost"
						disabled={atToday}
						onClick={() => onChange({ date: today })}
					>
						{todayLabel}
					</Button>
				</div>

				<div className="ms-auto flex items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="outline"
									aria-label={_(t`More schedule actions`)}
								>
									<Icon name="ellipsis" />
									<span className="hidden sm:inline">
										<Trans>More</Trans>
									</span>
								</Button>
							}
						/>
						<DropdownMenuContent align="end" className="min-w-52">
							{canWrite ? (
								<DropdownMenuItem onClick={onCopyWeek}>
									<Icon name="copy" />
									<Trans>Copy a week…</Trans>
								</DropdownMenuItem>
							) : null}
							<DropdownMenuItem onClick={onTemplates}>
								<Icon name="layout-grid" />
								<Trans>Templates…</Trans>
							</DropdownMenuItem>
							<DropdownMenuItem onClick={onHistory}>
								<Icon name="clock" />
								<Trans>Publish history…</Trans>
							</DropdownMenuItem>
							<DropdownMenuItem onClick={onPrint}>
								<Icon name="file-text" />
								<Trans>Print this view</Trans>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					{canWrite ? (
						<Button onClick={onAdd}>
							<Icon name="plus" />
							<Trans>Add shift</Trans>
						</Button>
					) : null}
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<Tabs
					value={view}
					onValueChange={(next) => {
						const picked = next as ScheduleViewName | undefined
						if (picked && SCHEDULE_VIEWS.includes(picked))
							onChange({ view: picked })
					}}
				>
					<TabsList aria-label={_(t`Schedule view`)}>
						{SCHEDULE_VIEWS.map((value) => (
							<TabsTrigger className="h-11 md:h-7" key={value} value={value}>
								{viewLabels[value]}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				{scopes.length > 1 ? (
					<FilterSelect
						label={_(t`Workplace`)}
						options={scopes}
						value={search.scopeId}
						onValueChange={(scopeId) => onChange({ scopeId })}
					/>
				) : null}
				{view !== 'month' ? (
					<FilterSelect
						label={_(t`Group the schedule`)}
						options={groups}
						value={search.group}
						onValueChange={(group) =>
							onChange({ group: group as ScheduleGroup })
						}
					/>
				) : null}
				{view !== 'month' ? (
					<Field
						orientation="horizontal"
						className="ms-auto min-h-11 w-auto md:min-h-8"
					>
						<Switch
							id={conflictId}
							checked={search.conflicts}
							onCheckedChange={(on) => onChange({ conflicts: Boolean(on) })}
						/>
						<FieldLabel htmlFor={conflictId}>
							<Trans>Show conflicts</Trans>
							{search.conflicts && conflictCount > 0 ? (
								<Badge variant="destructive" className="tabular-nums">
									{conflictCount}
								</Badge>
							) : null}
						</FieldLabel>
					</Field>
				) : null}
			</div>
		</div>
	)
}
