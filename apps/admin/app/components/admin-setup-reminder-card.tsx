import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { useFetcher } from 'react-router'
import {
	type SetupReminderAnswer,
	type SetupReminderHistoryRow,
} from '#app/utils/setup-reminder.ts'

function useDate() {
	const { i18n } = useLingui()
	return (iso: string) =>
		new Intl.DateTimeFormat(i18n.locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(iso))
}

function AnswerMessage({ answer }: { answer: SetupReminderAnswer }) {
	const date = useDate()
	switch (answer.status) {
		case 'sent': {
			const count = answer.recipients
			return (
				<p className="text-sm" data-testid="reminder-sent">
					<Trans>Reminder sent to {count} owner(s).</Trans>
				</p>
			)
		}
		case 'limit': {
			const next = date(answer.nextAt)
			return (
				<p className="text-sm" data-testid="reminder-limit">
					<Trans>
						A reminder was already sent today. The next one can go on {next}.
					</Trans>
				</p>
			)
		}
		case 'nobody_to_notify':
			return (
				<p className="text-sm font-medium" data-testid="reminder-nobody">
					<Trans>Nobody to notify</Trans>
				</p>
			)
		case 'excluded':
			return (
				<p className="text-sm" data-testid="reminder-excluded">
					{answer.reason === 'test' ? (
						<Trans>
							This is a test organization: it is never sent reminders.
						</Trans>
					) : answer.reason === 'cancelled' ? (
						<Trans>
							This account is cancelled: it is never sent reminders.
						</Trans>
					) : (
						<Trans>This organization is not active.</Trans>
					)}
				</p>
			)
		case 'checklist_off':
			return (
				<p className="text-sm">
					<Trans>The launch checklist is off for this organization.</Trans>
				</p>
			)
		case 'live':
			return (
				<p className="text-sm">
					<Trans>This organization is already live: nothing to remind.</Trans>
				</p>
			)
		case 'nothing_to_remind':
			return (
				<p className="text-sm">
					<Trans>There is no next step to remind about.</Trans>
				</p>
			)
		case 'failed':
			return (
				<p className="text-destructive text-sm">
					<Trans>The email could not be sent. Try again.</Trans>
				</p>
			)
		case 'unavailable':
			return (
				<p className="text-muted-foreground text-sm">
					<Trans>The App could not be reached. Try again in a moment.</Trans>
				</p>
			)
		case 'ok':
			return null
	}
}

/**
 * Admin's setup reminder on the organization page (#271): preview what the
 * owner would get, send it now (once a day per organization, audit logged) and
 * the history of every reminder sent. Words and counts only.
 */
export function AdminSetupReminderCard({
	organizationId,
	history,
}: {
	organizationId: string
	history: SetupReminderHistoryRow[]
}) {
	const { _ } = useLingui()
	const date = useDate()
	const fetcher = useFetcher<{ answer?: SetupReminderAnswer }>()
	const action = `/organizations/${organizationId}/setup-reminder`
	const busy = fetcher.state !== 'idle'
	const answer = fetcher.data?.answer ?? null
	const recipients = answer?.status === 'ok' ? answer.recipients : 0
	const stepLabel = (key: string) => STEP_LABELS[key] ?? key
	return (
		<Card data-testid="admin-setup-reminder-card">
			<CardHeader>
				<CardTitle>
					<Trans>Setup reminders</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-2">
					<fetcher.Form method="post" action={action}>
						<input type="hidden" name="intent" value="preview" />
						<Button type="submit" variant="outline" size="sm" disabled={busy}>
							<Trans>Preview reminder</Trans>
						</Button>
					</fetcher.Form>
					<span className="text-muted-foreground text-xs">
						<Trans>One manual reminder per day per organization.</Trans>
					</span>
				</div>

				{answer?.status === 'ok' ? (
					<div
						className="bg-muted/40 flex flex-col gap-2 rounded-md border p-3 text-sm"
						data-testid="reminder-preview"
						dir={answer.locale === 'ar' ? 'rtl' : 'ltr'}
					>
						<p className="font-medium">{answer.subject}</p>
						<p>{answer.heading}</p>
						<p className="text-muted-foreground">{answer.intro}</p>
						<p className="text-muted-foreground text-xs">{answer.progress}</p>
						<p className="text-xs">[{answer.actionLabel}]</p>
						<div className="flex flex-wrap items-center gap-2" dir="ltr">
							<fetcher.Form method="post" action={action}>
								<input type="hidden" name="intent" value="send" />
								<Button
									type="submit"
									size="sm"
									disabled={busy || answer.nextManualAt !== null}
								>
									<Trans>Send reminder now</Trans>
								</Button>
							</fetcher.Form>
							<span className="text-muted-foreground text-xs">
								<Trans>To {recipients} owner(s)</Trans>
							</span>
						</div>
					</div>
				) : answer ? (
					<AnswerMessage answer={answer} />
				) : null}

				<div>
					<h3 className="mb-1 text-sm font-medium">
						<Trans>History</Trans>
					</h3>
					{history.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No reminders sent yet.</Trans>
						</p>
					) : (
						<ul className="flex flex-col gap-1 text-sm">
							{history.map((row) => {
								const day = row.day ?? 0
								return (
									<li
										key={row.id}
										className="flex flex-wrap items-center justify-between gap-2"
										data-testid="reminder-history-row"
									>
										<span>
											{stepLabel(row.stepKey)}{' '}
											<span className="text-muted-foreground text-xs">
												({row.doneCount}/{row.totalCount})
											</span>
										</span>
										<span className="flex items-center gap-2">
											<Badge variant="outline">
												{row.kind === 'manual'
													? _(msg`Manual`)
													: _(msg`Day ${day}`)}
											</Badge>
											<span className="text-muted-foreground text-xs tabular-nums">
												{date(row.sentAt)}
											</span>
										</span>
									</li>
								)
							})}
						</ul>
					)}
				</div>
			</CardContent>
		</Card>
	)
}

const STEP_LABELS: Record<string, string> = {
	launch_location_details: 'Address, phone and opening hours',
	launch_menu: 'Menu',
	launch_branding: 'Logo and site theme',
	launch_payments: 'Payments or pay at pickup',
	launch_fulfillment: 'Pickup, delivery and prep time',
	launch_go_live: 'Site published and ordering on',
}
