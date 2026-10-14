import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	computeTimecard,
	computeWeek,
	laborPolicyToRules,
	type LaborPolicyFields,
	type TimeEntryInput,
	weekStartFor,
} from '@repo/staffing'
import { Badge } from '@repo/ui/badge'
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Progress } from '@repo/ui/progress'
import { Separator } from '@repo/ui/separator'
import { type CSSProperties, useMemo } from 'react'

const TIME_ZONE = 'UTC'
/** A Friday: four earlier shifts that week make overtime visible when it is on. */
const EXAMPLE_DATE = '2026-10-16'
const SCOPE = 'example'

function at(day: number, hour: number, minute: number) {
	return Date.UTC(2026, 9, day, hour, minute)
}

const EARLIER_SHIFTS: TimeEntryInput[] = [12, 13, 14, 15].map((day) => ({
	id: `earlier-${day}`,
	scopeId: SCOPE,
	clockInAt: at(day, 9, 0),
	clockOutAt: at(day, 17, 30),
}))

const EXAMPLE_SHIFT: TimeEntryInput = {
	id: 'example',
	scopeId: SCOPE,
	clockInAt: at(16, 9, 2),
	clockOutAt: at(16, 17, 41),
}

function useDuration() {
	const { _ } = useLingui()
	return (minutes: number) => {
		const hours = Math.floor(minutes / 60)
		const rest = minutes % 60
		if (hours === 0) return _(t`${rest}m`)
		if (rest === 0) return _(t`${hours}h`)
		return _(t`${hours}h ${rest}m`)
	}
}

/**
 * A worked example beside the rules: one typical shift run through the same
 * time math the timesheets use, so what it shows is what the rules will do. It
 * is an illustration with made-up punches, never anyone's real time card.
 */
export function LaborExample({ policy }: { policy: LaborPolicyFields }) {
	const { _, i18n } = useLingui()
	const duration = useDuration()
	const result = useMemo(() => {
		const rules = laborPolicyToRules(policy)
		const ctx = { timeZone: TIME_ZONE }
		const card = computeTimecard(EXAMPLE_SHIFT, rules, ctx)
		const week = computeWeek([...EARLIER_SHIFTS, EXAMPLE_SHIFT], rules, {
			...ctx,
			weekStartDate: weekStartFor(EXAMPLE_DATE, rules.weekStartsOn),
		})
		return { rules, card, week }
	}, [policy])

	const { rules, card, week } = result
	const clock = new Intl.DateTimeFormat(i18n.locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: TIME_ZONE,
	})
	const autoBreak = rules.autoBreakDeduction
	const elapsed = Math.max(card.elapsedMinutes, 1)
	// The deducted break sits at the end of the stretch that earned it.
	const breakStart = autoBreak
		? Math.max(autoBreak.afterMinutes - card.unpaidBreakMinutes, 0)
		: 0
	const weeklyLimit = rules.weeklyOvertime?.thresholdMinutes ?? null
	const longShift = card.issues.includes('long_shift')
	const weekText = duration(week.total)
	const limitText = weeklyLimit === null ? '' : duration(weeklyLimit)
	const overtimeText = duration(week.overtime)
	const remainingText =
		weeklyLimit === null ? '' : duration(Math.max(weeklyLimit - week.total, 0))

	return (
		<aside aria-label={_(t`Example shift`)}>
			<Card>
				<CardHeader>
					<CardTitle as="h2">
						<Trans>Example shift</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>A typical day shift.</Trans>
					</CardDescription>
					<CardAction>
						<Badge variant="outline">
							<Trans>Updates as you edit</Trans>
						</Badge>
					</CardAction>
				</CardHeader>
				<CardContent className="flex flex-col gap-5">
					<div className="flex flex-col gap-1.5">
						<div
							className="bg-muted relative h-8 overflow-hidden rounded-lg"
							role="img"
							aria-label={_(
								t`The shift as a bar, with any deducted break marked`,
							)}
						>
							<div className="bg-primary/70 absolute inset-0" />
							{card.unpaidBreakMinutes > 0 ? (
								<div
									className="bg-background/85 absolute inset-y-0 start-(--break-start) w-(--break-size)"
									style={
										{
											'--break-start': `${(breakStart / elapsed) * 100}%`,
											'--break-size': `${(card.unpaidBreakMinutes / elapsed) * 100}%`,
										} as CSSProperties
									}
								/>
							) : null}
						</div>
						<div className="text-muted-foreground flex justify-between text-xs tabular-nums">
							<span>{clock.format(card.clockInAt)}</span>
							<span>
								{card.clockOutAt ? clock.format(card.clockOutAt) : ''}
							</span>
						</div>
					</div>

					<Separator variant="dashed" />

					<dl className="flex flex-col gap-3 text-sm">
						<div className="flex justify-between gap-3">
							<dt className="text-muted-foreground">
								<Trans>Clocked in to out</Trans>
							</dt>
							<dd className="tabular-nums">{duration(card.elapsedMinutes)}</dd>
						</div>
						<div className="flex justify-between gap-3">
							<dt className="text-muted-foreground">
								{autoBreak ? (
									<Trans>Unpaid break taken off</Trans>
								) : (
									<Trans>Unpaid break</Trans>
								)}
							</dt>
							<dd className="tabular-nums">
								{card.unpaidBreakMinutes > 0
									? `− ${duration(card.unpaidBreakMinutes)}`
									: _(t`None`)}
							</dd>
						</div>
					</dl>
					{card.unpaidBreakMinutes === 0 && !autoBreak ? (
						<p className="text-muted-foreground text-xs text-pretty">
							<Trans>
								Nobody recorded a break and automatic deduction is off, so
								nothing is taken off.
							</Trans>
						</p>
					) : null}

					<Separator variant="dashed" />

					<dl className="text-base font-medium">
						<div className="flex justify-between gap-3">
							<dt>
								<Trans>Paid hours</Trans>
							</dt>
							<dd className="tabular-nums">{duration(card.workedMinutes)}</dd>
						</div>
					</dl>
					{longShift ? (
						<p className="text-xs text-pretty">
							<Trans>This shift would be flagged for review as too long.</Trans>
						</p>
					) : null}

					<Separator variant="dashed" />

					<div className="flex flex-col gap-3 text-sm">
						{weeklyLimit !== null ? (
							<>
								<div className="flex justify-between gap-3">
									<span className="text-muted-foreground">
										<Trans>That week so far</Trans>
									</span>
									<span className="tabular-nums">
										{_(t`${weekText} of ${limitText}`)}
									</span>
								</div>
								<Progress
									value={Math.min((week.total / weeklyLimit) * 100, 100)}
									aria-label={_(
										t`Hours worked that week against the overtime limit`,
									)}
								/>
								<p className="text-muted-foreground text-xs text-pretty">
									{week.overtime > 0
										? _(
												t`${overtimeText} of this week is paid at the overtime rate.`,
											)
										: _(t`${remainingText} until overtime starts.`)}
								</p>
							</>
						) : (
							<p className="text-muted-foreground text-xs text-pretty">
								<Trans>
									Overtime is off. Turn it on to see how a week adds up.
								</Trans>
							</p>
						)}
					</div>

					<Separator variant="dashed" />

					<p className="text-muted-foreground text-xs text-pretty">
						<Trans>
							An illustration with made-up punches. Real figures come from each
							time card and are estimates, not payroll.
						</Trans>
					</p>
				</CardContent>
			</Card>
		</aside>
	)
}
