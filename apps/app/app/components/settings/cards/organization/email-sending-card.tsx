import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import { toast } from 'sonner'
import {
	CopyValue,
	errorMessage,
	RecordStatus,
	type ActionResult,
} from '#app/components/website/domain/domain-ui.tsx'
import { type senderView } from '#app/utils/email-sender/sender.server.ts'

/**
 * Settings, Email sending (#103): who guest emails are from. The sender name
 * and reply-to are always available; a custom sending domain (SPF, DKIM and
 * return-path records, Pending, Verified or Failed, Re-check) sits behind
 * `messaging.custom_sender`.
 */

export type EmailSendingView = Awaited<ReturnType<typeof senderView>>

function useSenderFetcher() {
	return useFetcher<ActionResult>()
}

export function EmailSendingCard({
	organizationSlug,
	view,
}: {
	organizationSlug: string
	view: EmailSendingView
}) {
	const { _ } = useLingui()
	const organizationName = view.organizationName
	const sendingAddress = `${view.localPart}@${view.domain ?? ''}`
	const checkedAt = view.checkedAt
		? new Date(view.checkedAt).toLocaleString()
		: ''
	const action = `/${organizationSlug}/settings/email-sending`
	const name = useSenderFetcher()
	const replyTo = useSenderFetcher()
	const code = useSenderFetcher()
	const domain = useSenderFetcher()
	const [pending, setPending] = useState(view.pendingReplyTo)
	const post = (
		fetcher: ReturnType<typeof useFetcher<ActionResult>>,
		values: Record<string, string>,
		ok?: string,
	) => {
		void fetcher.submit(values, { method: 'POST', action })
		if (ok) toast.success(ok)
	}
	const err = (fetcher: ReturnType<typeof useFetcher<ActionResult>>) =>
		fetcher.data && !fetcher.data.ok ? (
			<p className="text-destructive text-sm">
				{errorMessage(fetcher.data.error, _)}
			</p>
		) : null

	const statusBadge =
		view.domainStatus === 'verified' ? (
			<Badge variant="success">{_(msg`Verified`)}</Badge>
		) : view.domainStatus === 'failed' ? (
			<Badge variant="destructive">{_(msg`Failed`)}</Badge>
		) : (
			<Badge variant="warning">{_(msg`Pending`)}</Badge>
		)

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Email sending</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Guest emails (broadcasts, automations, reservations, orders, hiring)
						show your sender name and send replies to your inbox.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<div className="space-y-2">
					<Label htmlFor="sender-name">
						<Trans>Sender name</Trans>
					</Label>
					<form
						className="flex flex-col gap-2 sm:flex-row"
						onSubmit={(event) => {
							event.preventDefault()
							const data = new FormData(event.currentTarget)
							post(name, {
								intent: 'save-sender-name',
								senderName: String(data.get('senderName') ?? ''),
							})
						}}
					>
						<Input
							id="sender-name"
							name="senderName"
							defaultValue={view.senderName ?? ''}
							placeholder={view.organizationName}
							maxLength={64}
							className="sm:max-w-xs"
						/>
						<Button type="submit" disabled={name.state !== 'idle'}>
							<Trans>Save</Trans>
						</Button>
					</form>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Up to 64 characters. Leave it empty to use {organizationName}.
						</Trans>
					</p>
					{name.data?.ok ? (
						<p className="text-success text-sm">
							<Trans>Saved</Trans>
						</p>
					) : null}
					{err(name)}
				</div>

				<div className="space-y-2">
					<Label htmlFor="reply-to">
						<Trans>Reply-to address</Trans>
					</Label>
					{view.replyTo && view.replyToVerified ? (
						<p className="flex flex-wrap items-center gap-2 text-sm">
							{view.replyTo}
							<Badge variant="success">
								<Icon name="check" />
								<Trans>Verified</Trans>
							</Badge>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => post(replyTo, { intent: 'clear-reply-to' })}
							>
								<Trans>Remove</Trans>
							</Button>
						</p>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>
								Not set. Replies go nowhere useful until you add one.
							</Trans>
						</p>
					)}
					<form
						className="flex flex-col gap-2 sm:flex-row"
						onSubmit={(event) => {
							event.preventDefault()
							const data = new FormData(event.currentTarget)
							const address = String(data.get('address') ?? '')
							setPending(address)
							post(replyTo, { intent: 'request-reply-to-code', address })
						}}
					>
						<Input
							id="reply-to"
							name="address"
							type="email"
							placeholder={_(msg`owner@yourdomain.com`)}
							className="sm:max-w-xs"
							required
						/>
						<Button
							type="submit"
							variant="outline"
							disabled={replyTo.state !== 'idle'}
						>
							{view.replyTo ? (
								<Trans>Change and verify</Trans>
							) : (
								<Trans>Send a code</Trans>
							)}
						</Button>
					</form>
					{err(replyTo)}
					{pending && (replyTo.data?.ok || view.pendingReplyTo) ? (
						<form
							className="flex flex-col gap-2 sm:flex-row"
							onSubmit={(event) => {
								event.preventDefault()
								const data = new FormData(event.currentTarget)
								post(code, {
									intent: 'verify-reply-to-code',
									code: String(data.get('code') ?? ''),
								})
							}}
						>
							<Input
								name="code"
								inputMode="numeric"
								autoComplete="one-time-code"
								placeholder={_(msg`6-digit code`)}
								aria-label={_(msg`Code sent to ${pending}`)}
								className="sm:max-w-40"
								required
							/>
							<Button type="submit" disabled={code.state !== 'idle'}>
								<Trans>Verify</Trans>
							</Button>
						</form>
					) : null}
					{err(code)}
					{code.data?.ok ? (
						<p className="text-success text-sm">
							<Trans>Reply-to verified</Trans>
						</p>
					) : null}
					<p className="text-muted-foreground text-xs">
						<Trans>
							We email a code to the address. It is used only after you enter
							it.
						</Trans>
					</p>
				</div>

				{view.customSenderEnabled ? (
					<div className="space-y-3 border-t pt-4">
						<div className="flex flex-wrap items-center gap-2">
							<p className="text-sm font-medium">
								<Trans>Your own sending domain</Trans>
							</p>
							{view.domain ? statusBadge : null}
						</div>
						<p className="text-muted-foreground text-sm">
							<Trans>
								Send from an address on your own domain, such as
								hello@yourdomain.com, so guests see it and it passes email
								checks. Until it is verified, emails keep going out from our
								address with your name and reply-to.
							</Trans>
						</p>

						{!view.domain ? (
							<form
								className="grid gap-2 sm:grid-cols-[1fr_auto_auto]"
								onSubmit={(event) => {
									event.preventDefault()
									const data = new FormData(event.currentTarget)
									post(domain, {
										intent: 'start-sender-domain',
										domain: String(data.get('domain') ?? ''),
										localPart: String(data.get('localPart') ?? ''),
									})
								}}
							>
								<Input
									name="domain"
									placeholder="yourdomain.com"
									aria-label={_(msg`Sending domain`)}
									required
								/>
								<div className="flex items-center gap-1">
									<Input
										name="localPart"
										defaultValue="hello"
										aria-label={_(msg`Address before the @`)}
										className="w-28"
									/>
									<span className="text-muted-foreground text-sm">@</span>
								</div>
								<Button type="submit" disabled={domain.state !== 'idle'}>
									<Trans>Add domain</Trans>
								</Button>
							</form>
						) : (
							<>
								<p className="text-sm">
									<Trans>
										Guests will see mail from {sendingAddress} once verified.
									</Trans>
								</p>
								{view.domainStatus === 'failed' ? (
									<Alert variant="destructive">
										<Icon name="alert-triangle" />
										<AlertTitle>
											<Trans>We could not verify the records</Trans>
										</AlertTitle>
										<AlertDescription>
											<Trans>
												Emails go out from our address until they are fixed.
												Check the records below and re-check.
											</Trans>
										</AlertDescription>
									</Alert>
								) : null}
								{view.managedDns ? (
									<p className="text-muted-foreground text-sm">
										<Trans>
											Menuza manages this domain's DNS, so the records were
											added for you.
										</Trans>
									</p>
								) : null}
								<div className="overflow-x-auto rounded-lg border">
									<table className="w-full text-sm">
										<thead className="bg-muted text-muted-foreground text-xs">
											<tr>
												<th className="px-3 py-2 text-start font-medium">
													<Trans>Record</Trans>
												</th>
												<th className="px-3 py-2 text-start font-medium">
													<Trans>Name</Trans>
												</th>
												<th className="px-3 py-2 text-start font-medium">
													<Trans>Value</Trans>
												</th>
												<th className="px-3 py-2 text-start font-medium">
													<Trans>Status</Trans>
												</th>
											</tr>
										</thead>
										<tbody>
											{view.records.map((record) => (
												<tr
													key={`${record.purpose}-${record.name}`}
													className="border-t align-top"
												>
													<td className="px-3 py-2 text-xs">
														{record.purpose === 'spf'
															? 'SPF'
															: record.purpose === 'dkim'
																? 'DKIM'
																: record.purpose === 'return_path'
																	? _(msg`Return path`)
																	: 'DMARC'}{' '}
														<span className="font-mono">{record.type}</span>
														{!record.required ? (
															<span className="text-muted-foreground block">
																<Trans>recommended</Trans>
															</span>
														) : null}
													</td>
													<td className="px-3 py-2">
														<CopyValue value={record.name} />
													</td>
													<td className="px-3 py-2">
														<CopyValue value={record.value} />
													</td>
													<td className="px-3 py-2">
														<RecordStatus
															check={
																record.found === undefined
																	? 'unknown'
																	: record.found
																		? 'found'
																		: 'missing'
															}
														/>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={domain.state !== 'idle'}
										onClick={() =>
											post(domain, { intent: 'check-sender-domain' })
										}
									>
										<Icon name="refresh-cw" className="me-1.5 size-3.5" />
										<Trans>Re-check</Trans>
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={domain.state !== 'idle'}
										onClick={() =>
											post(domain, { intent: 'remove-sender-domain' })
										}
									>
										<Trans>Remove domain</Trans>
									</Button>
								</div>
								{view.checkedAt ? (
									<p className="text-muted-foreground text-xs">
										<Trans>Last checked {checkedAt}</Trans>
									</p>
								) : null}
							</>
						)}
						{err(domain)}
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}
