import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { type MyWeek } from '#app/utils/my-schedule/my-schedule-api.ts'
import {
	formatDay,
	formatPaid,
	formatRange,
	formatSpan,
} from '#app/utils/my-schedule/my-schedule-format.ts'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'

/**
 * This week for the person (#514): hours worked so far and hours scheduled, the
 * next shift and, only when the organization turned it on, an estimate of pay
 * for the pay period, always labelled as an estimate before tax. It is the
 * person's own data on their own page; nothing here is about anyone else.
 * Shared with the Station "My week" view.
 */
export function WeekView({
	week,
	locale,
	showNext = true,
}: {
	week: MyWeek | null
	locale: string
	/** My schedule shows the next shift in its heading already. */
	showNext?: boolean
}) {
	const { _ } = useLingui()
	if (!week) return null
	const worked = formatPaid(week.workedMinutes, locale)
	const scheduled = formatPaid(week.scheduledMinutes, locale)
	const range = formatSpan(week.weekStart, week.weekEnd, locale)
	const next = week.nextShift
	const pay = week.pay
	return (
		<section
			className="flex flex-col gap-2"
			aria-label={_(t`This week`)}
			data-testid="my-week"
		>
			<h2 className="text-base font-semibold">
				<Trans>This week</Trans>{' '}
				<span className="text-muted-foreground text-sm font-normal">
					<bdi>{range}</bdi>
				</span>
			</h2>
			<ItemGroup className="gap-2">
				<Item variant="outline">
					<Icon name="clock" className="size-5 shrink-0" />
					<ItemContent>
						<ItemTitle>
							<Trans>
								Worked so far <bdi>{worked}</bdi>
							</Trans>
						</ItemTitle>
						<ItemDescription>
							<Trans>
								Scheduled this week <bdi>{scheduled}</bdi>
							</Trans>
						</ItemDescription>
					</ItemContent>
				</Item>
				{showNext ? (
				<Item variant="outline">
					<Icon name="calendar" className="size-5 shrink-0" />
					<ItemContent>
						<ItemTitle>
							<Trans>Next shift</Trans>
						</ItemTitle>
						<ItemDescription>
							{next ? (
								<>
									{formatDay(next.localDate, locale)},{' '}
									<bdi dir="ltr">
										{formatRange(
											next.startsAt,
											next.endsAt,
											next.timeZone,
											locale,
										)}
									</bdi>
								</>
							) : (
								<Trans>No upcoming shifts are published.</Trans>
							)}
						</ItemDescription>
					</ItemContent>
				</Item>
				) : null}
				{pay ? <PayEstimate pay={pay} locale={locale} /> : null}
			</ItemGroup>
		</section>
	)
}

function PayEstimate({
	pay,
	locale,
}: {
	pay: NonNullable<MyWeek['pay']>
	locale: string
}) {
	const period = formatSpan(pay.periodStart, pay.periodEnd, locale)
	const amount =
		pay.estimateMinor !== null && pay.currency
			? formatMoneyMinor(pay.estimateMinor, pay.currency, locale)
			: null
	const overtime = formatPaid(pay.overtimeMinutes, locale)
	return (
		<Item variant="outline" data-testid="my-pay-estimate">
			<Icon name="wallet" className="size-5 shrink-0" />
			<ItemContent>
				<ItemTitle>
					{amount ? (
						<bdi dir="ltr">{amount}</bdi>
					) : (
						<Trans>No estimate yet</Trans>
					)}
				</ItemTitle>
				<ItemDescription>
					<Trans>Estimate before tax</Trans>
					{' · '}
					<bdi>{period}</bdi>
					{pay.overtimeMinutes > 0 ? (
						<>
							{' · '}
							<Trans>
								Overtime <bdi>{overtime}</bdi>
							</Trans>
						</>
					) : null}
				</ItemDescription>
			</ItemContent>
		</Item>
	)
}
