import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	SUPPORT_MESSAGE_MAX,
	SUPPORT_SCREENSHOT_MAX_BYTES,
	SUPPORT_SCREENSHOT_TYPES,
	sanitizeSupportPath,
	type SupportRequestKind,
} from '@repo/common/support-requests'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import { Link, useFetcher, useLocation, useRouteLoaderData } from 'react-router'
import { toast } from 'sonner'
import { type loader as rootLoader } from '#app/root.tsx'
import { type OpenHelpOptions } from './help-context.tsx'

type SupportResponse = { status: string; error?: string }

/**
 * The Contact support and Report a problem form (#233). It says what will be
 * attached before anything is sent: the restaurant, the place, the page, the
 * app version and the error reference. Never a guest's details.
 */
export function HelpDialog({
	options,
	onClose,
}: {
	options: OpenHelpOptions
	onClose: () => void
}) {
	const { _ } = useLingui()
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	const location = useLocation()
	const fetcher = useFetcher<SupportResponse>()
	const [kind, setKind] = useState<SupportRequestKind>('support')
	const [fileError, setFileError] = useState<string | null>(null)

	const organization = rootData?.userOrganizations?.currentOrganization
	const orgSlug = organization?.organization.slug
	// The location the person has selected in the App; checked again on the server.
	const locationId = rootData?.selectedLocationId ?? undefined
	const path = sanitizeSupportPath(location.pathname)
	const errorId = options.errorId ?? null
	const open = true

	useEffect(() => {
		setKind(options.kind ?? 'support')
		setFileError(null)
	}, [options])

	// Sent: thank them and close.
	useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data?.status === 'ok') {
			toast.success(_(msg`Sent to Menuza support`), {
				description: _(msg`We will reply under Support and by email.`),
			})
			onClose()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetcher.state, fetcher.data])

	const sending = fetcher.state !== 'idle'
	const failed = fetcher.data?.status === 'error' ? fetcher.data.error : null

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="sm:max-w-[520px]">
				<DialogHeader>
					<DialogTitle>
						{kind === 'problem' ? (
							<Trans>Report a problem</Trans>
						) : (
							<Trans>Contact support</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Tell us what you need. We already have the page you are on, so you
							do not have to explain where you were.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{!orgSlug ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Choose a restaurant first, then contact support.</Trans>
					</p>
				) : (
					<fetcher.Form
						method="post"
						action="/resources/support"
						encType="multipart/form-data"
						className="space-y-4"
					>
						<input type="hidden" name="organizationSlug" value={orgSlug} />
						<input type="hidden" name="path" value={path} />
						{errorId ? (
							<input type="hidden" name="errorId" value={errorId} />
						) : null}
						{locationId ? (
							<input type="hidden" name="locationId" value={locationId} />
						) : null}
						<input type="hidden" name="kind" value={kind} />

						<div
							className="flex gap-2"
							role="group"
							aria-label={_(msg`What is this about`)}
						>
							<Button
								type="button"
								size="sm"
								variant={kind === 'support' ? 'default' : 'outline'}
								aria-pressed={kind === 'support'}
								onClick={() => setKind('support')}
							>
								<Trans>I have a question</Trans>
							</Button>
							<Button
								type="button"
								size="sm"
								variant={kind === 'problem' ? 'default' : 'outline'}
								aria-pressed={kind === 'problem'}
								onClick={() => setKind('problem')}
							>
								<Trans>Something is broken</Trans>
							</Button>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="support-subject">
								<Trans>Subject (optional)</Trans>
							</Label>
							<Input id="support-subject" name="subject" maxLength={120} />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="support-message">
								{kind === 'problem' ? (
									<Trans>What happened, and what did you expect?</Trans>
								) : (
									<Trans>How can we help?</Trans>
								)}
							</Label>
							<Textarea
								id="support-message"
								name="message"
								required
								maxLength={SUPPORT_MESSAGE_MAX}
								className="min-h-[120px]"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="support-screenshot">
								<Trans>Screenshot (optional)</Trans>
							</Label>
							<Input
								id="support-screenshot"
								name="screenshot"
								type="file"
								accept={SUPPORT_SCREENSHOT_TYPES.join(',')}
								onChange={(event) => {
									const file = event.currentTarget.files?.[0]
									if (file && file.size > SUPPORT_SCREENSHOT_MAX_BYTES) {
										setFileError(
											_(msg`The screenshot must be 4 MB or smaller.`),
										)
										event.currentTarget.value = ''
									} else {
										setFileError(null)
									}
								}}
							/>
							{fileError ? (
								<p className="text-destructive text-sm" role="alert">
									{fileError}
								</p>
							) : null}
						</div>

						<div className="bg-muted text-muted-foreground rounded-md p-3 text-xs">
							<p className="text-foreground mb-1 font-medium">
								<Trans>We will send with your message</Trans>
							</p>
							<ul className="list-disc ps-4">
								<li>
									<Trans>
										Your restaurant and the place you were working in
									</Trans>
								</li>
								<li>
									<Trans>The page you are on: {path}</Trans>
								</li>
								<li>
									<Trans>The app version</Trans>
								</li>
								{errorId ? (
									<li>
										<Trans>The error reference: {errorId}</Trans>
									</li>
								) : null}
							</ul>
							<p className="mt-1">
								<Trans>
									We never attach a guest's name, phone, email or order.
								</Trans>
							</p>
						</div>

						{failed ? (
							<p className="text-destructive text-sm" role="alert">
								{failed === 'screenshot_too_large' ||
								failed === 'invalid_screenshot' ? (
									<Trans>
										The screenshot could not be used. Use a PNG, JPEG or WebP of
										4 MB or less.
									</Trans>
								) : (
									<Trans>
										We could not send that. Check the message and try again.
									</Trans>
								)}
							</p>
						) : null}

						<div className="flex items-center justify-between gap-3">
							<Link
								to={`/${orgSlug}/support`}
								onClick={onClose}
								className="text-muted-foreground text-sm underline"
							>
								<Trans>My support requests</Trans>
							</Link>
							<div className="flex gap-2">
								<Button type="button" variant="ghost" onClick={onClose}>
									<Trans>Cancel</Trans>
								</Button>
								<Button type="submit" disabled={sending || Boolean(fileError)}>
									<Trans>Send</Trans>
								</Button>
							</div>
						</div>
					</fetcher.Form>
				)}
			</DialogContent>
		</Dialog>
	)
}
