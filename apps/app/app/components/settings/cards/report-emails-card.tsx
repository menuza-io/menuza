import { Trans, useLingui } from '@lingui/react/macro'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Switch } from '@repo/ui/switch'
import { useFetcher } from 'react-router'

export type ReportEmailRow = {
	scheduleId: string
	title: string | null
	builtIn: string | null
	cadence: string
	subscribed: boolean
}

/**
 * Settings, Notifications: "Report emails" (#121, #221). Lists the scheduled
 * reports that email this member, each with an Unsubscribe switch, and the
 * monthly results email (owners and admins) with its own switch. The same
 * switches are the one-click link in each email.
 */
export function ReportEmailsCard({
	orgSlug,
	schedules,
	monthly,
}: {
	orgSlug: string
	schedules: ReportEmailRow[]
	/** Null when this member does not receive the monthly results email. */
	monthly: { on: boolean } | null
}) {
	const { t } = useLingui()
	const fetcher = useFetcher<{ ok: boolean }>()
	const action = `/${orgSlug}/reports/email-preferences`
	const send = (body: Record<string, unknown>) =>
		void fetcher.submit(body as never, {
			method: 'post',
			encType: 'application/json',
			action,
		})
	const cadence = (value: string) =>
		value === 'daily' ? t`daily` : value === 'weekly' ? t`weekly` : t`monthly`
	return (
		<Card data-testid="report-emails-card">
			<CardHeader>
				<CardTitle>
					<Trans>Report emails</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Scheduled reports and the monthly results that are emailed to you.
						Every email also has a one-click unsubscribe link.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{monthly ? (
					<label className="flex items-center justify-between gap-3 text-sm">
						<span>
							<Trans>Monthly results (on the 2nd of each month)</Trans>
						</span>
						<Switch
							checked={monthly.on}
							onCheckedChange={(next) =>
								send({ intent: 'monthly', subscribed: next })
							}
							aria-label={t`Monthly results email`}
							data-testid="report-email-monthly"
						/>
					</label>
				) : null}
				{schedules.map((row) => (
					<label
						key={row.scheduleId}
						className="flex items-center justify-between gap-3 text-sm"
					>
						<span>
							{row.builtIn ? t`Daily summary` : (row.title ?? t`Report`)}{' '}
							<span className="text-muted-foreground">
								({cadence(row.cadence)})
							</span>
						</span>
						<Switch
							checked={row.subscribed}
							onCheckedChange={(next) =>
								send({
									intent: 'schedule',
									scheduleId: row.scheduleId,
									subscribed: next,
								})
							}
							aria-label={t`Receive this report by email`}
							data-testid={`report-email-${row.scheduleId}`}
						/>
					</label>
				))}
			</CardContent>
		</Card>
	)
}
