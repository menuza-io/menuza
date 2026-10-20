import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { formatDate, parseDate } from '@repo/staffing'
import { useDirection } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Calendar } from '@repo/ui/calendar'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { ar, enUS } from 'date-fns/locale'
import { type ReactNode, useId, useState } from 'react'
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

export type DateRange = { from: string | null; to: string | null }

/**
 * One date or a range of dates, picked from a calendar. A single click picks a
 * day; with `range`, the second click ends the range (a click before the first
 * restarts it). The button shows the choice in words.
 */
export function DateRangeField({
	label,
	value,
	onChange,
	locale,
	range = true,
	error,
	min,
}: {
	label: ReactNode
	value: DateRange
	onChange: (next: DateRange) => void
	locale: string
	range?: boolean
	error?: string | null
	/** Earliest date offered. */
	min?: string
}) {
	const { _ } = useLingui()
	const direction = useDirection()
	const [open, setOpen] = useState(false)
	const id = useId()
	const text = value.from
		? value.to && value.to !== value.from
			? formatPeriodLabel(value.from, value.to, locale)
			: formatDateLabel(value.from, locale, {
					weekday: 'short',
					month: 'short',
					day: 'numeric',
					year: 'numeric',
				})
		: null
	return (
		<Field data-invalid={error ? true : undefined}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					render={
						<Button
							id={id}
							type="button"
							variant="outline"
							className="h-11 w-full justify-between gap-3 rounded-md font-normal md:h-8"
							aria-invalid={error ? true : undefined}
						>
							<span className={text ? 'tabular-nums' : 'text-muted-foreground'}>
								{text ?? _(t`Choose a date`)}
							</span>
							<Icon name="calendar" />
						</Button>
					}
				/>
				<PopoverContent align="start" className="w-auto p-1">
					{range ? (
						<Calendar
							mode="range"
							selected={
								value.from
									? {
											from: toLocalDate(value.from),
											to: value.to ? toLocalDate(value.to) : undefined,
										}
									: undefined
							}
							defaultMonth={value.from ? toLocalDate(value.from) : undefined}
							disabled={min ? { before: toLocalDate(min) } : undefined}
							onSelect={(picked, ignoredTrigger) => {
								if (!picked?.from) {
									onChange({ from: null, to: null })
									return
								}
								const from = fromLocalDate(picked.from)
								const to = picked.to ? fromLocalDate(picked.to) : null
								onChange({ from, to })
								if (to && to !== from) setOpen(false)
							}}
							locale={locale.startsWith('ar') ? ar : enUS}
							dir={direction}
						/>
					) : (
						<Calendar
							mode="single"
							selected={value.from ? toLocalDate(value.from) : undefined}
							defaultMonth={value.from ? toLocalDate(value.from) : undefined}
							disabled={min ? { before: toLocalDate(min) } : undefined}
							onSelect={(picked) => {
								if (!picked) return
								onChange({
									from: fromLocalDate(picked),
									to: fromLocalDate(picked),
								})
								setOpen(false)
							}}
							locale={locale.startsWith('ar') ? ar : enUS}
							dir={direction}
						/>
					)}
					{range ? (
						<p className="text-muted-foreground px-3 pb-2 text-xs">
							<Trans>
								Click the first day, then the last day. For one day, click it
								and close.
							</Trans>
						</p>
					) : null}
				</PopoverContent>
			</Popover>
			{error ? <FieldError>{error}</FieldError> : null}
		</Field>
	)
}
