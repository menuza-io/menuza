import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Switch } from '@repo/ui/switch'
import { useState } from 'react'
import { type DomainOverview } from '#app/utils/domains/overview.server.ts'
import { CopyValue, errorMessage, useDomainFetcher } from './domain-ui.tsx'

/**
 * A domain bought or transferred here (#183): when it expires, auto-renew,
 * the owner email the registry needs confirmed, and transfer out with the
 * authorization code.
 */

type ManagedView = DomainOverview['managed'][number]

export function RegisteredPanel({
	domain,
	canUpdate,
}: {
	domain: ManagedView
	canUpdate: boolean
}) {
	const { _ } = useLingui()
	const renew = useDomainFetcher({ success: msg`Saved` })
	const confirm = useDomainFetcher({ success: msg`Thank you, confirmed` })
	const resend = useDomainFetcher({ success: msg`Email sent again` })
	const out = useDomainFetcher({})
	const relock = useDomainFetcher({ success: msg`Locked again` })
	const [autoRenew, setAutoRenew] = useState(domain.autoRenew)
	const code = out.result?.ok ? String(out.result.authCode ?? '') : ''
	const expires = domain.expiresAt ? new Date(domain.expiresAt) : null
	const days = expires
		? Math.ceil((expires.getTime() - Date.now()) / 86_400_000)
		: null
	const expiresText = expires ? expires.toLocaleDateString() : ''
	const verb = domain.autoRenew ? _(msg`Renews`) : _(msg`Expires`)
	const daysLeft = days !== null && days > 0 ? days : null

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<p className="text-sm font-medium">
					<Trans>Registration</Trans>
				</p>
				<Badge
					variant={
						domain.registrationStatus === 'active' ? 'success' : 'warning'
					}
				>
					{domain.registrationStatus === 'active'
						? _(msg`Active`)
						: domain.registrationStatus === 'transfer_pending'
							? _(msg`Transfer in progress`)
							: domain.registrationStatus === 'expired'
								? _(msg`Expired`)
								: _(msg`Setting up`)}
				</Badge>
				{domain.privacy ? (
					<Badge variant="secondary">
						<Icon name="shield-check" />
						<Trans>Privacy on</Trans>
					</Badge>
				) : null}
				{!domain.locked ? (
					<Badge variant="warning">
						<Trans>Unlocked for transfer</Trans>
					</Badge>
				) : null}
			</div>

			{expires ? (
				<p className="text-muted-foreground text-sm">
					{daysLeft !== null ? (
						<Trans>
							{verb} on {expiresText} (in {daysLeft} days).
						</Trans>
					) : (
						<Trans>
							{verb} on {expiresText}.
						</Trans>
					)}
				</p>
			) : null}

			{domain.renewalFailedSince ? (
				<Alert variant="destructive">
					<Icon name="alert-triangle" />
					<AlertTitle>
						<Trans>We could not renew this domain</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							Your card was declined. Update your card in Billing; we try again
							every day for 7 days.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{!domain.registrantConfirmed && domain.registrationStatus === 'active' ? (
				<Alert>
					<Icon name="mail" />
					<AlertTitle>
						<Trans>Confirm the owner email</Trans>
					</AlertTitle>
					<AlertDescription>
						<p>
							<Trans>
								The registry emailed the owner address. Click its link within 15
								days or the domain can be suspended.
							</Trans>
						</p>
						{canUpdate ? (
							<div className="flex flex-wrap gap-2">
								<resend.Form method="POST">
									<input
										type="hidden"
										name="intent"
										value="resend-registrant-email"
									/>
									<input
										type="hidden"
										name="managedDomainId"
										value={domain.id}
									/>
									<Button
										type="submit"
										variant="outline"
										size="sm"
										disabled={resend.busy}
									>
										<Trans>Send it again</Trans>
									</Button>
								</resend.Form>
								<confirm.Form method="POST">
									<input
										type="hidden"
										name="intent"
										value="confirm-registrant-email"
									/>
									<input
										type="hidden"
										name="managedDomainId"
										value={domain.id}
									/>
									<Button type="submit" size="sm" disabled={confirm.busy}>
										<Trans>I clicked the link</Trans>
									</Button>
								</confirm.Form>
							</div>
						) : null}
					</AlertDescription>
				</Alert>
			) : null}

			{canUpdate && domain.registrationStatus !== 'transfer_pending' ? (
				<div className="flex flex-wrap items-center gap-3">
					<label className="flex items-center gap-2 text-sm">
						<Switch
							checked={autoRenew}
							disabled={renew.busy}
							onCheckedChange={(checked) => {
								setAutoRenew(checked)
								renew.submit({
									intent: 'set-auto-renew',
									managedDomainId: domain.id,
									autoRenew: checked ? 'true' : 'false',
								})
							}}
						/>
						<Trans>Renew automatically</Trans>
					</label>
					<span className="text-muted-foreground text-xs">
						<Trans>
							We email you 30 and 7 days before. Cancelling your Menuza plan
							never takes the domain away.
						</Trans>
					</span>
				</div>
			) : null}

			{canUpdate && domain.registrationStatus === 'active' ? (
				<div className="space-y-2">
					<out.Form method="POST">
						<input type="hidden" name="intent" value="transfer-out" />
						<input type="hidden" name="managedDomainId" value={domain.id} />
						<Button
							type="submit"
							variant="outline"
							size="sm"
							disabled={out.busy}
						>
							<Trans>Transfer out: unlock and get the code</Trans>
						</Button>
					</out.Form>
					{out.result && !out.result.ok ? (
						<p className="text-destructive text-sm">
							{errorMessage(out.result.error, _)}
						</p>
					) : null}
					{code ? (
						<div className="space-y-2">
							<p className="text-sm">
								<Trans>
									The domain is unlocked and auto-renew is off. Give this
									authorization code to the new registrar:
								</Trans>
							</p>
							<CopyValue value={code} />
						</div>
					) : null}
					{!domain.locked && !code ? (
						<relock.Form method="POST">
							<input type="hidden" name="intent" value="lock-domain" />
							<input type="hidden" name="managedDomainId" value={domain.id} />
							<Button
								type="submit"
								variant="ghost"
								size="sm"
								disabled={relock.busy}
							>
								<Trans>Lock it again</Trans>
							</Button>
						</relock.Form>
					) : null}
				</div>
			) : null}
		</div>
	)
}
