import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { useEffect, useState } from 'react'
import {
	type EditorErrors,
	type ScheduleRow,
} from '#app/utils/discounts/editor-model.ts'
import { WEEK_ORDER, weekdayLabel } from '#app/utils/discounts/labels.ts'
import { FieldErrorText, fieldDomId, useEditorErrorText } from './fields.tsx'

const DEFAULT_START = '09:00'
const DEFAULT_END = '17:00'

/**
 * Weekly hours: each day can hold several windows. A window that ends before
 * it starts runs past midnight into the next day.
 */
export function WeeklyHours({
	rows,
	onChange,
	errors,
	locale,
}: {
	rows: readonly ScheduleRow[]
	onChange: (rows: ScheduleRow[]) => void
	errors: EditorErrors
	locale: string
}) {
	const { t } = useLingui()
	const errorText = useEditorErrorText()
	const [focusId, setFocusId] = useState<string | null>(null)
	const [announcement, setAnnouncement] = useState('')
	useEffect(() => {
		if (focusId === null) return
		document.getElementById(focusId)?.focus()
		setFocusId(null)
	}, [focusId, rows.length])
	const update = (index: number, patch: Partial<ScheduleRow>) =>
		onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

	return (
		<div
			id={fieldDomId('schedule')}
			tabIndex={-1}
			className="flex flex-col gap-1 outline-none"
		>
			<ul className="divide-border divide-y rounded-lg border">
				{WEEK_ORDER.map((day) => {
					const dayName = weekdayLabel(day, locale, 'long')
					const windows = rows
						.map((row, index) => ({ row, index }))
						.filter(({ row }) => row.day === day)
					return (
						<li
							key={day}
							className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:gap-4"
						>
							<span className="w-24 shrink-0 pt-1.5 text-sm font-medium">
								{dayName}
							</span>
							<div className="flex min-w-0 flex-1 flex-col gap-2">
								{windows.length === 0 ? (
									<span className="text-muted-foreground pt-1.5 text-sm">
										<Trans>Not available</Trans>
									</span>
								) : null}
								{windows.map(({ row, index }) => {
									const endError = errors[`schedule.${index}.end`]
									const startError = errors[`schedule.${index}.start`]
									const message = endError ?? startError
									const overnight =
										!message && row.end < row.start && row.end !== ''
									const errorId = `${fieldDomId(`schedule-${index}`)}-error`
									return (
										<div key={index} className="flex flex-col gap-1">
											<div className="flex flex-wrap items-center gap-2">
												<Input
													id={fieldDomId(`schedule.${index}.start`)}
													type="time"
													value={row.start}
													onChange={(event) =>
														update(index, { start: event.target.value })
													}
													aria-label={t`${dayName} opens`}
													aria-invalid={startError ? true : undefined}
													aria-describedby={message ? errorId : undefined}
													className="w-32"
													dir="ltr"
												/>
												<span aria-hidden className="text-muted-foreground">
													–
												</span>
												<Input
													id={fieldDomId(`schedule.${index}.end`)}
													type="time"
													value={row.end}
													onChange={(event) =>
														update(index, { end: event.target.value })
													}
													aria-label={t`${dayName} closes`}
													aria-invalid={endError ? true : undefined}
													aria-describedby={message ? errorId : undefined}
													className="w-32"
													dir="ltr"
												/>
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={t`Remove these hours on ${dayName}`}
													onClick={() => {
														onChange(rows.filter((_, i) => i !== index))
														setAnnouncement(t`Hours removed on ${dayName}.`)
														// Focus goes to this day's Add button, which stays.
														setFocusId(`${fieldDomId('schedule')}-add-${day}`)
													}}
												>
													<Icon name="x" />
												</Button>
											</div>
											{overnight ? (
												<span className="text-muted-foreground text-xs">
													<Trans>Ends the next morning.</Trans>
												</span>
											) : null}
											{message ? (
												<FieldErrorText id={errorId}>
													{errorText(message)}
												</FieldErrorText>
											) : null}
										</div>
									)
								})}
								<div>
									<Button
										type="button"
										variant="ghost"
										size="xs"
										aria-label={t`Add hours on ${dayName}`}
										id={`${fieldDomId('schedule')}-add-${day}`}
										onClick={() => {
											onChange([
												...rows,
												{ day, start: DEFAULT_START, end: DEFAULT_END },
											])
											setFocusId(fieldDomId(`schedule.${rows.length}.start`))
											setAnnouncement(t`Hours added on ${dayName}.`)
										}}
									>
										<Icon name="plus" data-icon="inline-start" />
										<Trans>Add hours</Trans>
									</Button>
								</div>
							</div>
						</li>
					)
				})}
			</ul>
			<p role="status" className="sr-only">
				{announcement}
			</p>
			{errors.schedule ? (
				<FieldErrorText id={`${fieldDomId('schedule')}-error`}>
					{errorText(errors.schedule)}
				</FieldErrorText>
			) : null}
		</div>
	)
}
