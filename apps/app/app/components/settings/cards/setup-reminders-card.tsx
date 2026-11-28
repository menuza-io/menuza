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

/**
 * Settings, Notifications: "Setup reminders" (#271). Owners get up to three
 * short emails about the next unfinished launch step while the restaurant is
 * not live yet. This switch is the same as the link in each email.
 */
export function SetupRemindersCard({ on }: { on: boolean }) {
	const { t } = useLingui()
	const fetcher = useFetcher<{ ok: boolean }>()
	const submitted = fetcher.formData?.get('enabled')
	const checked =
		submitted === null || submitted === undefined ? on : submitted === 'true'
	return (
		<Card data-testid="setup-reminders-card">
			<CardHeader>
				<CardTitle>
					<Trans>Setup reminders</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Until your restaurant is live, we email the owner about the next
						unfinished step 1, 3 and 7 days after you last made progress, then
						stop.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<label className="flex items-center justify-between gap-3 text-sm">
					<span>
						<Trans>Email me setup reminders</Trans>
					</span>
					<Switch
						checked={checked}
						onCheckedChange={(next) =>
							void fetcher.submit(
								{ intent: 'setup-reminders', enabled: String(next) },
								{ method: 'post' },
							)
						}
						aria-label={t`Email me setup reminders`}
						data-testid="setup-reminders-switch"
					/>
				</label>
			</CardContent>
		</Card>
	)
}
