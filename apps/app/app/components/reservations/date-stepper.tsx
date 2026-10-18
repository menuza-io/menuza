import { useLingui } from '@lingui/react/macro'
import { addDays } from '@repo/reservations'
import { useDirection } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Calendar } from '@repo/ui/calendar'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { ar, enUS } from 'date-fns/locale'
import { useState } from 'react'

function toLocalDate(date: string): Date {
	const [year = 1970, month = 1, day = 1] = date.split('-').map(Number)
	return new Date(year, month - 1, day, 12)
}

function fromLocalDate(value: Date): string {
	const month = String(value.getMonth() + 1).padStart(2, '0')
	const day = String(value.getDate()).padStart(2, '0')
	return `${value.getFullYear()}-${month}-${day}`
}

/**
 * Previous day, a date picker, next day and a jump to today: the same
 * control as the Staff schedule toolbar, 44px on touch widths. Dates are
 * plain `YYYY-MM-DD` business dates.
 */
export function DateStepper({
	date,
	today,
	onChange,
	testIdPrefix = 'host',
}: {
	date: string
	today?: string
	onChange: (next: string) => void
	testIdPrefix?: string
}) {
	const { t, i18n } = useLingui()
	const direction = useDirection()
	const rtl = direction === 'rtl'
	const [open, setOpen] = useState(false)
	const locale = i18n.locale
	const label = new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(`${date}T12:00:00Z`))
	const pickerLabel = t`Choose a date: ${label}`

	return (
		<div className="flex max-w-full flex-wrap items-center gap-1.5">
			<Button
				type="button"
				variant="outline"
				size="icon"
				onClick={() => onChange(addDays(date, -1))}
				aria-label={t`Previous day`}
				data-testid={`${testIdPrefix}-prev-day-btn`}
			>
				<Icon name={rtl ? 'chevron-right' : 'chevron-left'} />
			</Button>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					render={
						<Button
							type="button"
							variant="outline"
							className="h-11 min-w-0 flex-1 justify-between gap-3 rounded-md sm:min-w-44 sm:flex-none md:h-8"
							aria-label={pickerLabel}
							data-testid={`${testIdPrefix}-date-input`}
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
						onSelect={(picked) => {
							if (!picked) return
							onChange(fromLocalDate(picked))
							setOpen(false)
						}}
						locale={locale.startsWith('ar') ? ar : enUS}
						dir={direction}
					/>
				</PopoverContent>
			</Popover>
			<Button
				type="button"
				variant="outline"
				size="icon"
				onClick={() => onChange(addDays(date, 1))}
				aria-label={t`Next day`}
				data-testid={`${testIdPrefix}-next-day-btn`}
			>
				<Icon name={rtl ? 'chevron-left' : 'chevron-right'} />
			</Button>
			{today ? (
				<Button
					type="button"
					variant="ghost"
					className="h-11 md:h-8"
					disabled={date === today}
					onClick={() => onChange(today)}
					data-testid={`${testIdPrefix}-today-jump-btn`}
				>
					{t`Today`}
				</Button>
			) : null}
		</div>
	)
}
