import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { useState } from 'react'
import { type DomainOverview } from '#app/utils/domains/overview.server.ts'
import { errorMessage, useDomainFetcher } from './domain-ui.tsx'

/**
 * Email forwarding (#276): addresses on a domain Menuza manages that forward
 * to an inbox the restaurant already has. Forwarding only: no mailbox, no
 * sending, and Menuza never reads the messages.
 */

type ManagedView = DomainOverview['managed'][number]

const formatTime = (value: string) => new Date(value).toLocaleString()

function StatusBadge({ status }: { status: string }) {
	if (status === 'active')
		return (
			<Badge variant="success">
				<Trans>Active</Trans>
			</Badge>
		)
	if (status === 'failing')
		return (
			<Badge variant="destructive">
				<Trans>Failing</Trans>
			</Badge>
		)
	return (
		<Badge variant="warning">
			<Trans>Waiting for confirmation</Trans>
		</Badge>
	)
}

export function ForwardingPanel({
	domain,
	canUpdate,
}: {
	domain: ManagedView
	canUpdate: boolean
}) {
	const { _ } = useLingui()
	const adder = useDomainFetcher({ success: msg`Address added` })
	const remover = useDomainFetcher({ success: msg`Address removed` })
	const resend = useDomainFetcher({
		success: msg`Confirmation email sent again`,
	})
	const checker = useDomainFetcher({ success: msg`Checked` })
	const off = useDomainFetcher({ success: msg`Email forwarding turned off` })
	const [typed, setTyped] = useState('')
	const { forwarding } = domain
	const fqdn = domain.fqdn
	const needsWords = !forwarding.enabled && forwarding.existingMail.length > 0
	const mxRequired = adder.error === 'mx_confirmation_required' || needsWords

	return (
		<div className="space-y-3">
			<p className="text-sm font-medium">
				<Trans>Email forwarding</Trans>
			</p>

			{!forwarding.availability.available ? (
				<Alert>
					<Icon name="info" />
					<AlertTitle>
						<Trans>Not available for {fqdn} yet</Trans>
					</AlertTitle>
					<AlertDescription>
						{forwarding.availability.reason === 'nameservers_pending' ? (
							<Trans>
								Forwarding needs Menuza to run this domain's DNS, and the
								nameservers have not moved yet. It becomes available as soon as
								they do.
							</Trans>
						) : (
							<Trans>
								Forwarding needs Menuza to run this domain's DNS, which it does
								not today. Let Menuza manage the domain, or buy one here, to
								turn it on.
							</Trans>
						)}
					</AlertDescription>
				</Alert>
			) : (
				<>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Send mail for addresses like info@{fqdn} to your own inbox.
							Forwarding only: there is no mailbox and you cannot send from
							these addresses. We never store or read the messages.
						</Trans>
					</p>

					{mxRequired ? (
						<Alert variant="destructive">
							<Icon name="alert-triangle" />
							<AlertTitle>
								<Trans>This domain already receives email</Trans>
							</AlertTitle>
							<AlertDescription>
								<p>
									<Trans>
										Turning forwarding on replaces its mail provider, and its
										mailbox stops receiving mail. Type the domain to confirm.
									</Trans>
								</p>
								<ul className="font-mono text-xs">
									{forwarding.existingMail.map((mx) => (
										<li key={mx.id}>MX {mx.host}</li>
									))}
								</ul>
								<Input
									value={typed}
									onChange={(event) => setTyped(event.target.value)}
									placeholder={domain.fqdn}
									aria-label={_(msg`Type the domain to confirm`)}
								/>
							</AlertDescription>
						</Alert>
					) : null}

					{forwarding.forwards.length > 0 ? (
						<ul className="divide-y rounded-lg border">
							{forwarding.forwards.map((forward) => {
								const lastTime = forward.lastForwardedAt
									? formatTime(forward.lastForwardedAt)
									: ''
								return (
									<li
										key={forward.id}
										className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
									>
										<div className="min-w-0">
											<p className="font-medium break-all">
												{forward.localPart === '*'
													? _(msg`Anything else`)
													: forward.localPart}
												@{domain.fqdn} → {forward.destination}
											</p>
											<p className="text-muted-foreground text-xs">
												{forward.lastForwardedAt ? (
													<Trans>Last forwarded {lastTime}</Trans>
												) : forwarding.reportsActivity ? (
													<Trans>No mail forwarded yet</Trans>
												) : (
													<Trans>
														The mail service does not report when mail was last
														forwarded.
													</Trans>
												)}
											</p>
										</div>
										<div className="flex flex-wrap items-center gap-2">
											<StatusBadge status={forward.status} />
											{canUpdate && forward.status !== 'active' ? (
												<resend.Form method="POST">
													<input
														type="hidden"
														name="intent"
														value="resend-forward-confirmation"
													/>
													<input
														type="hidden"
														name="managedDomainId"
														value={domain.id}
													/>
													<input
														type="hidden"
														name="forwardId"
														value={forward.id}
													/>
													<Button
														type="submit"
														variant="outline"
														size="xs"
														disabled={resend.busy}
													>
														<Trans>Resend confirmation</Trans>
													</Button>
												</resend.Form>
											) : null}
											{canUpdate ? (
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={_(msg`Remove`)}
													disabled={remover.busy}
													onClick={() =>
														remover.submit({
															intent: 'remove-forward',
															managedDomainId: domain.id,
															forwardId: forward.id,
														})
													}
												>
													<Icon name="trash-2" className="size-3.5" />
												</Button>
											) : null}
										</div>
									</li>
								)
							})}
						</ul>
					) : null}

					{forwarding.forwards.some((f) => f.status !== 'active') ? (
						<p className="text-muted-foreground text-xs">
							<Trans>
								Each inbox gets an email with a link to confirm. Forwarding
								starts once it is clicked.
							</Trans>
						</p>
					) : null}

					{canUpdate && forwarding.forwards.length < forwarding.max ? (
						<adder.Form
							method="POST"
							className="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]"
						>
							<input type="hidden" name="intent" value="add-forward" />
							<input type="hidden" name="managedDomainId" value={domain.id} />
							<input type="hidden" name="mxConfirmation" value={typed} />
							<div className="flex items-center gap-1">
								<Input
									name="localPart"
									placeholder={_(msg`info or *`)}
									aria-label={_(
										msg`Address before the @ (use * for everything else)`,
									)}
									required
								/>
								<span className="text-muted-foreground text-sm">
									@{domain.fqdn}
								</span>
							</div>
							<Input
								name="destination"
								type="email"
								placeholder={_(msg`Your inbox, for example you@gmail.com`)}
								aria-label={_(msg`Inbox to forward to`)}
								required
							/>
							<Button type="submit" disabled={adder.busy}>
								<Trans>Add address</Trans>
							</Button>
						</adder.Form>
					) : null}
					{adder.result && !adder.result.ok ? (
						<p className="text-destructive text-sm">
							{errorMessage(adder.result.error, _)}
						</p>
					) : null}

					{canUpdate && forwarding.enabled ? (
						<div className="flex flex-wrap gap-2">
							<checker.Form method="POST">
								<input type="hidden" name="intent" value="check-forwarding" />
								<input type="hidden" name="managedDomainId" value={domain.id} />
								<Button
									type="submit"
									variant="outline"
									size="sm"
									disabled={checker.busy}
								>
									<Icon name="refresh-cw" className="me-1.5 size-3.5" />
									<Trans>Check now</Trans>
								</Button>
							</checker.Form>
							<off.Form method="POST">
								<input type="hidden" name="intent" value="disable-forwarding" />
								<input type="hidden" name="managedDomainId" value={domain.id} />
								<Button
									type="submit"
									variant="ghost"
									size="sm"
									disabled={off.busy}
								>
									<Trans>Turn off forwarding</Trans>
								</Button>
							</off.Form>
						</div>
					) : null}
				</>
			)}
		</div>
	)
}
