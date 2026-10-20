import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { TIMESHEET_STATUSES } from '@repo/staffing'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { useEffect, useState } from 'react'
import { FilterSelect, type Option } from '#app/components/staff/controls.tsx'
import {
	type TimesheetGroup,
	type TimesheetSearch,
} from '#app/utils/staffing/timesheet-view.ts'
import { STATUS_LABELS } from './issue-copy.ts'

/**
 * Narrow what the list shows. Scope, position and status are asked of the
 * regional node (so totals and overtime stay right); the text box filters the
 * people already on screen. Every choice lives in the address bar so a view can
 * be bookmarked or sent to a colleague.
 */
export function TimesheetFilters({
	search,
	onChange,
	scopes,
	positions,
	view,
}: {
	search: TimesheetSearch
	onChange: (patch: Partial<TimesheetSearch>) => void
	scopes: readonly Option[]
	positions: readonly Option[]
	view: 'day' | 'period' | 'review' | 'summary'
}) {
	const { _ } = useLingui()
	const [text, setText] = useState(search.q)
	// Typing waits a beat before it reaches the address bar.
	useEffect(() => {
		if (text === search.q) return
		const timer = setTimeout(() => onChange({ q: text }), 250)
		return () => clearTimeout(timer)
		// `onChange` changes with every address-bar update; only the text matters.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text])
	// Clearing the filters from elsewhere empties the box too.
	useEffect(() => {
		setText(search.q)
	}, [search.q])

	const showList = view === 'day' || view === 'period'
	const groups: Array<{ value: TimesheetGroup; label: string }> = [
		{ value: 'person', label: _(t`Group by person`) },
		...(view === 'period'
			? [{ value: 'date' as const, label: _(t`Group by date`) }]
			: []),
		{ value: 'position', label: _(t`Group by position`) },
	]
	const statuses: Option[] = [
		{ value: 'all', label: _(t`Any status`) },
		...TIMESHEET_STATUSES.map((value) => ({
			value,
			label: _(STATUS_LABELS[value]),
		})),
	]
	return (
		<div
			role="search"
			className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center"
		>
			{showList ? (
				<div className="relative col-span-2 md:w-60">
					<Icon
						name="search"
						className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
					/>
					<Input
						type="search"
						value={text}
						onChange={(event) => setText(event.target.value)}
						placeholder={_(t`Search name or position`)}
						aria-label={_(t`Search time cards`)}
						className="h-11 ps-8 md:h-8"
					/>
				</div>
			) : null}
			{scopes.length > 1 ? (
				<FilterSelect
					label={_(t`Filter by workplace`)}
					options={[{ value: 'all', label: _(t`All workplaces`) }, ...scopes]}
					value={search.scopeId}
					onValueChange={(scopeId) => onChange({ scopeId })}
				/>
			) : null}
			{view !== 'review' && positions.length > 0 ? (
				<FilterSelect
					label={_(t`Filter by position`)}
					options={[{ value: 'all', label: _(t`All positions`) }, ...positions]}
					value={search.positionId}
					onValueChange={(positionId) => onChange({ positionId })}
				/>
			) : null}
			{showList ? (
				<>
					<FilterSelect
						label={_(t`Filter by status`)}
						options={statuses}
						value={search.status}
						onValueChange={(status) =>
							onChange({ status: status as TimesheetSearch['status'] })
						}
					/>
					<FilterSelect
						label={_(t`Group the list`)}
						options={groups}
						value={search.group}
						onValueChange={(group) =>
							onChange({ group: group as TimesheetGroup })
						}
					/>
				</>
			) : null}
		</div>
	)
}
