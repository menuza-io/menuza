import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FrameTitle,
} from '@repo/ui/frame'
import { useState } from 'react'
import { toast } from 'sonner'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { revokeLink } from '#app/utils/staffing/schedule-api.ts'
import { describeScheduleError } from '#app/utils/staffing/schedule-errors.ts'
import { linkStatusSchema } from '#app/utils/staffing/schedule-types.ts'

/**
 * The person's read-only "my schedule" link, as a manager sees it: whether one is
 * live, when it was last opened and when it lapses, and a way to turn it off.
 * The link itself is never shown here; it only exists inside the email sent to
 * the person, and the next schedule email makes a fresh one after it is turned
 * off. Hidden entirely while scheduling is off or the member cannot read the
 * schedule.
 */
export function ScheduleLinkSection({
	staffId,
	terminated,
}: {
	staffId: string
	terminated: boolean
}) {
	const { _, i18n } = useLingui()
	const { client, ready, can } = useStaffClient('schedule')
	const canRead = ready && can(P.READ_SCHEDULE)
	const canWrite = can(P.UPDATE_SCHEDULE) && !terminated
	const query = useStaffQuery(
		client,
		canRead ? `/links/${encodeURIComponent(staffId)}` : null,
		linkStatusSchema,
	)
	const action = useStaffAction(describeScheduleError)
	const [confirming, setConfirming] = useState(false)
	if (!canRead || (query.error && !query.data)) return null
	const status = query.data
	if (!status) return null

	const date = (ms: number) =>
		new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(ms)
	const expires = status.expiresAt ? date(status.expiresAt) : ''
	const lastOpened = status.lastUsedAt ? date(status.lastUsedAt) : ''

	async function turnOff() {
		const result = await action.run(() => revokeLink(client, staffId))
		if (!result.ok) return
		setConfirming(false)
		toast.success(_(t`The link was turned off.`))
		query.reload()
	}

	return (
		<Frame className="w-full" aria-labelledby="schedule-link-heading">
			<FrameHeader>
				<FrameTitle id="schedule-link-heading">
					<Trans>My schedule link</Trans>
				</FrameTitle>
				<FrameDescription>
					{status.active && status.expiresAt ? (
						<>
							<Trans>
								They see their own published shifts and time cards from the link
								in their schedule emails. It works until {expires}, and longer
								with each new email.
							</Trans>{' '}
							{status.lastUsedAt ? (
								<Trans>Last opened {lastOpened}.</Trans>
							) : (
								<Trans>Not opened yet.</Trans>
							)}
						</>
					) : (
						<Trans>
							No link is active. They get one in the next schedule email, as
							long as they have an email address.
						</Trans>
					)}
				</FrameDescription>
				{status.active && canWrite ? (
					<FrameAction>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirming(true)}
						>
							<Trans>Turn off the link</Trans>
						</Button>
					</FrameAction>
				) : null}
			</FrameHeader>
			<AlertDialog
				open={confirming}
				onOpenChange={(open) => {
					if (!open && !action.pending) {
						setConfirming(false)
						action.reset()
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Turn off this link?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								The link in their earlier emails stops working right away. They
								get a new one in the next schedule email.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					{action.error ? (
						<Alert variant="destructive">
							<AlertDescription>{action.error}</AlertDescription>
						</Alert>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={action.pending}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant="destructive"
							disabled={action.pending}
							onClick={() => void turnOff()}
						>
							{action.pending ? (
								<Trans>Turning off…</Trans>
							) : (
								<Trans>Turn off</Trans>
							)}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Frame>
	)
}
