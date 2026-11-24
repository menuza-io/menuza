import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { useState } from 'react'
import {
	type MyAnnouncement,
	type MyScheduleApi,
} from '#app/utils/my-schedule/my-schedule-api.ts'
import { describeMyScheduleError } from '#app/utils/my-schedule/my-schedule-messages.ts'

/**
 * Announcements from the manager (#486) that are still showing and meant for
 * this person. "Got it" records that they read it, and takes it off this list.
 * No replies. The words are plain text, never HTML.
 */
export function AnnouncementsView({
	api,
	announcements,
	locale,
	onChanged,
}: {
	api: MyScheduleApi
	announcements: readonly MyAnnouncement[]
	locale: string
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const unread = announcements.filter((item) => item.readAt === null)
	if (unread.length === 0) return null
	const shownUntil = (ms: number) =>
		new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ms)

	async function gotIt(id: string) {
		setBusy(id)
		setError(null)
		try {
			await api.readAnnouncement(id)
			onChanged()
		} catch (failure) {
			setError(describeMyScheduleError(failure, _))
		} finally {
			setBusy(null)
		}
	}

	return (
		<section
			className="flex flex-col gap-2"
			aria-label={_(t`Announcements`)}
			data-testid="my-announcements"
		>
			{unread.map((item) => {
				const until = shownUntil(item.expiresAt)
				return (
					<Alert key={item.id}>
						<AlertTitle className="wrap-anywhere">{item.title}</AlertTitle>
						<AlertDescription>
							<div className="flex flex-col gap-3">
								<p className="text-sm wrap-anywhere whitespace-pre-wrap">
									{item.body}
								</p>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="text-muted-foreground text-xs">
										<Trans>
											Shown until <bdi>{until}</bdi>
										</Trans>
									</span>
									<Button
										type="button"
										className="h-11 px-5"
										disabled={busy === item.id}
										onClick={() => void gotIt(item.id)}
									>
										<Trans>Got it</Trans>
									</Button>
								</div>
							</div>
						</AlertDescription>
					</Alert>
				)
			})}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
		</section>
	)
}
