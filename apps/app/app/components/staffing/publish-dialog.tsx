import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { useEffect, useState } from 'react'
import { type PublishResult } from '#app/utils/staffing/client.ts'

export function PublishDialog({
	open,
	onOpenChange,
	unpublishedCount,
	weekLabel,
	onPublish,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	unpublishedCount: number
	weekLabel: string
	onPublish: () => Promise<{ error: string } | { result: PublishResult }>
}) {
	const { _ } = useLingui()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [result, setResult] = useState<PublishResult | null>(null)

	useEffect(() => {
		if (open) {
			setError(null)
			setResult(null)
		}
	}, [open])

	const reasons: Record<
		PublishResult['notNotified'][number]['reason'],
		string
	> = {
		no_email: _(msg`No email on file`),
		email_disabled: _(msg`Schedule email is turned off`),
		send_failed: _(msg`Email could not be sent`),
		not_sent: _(msg`Not sent in time`),
	}
	const notified = result?.notified ?? 0

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{result ? (
							<Trans>Schedule published</Trans>
						) : (
							<Trans>Publish the week of {weekLabel}?</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{result ? (
							<Plural
								value={notified}
								one="# person was emailed their shifts."
								other="# people were emailed their shifts."
							/>
						) : (
							<>
								<Plural
									value={unpublishedCount}
									one="# change goes live."
									other="# changes go live."
								/>{' '}
								<Trans>
									Everyone whose shifts changed gets an email with only their
									own shifts.
								</Trans>
							</>
						)}
					</DialogDescription>
				</DialogHeader>
				{result && result.notNotified.length > 0 ? (
					<div className="space-y-2">
						<p className="text-sm font-medium">
							<Trans>Not notified. Tell them another way:</Trans>
						</p>
						<ul className="divide-border max-h-60 divide-y overflow-y-auto rounded-md border text-sm">
							{result.notNotified.map((person) => (
								<li
									key={person.staffId}
									className="flex justify-between gap-3 p-2"
								>
									<span>{person.name}</span>
									<span className="text-muted-foreground">
										{reasons[person.reason]}
									</span>
								</li>
							))}
						</ul>
					</div>
				) : null}
				{error ? (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{result ? <Trans>Done</Trans> : <Trans>Cancel</Trans>}
					</Button>
					{!result ? (
						<Button
							type="button"
							disabled={busy || unpublishedCount === 0}
							onClick={async () => {
								setBusy(true)
								const outcome = await onPublish()
								setBusy(false)
								if ('error' in outcome) setError(outcome.error)
								else setResult(outcome.result)
							}}
						>
							<Trans>Publish</Trans>
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
