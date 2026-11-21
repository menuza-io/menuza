import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useMemo, useState } from 'react'
import { useFetcher, useFormAction } from 'react-router'
import { type PendingMenuScheduleSummary } from '#app/utils/menu/menu-schedules.server.ts'

export interface MenuScheduleCardProps {
	menuId: string
	pendingSchedule: PendingMenuScheduleSummary | null
	otherMenus: Array<{ id: string; name: string }>
	timezone?: string
	actionUrl?: string
	className?: string
}

interface ScheduleActionResponse {
	ok?: boolean
	error?: string
	cancelled?: boolean
	schedule?: PendingMenuScheduleSummary
}

function formatDateTimeInTimezone(isoString: string, timezone: string): string {
	const date = new Date(isoString)
	if (Number.isNaN(date.getTime())) return isoString
	try {
		return new Intl.DateTimeFormat(undefined, {
			timeZone: timezone,
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(date)
	} catch {
		return date.toLocaleString()
	}
}

function getDateInputPartsInTimezone(
	date: Date,
	timezone: string,
): { date: string; time: string } {
	try {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		})
		const parts: Record<string, string> = {}
		for (const part of formatter.formatToParts(date)) {
			parts[part.type] = part.value
		}
		const hour = parts.hour === '24' ? '00' : (parts.hour ?? '12')
		return {
			date: `${parts.year}-${parts.month}-${parts.day}`,
			time: `${hour}:${parts.minute ?? '00'}`,
		}
	} catch {
		return {
			date: date.toISOString().slice(0, 10),
			time: '12:00',
		}
	}
}

