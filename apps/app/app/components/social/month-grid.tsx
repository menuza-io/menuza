import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { type ReactNode } from 'react'
import { monthGrid } from '#app/utils/social/time.ts'

/**
 * The month view both calendars draw (the social posts one and the marketing
 * calendar, #152): seven weekday headings and the 6 x 7 days of a month, today
 * marked, days outside the month dimmed. What goes in a day is up to the
 * caller; a day's name is read aloud as its full date.
 */
export function MonthGrid({
	month,
	today,
	renderDay,
}: {
	/** `YYYY-MM`. */
	month: string
	/** `YYYY-MM-DD`. */
	today: string
	renderDay: (day: { day: string; inMonth: boolean; label: string }) => {
		actions?: ReactNode
		content: ReactNode
	}
}) {
	const { i18n } = useLingui()
	const days = monthGrid(month)
	const weekday = new Intl.DateTimeFormat(i18n.locale, {
		weekday: 'short',
		timeZone: 'UTC',
	})
	const longDay = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'full',
		timeZone: 'UTC',
	})
	return (
		<div className="border-border overflow-hidden rounded-lg border">
			<div className="bg-muted/50 border-border grid grid-cols-7 border-b">
				{days.slice(0, 7).map((day) => (
					<div
						key={day}
						className="text-muted-foreground px-2 py-1.5 text-xs font-medium"
					>
						{weekday.format(new Date(`${day}T00:00:00Z`))}
					</div>
				))}
			</div>
			<ol className="grid grid-cols-7">
				{days.map((day, index) => {
					const inMonth = day.startsWith(month)
					const label = longDay.format(new Date(`${day}T00:00:00Z`))
					const { actions, content } = renderDay({ day, inMonth, label })
					return (
						<li
							key={day}
							aria-label={label}
							className={cn(
								'group border-border relative min-h-20 border-e border-b p-1 sm:min-h-28 sm:p-1.5',
								index % 7 === 6 && 'border-e-0',
								index >= 35 && 'border-b-0',
								!inMonth && 'bg-muted/30',
							)}
						>
							<div className="flex items-center justify-between gap-1">
								<span
									className={cn(
										'grid size-6 place-items-center rounded-full text-xs tabular-nums',
										!inMonth && 'text-muted-foreground',
										day === today && 'bg-primary text-primary-foreground',
									)}
								>
									{Number(day.slice(8))}
								</span>
								{actions}
							</div>
							{content}
						</li>
					)
				})}
			</ol>
		</div>
	)
}