export function MenuScheduleCard({
	menuId,
	pendingSchedule,
	otherMenus,
	timezone = 'America/New_York',
	actionUrl,
	className,
}: MenuScheduleCardProps) {
	const { _ } = useLingui()
	const defaultAction = useFormAction('.')
	const targetAction = actionUrl ?? defaultAction
	const scheduleFetcher = useFetcher<ScheduleActionResponse>()
	const cancelFetcher = useFetcher<ScheduleActionResponse>()

	const initialParts = useMemo(() => {
		const base = pendingSchedule
			? new Date(pendingSchedule.goLiveAt)
			: new Date(Date.now() + 60 * 60_000)
		return getDateInputPartsInTimezone(base, timezone)
	}, [pendingSchedule, timezone])

	const [goLiveDate, setGoLiveDate] = useState(initialParts.date)
	const [goLiveTime, setGoLiveTime] = useState(initialParts.time)
	const [takeOffMenuId, setTakeOffMenuId] = useState<string>(
		pendingSchedule?.takeOffMenuId ?? '',
	)

	const isSubmitting = scheduleFetcher.state !== 'idle'
	const isCancelling = cancelFetcher.state !== 'idle'
	const errorCode =
		scheduleFetcher.data?.ok === false ? scheduleFetcher.data.error : null

	const formattedGoLiveAt = pendingSchedule
		? formatDateTimeInTimezone(pendingSchedule.goLiveAt, timezone)
		: null

	const takeOffMenuName = useMemo(() => {
		if (!pendingSchedule?.takeOffMenuId) return null
		return (
			otherMenus.find((m) => m.id === pendingSchedule.takeOffMenuId)?.name ??
			null
		)
	}, [otherMenus, pendingSchedule])

	const errorMessage = useMemo(() => {
		switch (errorCode) {
			case 'schedule_in_past':
				return _(t`Scheduled time must be in the future.`)
			case 'schedule_too_far':
				return _(t`Scheduled time cannot be more than 90 days ahead.`)
			case 'same_menu':
				return _(t`Choose a different menu to take offline.`)
			case 'take_off_menu_not_found':
				return _(t`The menu selected to take offline could not be found.`)
			case 'invalid_schedule_time':
				return _(t`Enter a valid date and time.`)
			default:
				return null
		}
	}, [_, errorCode])

	return (
		<Frame className={className ?? 'w-full'}>
			<FrameHeader>
				<FrameTitle className="text-base">
					<Trans>Scheduled Changeover</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						Schedule this menu&apos;s latest version to go live automatically (
						{timezone}).
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="space-y-4">
				{pendingSchedule ? (
					<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
						<div className="space-y-1">
							<div className="flex items-center gap-2 text-sm font-medium">
								<Icon name="clock" className="text-muted-foreground size-4" />
								<span>
									<Trans>Goes live {formattedGoLiveAt}</Trans>
								</span>
							</div>
							{takeOffMenuName ? (
								<p className="text-muted-foreground text-xs">
									<Trans>Takes offline: {takeOffMenuName}</Trans>
								</p>
							) : null}
						</div>
						<cancelFetcher.Form method="post" action={targetAction}>
							<input type="hidden" name="intent" value="cancel-menu-schedule" />
							<input type="hidden" name="menuId" value={menuId} />
							<Button
								type="submit"
								variant="outline"
								size="sm"
								disabled={isCancelling}
							>
								<Trans>Cancel schedule</Trans>
							</Button>
						</cancelFetcher.Form>
					</div>
				) : null}

				<scheduleFetcher.Form
					method="post"
					action={targetAction}
					className="space-y-3"
				>
					<input type="hidden" name="intent" value="schedule-menu" />
					<input type="hidden" name="menuId" value={menuId} />
					<input type="hidden" name="takeOffMenuId" value={takeOffMenuId} />

					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor={`schedule-date-${menuId}`}>
								<Trans>Go-live date</Trans>
							</Label>
							<Input
								id={`schedule-date-${menuId}`}
								name="goLiveDate"
								type="date"
								value={goLiveDate}
								onChange={(e) => setGoLiveDate(e.target.value)}
								required
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`schedule-time-${menuId}`}>
								<Trans>Go-live time</Trans>
							</Label>
							<Input
								id={`schedule-time-${menuId}`}
								name="goLiveTime"
								type="time"
								value={goLiveTime}
								onChange={(e) => setGoLiveTime(e.target.value)}
								required
							/>
						</div>
					</div>

					{otherMenus.length > 0 ? (
						<div className="space-y-1.5">
							<Label htmlFor={`schedule-takeoff-${menuId}`}>
								<Trans>Also take another menu offline (optional)</Trans>
							</Label>
							<Select
								value={takeOffMenuId || '__none__'}
								onValueChange={(val) => {
									setTakeOffMenuId(val === '__none__' || !val ? '' : val)
								}}
							>
								<SelectTrigger
									id={`schedule-takeoff-${menuId}`}
									className="w-full"
								>
									<SelectValue>
										{takeOffMenuId
											? (otherMenus.find((m) => m.id === takeOffMenuId)?.name ??
												_(t`None`))
											: _(t`None`)}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__none__">
										<Trans>None</Trans>
									</SelectItem>
									{otherMenus.map((m) => (
										<SelectItem key={m.id} value={m.id}>
											{m.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : null}

					{errorMessage ? (
						<p className="text-destructive text-sm" role="alert">
							{errorMessage}
						</p>
					) : null}

					<Button type="submit" size="sm" disabled={isSubmitting}>
						{pendingSchedule ? (
							<Trans>Replace schedule</Trans>
						) : (
							<Trans>Schedule changeover</Trans>
						)}
					</Button>
				</scheduleFetcher.Form>
			</FramePanel>
		</Frame>
	)
}

export interface MenuScheduleBadgeProps {
	schedule: PendingMenuScheduleSummary
	timezone?: string
	actionUrl?: string
}

/**
 * Compact badge for `menus._index.tsx` showing a pending scheduled changeover
 * with an inline cancel action.
 */
export function MenuScheduleBadge({
	schedule,
	timezone = 'America/New_York',
	actionUrl,
}: MenuScheduleBadgeProps) {
	const { _ } = useLingui()
	const defaultAction = useFormAction('.')
	const targetAction = actionUrl ?? defaultAction
	const cancelFetcher = useFetcher<ScheduleActionResponse>()
	const isCancelling = cancelFetcher.state !== 'idle'
	const formatted = formatDateTimeInTimezone(schedule.goLiveAt, timezone)

	return (
		<div className="inline-flex items-center gap-1.5">
			<Badge variant="outline" className="gap-1 text-xs font-normal">
				<Icon name="clock" className="size-3" />
				<span>
					<Trans>Scheduled {formatted}</Trans>
				</span>
			</Badge>
			<cancelFetcher.Form method="post" action={targetAction}>
				<input type="hidden" name="intent" value="cancel-menu-schedule" />
				<input type="hidden" name="menuId" value={schedule.menuId} />
				<Button
					type="submit"
					variant="ghost"
					size="xs"
					disabled={isCancelling}
					aria-label={_(t`Cancel schedule`)}
				>
					<Icon name="x" className="size-3" />
				</Button>
			</cancelFetcher.Form>
		</div>
	)
}
