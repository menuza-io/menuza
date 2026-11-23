import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useFetcher } from 'react-router'

/** What the loader knows about the agent's verification of this user. */
export type CallerVerificationView =
	| { status: 'none' }
	| { status: 'pending'; expiresAt: string; codeShown: boolean }
	| { status: 'verified'; verifiedAt: string; validUntil: string }
	| { status: 'locked'; lockedUntil: string }

type VerifyResponse = {
	status?: string
	attemptsLeft?: number
	lockedUntil?: string
	memberships?: Array<{
		organizationId: string
		organization: string
		role: string
	}>
}

const time = (iso: string) =>
	new Date(iso).toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
	})

/**
 * Verify caller and the actions that need it (#291). The buttons only show the
 * state: the server refuses a sensitive action without a fresh verification,
 * whatever this page shows.
 */
export function AdminSupportCard({
	userId,
	verification,
	memberships,
}: {
	userId: string
	verification: CallerVerificationView
	memberships: Array<{ organization: string; role: string }>
}) {
	const { _ } = useLingui()
	const requestFetcher = useFetcher<VerifyResponse>()
	const submitFetcher = useFetcher<VerifyResponse>()
	const emailFetcher = useFetcher<{ error?: string }>()
	const twoFactorFetcher = useFetcher<{ error?: string }>()

	const verifiedNow =
		verification.status === 'verified' ||
		submitFetcher.data?.status === 'verified'
	const submitted = submitFetcher.data
	const locked =
		verification.status === 'locked' ||
		submitted?.status === 'locked' ||
		requestFetcher.data?.status === 'locked'
	const pending =
		!verifiedNow &&
		!locked &&
		(verification.status === 'pending' ||
			requestFetcher.data?.status === 'requested')
	const validUntilTime =
		verification.status === 'verified' ? time(verification.validUntil) : ''
	const attemptsLeft = submitted?.attemptsLeft ?? 0
	const roles =
		submitted?.memberships?.map((entry) => ({
			organization: entry.organization,
			role: entry.role,
		})) ?? memberships

	const errorText = (code?: string) => {
		switch (code) {
			case 'invalid_email':
				return _(msg`That is not a valid email address.`)
			case 'email_in_use':
				return _(msg`Another account already uses that address.`)
			case 'unchanged':
				return _(msg`That is already their email address.`)
			case 'verification_required':
				return _(msg`Verify the caller first.`)
			default:
				return code ? _(msg`Something went wrong.`) : null
		}
	}
	const emailError = errorText(
		(emailFetcher.data as { error?: string } | undefined)?.error,
	)

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Verify caller</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Before you change email, reset two-factor sign-in or start an
						ownership transfer, confirm the caller. The person signed in to the
						App reads out a 6-digit code. You never see it on this page.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<div className="space-y-3">
					{verifiedNow ? (
						<div className="space-y-2">
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant="default">
									<Trans>Verified</Trans>
								</Badge>
								{verification.status === 'verified' ? (
									<span className="text-muted-foreground text-sm">
										<Trans>
											Sensitive actions allowed until {validUntilTime}
										</Trans>
									</span>
								) : (
									<span className="text-muted-foreground text-sm">
										<Trans>Sensitive actions allowed for 15 minutes.</Trans>
									</span>
								)}
							</div>
							{roles.length > 0 ? (
								<ul className="text-sm">
									{roles.map((entry) => (
										<li key={`${entry.organization}-${entry.role}`}>
											{entry.organization}: <strong>{entry.role}</strong>
										</li>
									))}
								</ul>
							) : null}
						</div>
					) : locked ? (
						<p className="text-destructive text-sm" role="alert">
							<Trans>
								Too many wrong codes. Verification for this user is locked for
								an hour. Use the documented recovery steps; do not accept
								details given over the phone.
							</Trans>
						</p>
					) : pending ? (
						<submitFetcher.Form
							method="post"
							action={`/users/${userId}/verify`}
							className="flex flex-wrap items-end gap-3"
						>
							<input type="hidden" name="intent" value="submit" />
							<div className="space-y-1.5">
								<Label htmlFor="verify-code">
									<Trans>Code the caller reads out</Trans>
								</Label>
								<Input
									id="verify-code"
									name="code"
									inputMode="numeric"
									autoComplete="off"
									maxLength={7}
									placeholder="000000"
									className="w-36 font-mono"
									required
								/>
							</div>
							<Button type="submit" disabled={submitFetcher.state !== 'idle'}>
								<Trans>Check code</Trans>
							</Button>
							{submitted?.status === 'wrong' ? (
								<p className="text-destructive text-sm" role="alert">
									<Trans>Wrong code. {attemptsLeft} tries left.</Trans>
								</p>
							) : null}
							{submitted?.status === 'expired' ||
							submitted?.status === 'no_request' ? (
								<p className="text-destructive text-sm" role="alert">
									<Trans>This request has ended. Ask for a new code.</Trans>
								</p>
							) : null}
							{submitted?.status === 'not_shown' ? (
								<p className="text-muted-foreground text-sm">
									<Trans>
										The operator has not opened the code yet. Ask them to open
										Profile, then Security.
									</Trans>
								</p>
							) : null}
						</submitFetcher.Form>
					) : (
						<requestFetcher.Form
							method="post"
							action={`/users/${userId}/verify`}
							className="flex flex-wrap items-center gap-3"
						>
							<input type="hidden" name="intent" value="request" />
							<Button type="submit" disabled={requestFetcher.state !== 'idle'}>
								<Trans>Verify caller</Trans>
							</Button>
							<span className="text-muted-foreground text-sm">
								<Trans>
									The code is shown under Profile, Security in the App and works
									for 10 minutes.
								</Trans>
							</span>
							{requestFetcher.data?.status === 'too_many' ? (
								<p className="text-destructive text-sm" role="alert">
									<Trans>Too many requests. Try again later.</Trans>
								</p>
							) : null}
						</requestFetcher.Form>
					)}
				</div>

				<div className="space-y-4 border-t pt-4">
					<p className="text-muted-foreground text-sm">
						<Trans>
							These need a verification from the last 15 minutes. The server
							checks it.
						</Trans>
					</p>
					<emailFetcher.Form
						method="post"
						action={`/users/${userId}/change-email`}
						className="flex flex-wrap items-end gap-3"
					>
						<div className="space-y-1.5">
							<Label htmlFor="new-email">
								<Trans>New email</Trans>
							</Label>
							<Input
								id="new-email"
								name="email"
								type="email"
								className="w-72"
								required
							/>
						</div>
						<Button
							type="submit"
							variant="outline"
							disabled={emailFetcher.state !== 'idle'}
						>
							<Trans>Change email</Trans>
						</Button>
						{emailError ? (
							<p className="text-destructive text-sm" role="alert">
								{emailError}
							</p>
						) : null}
					</emailFetcher.Form>
					<twoFactorFetcher.Form
						method="post"
						action={`/users/${userId}/reset-2fa`}
						className="flex items-center gap-3"
					>
						<Button
							type="submit"
							variant="outline"
							disabled={twoFactorFetcher.state !== 'idle'}
						>
							<Trans>Reset two-factor sign-in</Trans>
						</Button>
						{errorText(twoFactorFetcher.data?.error) ? (
							<p className="text-destructive text-sm" role="alert">
								{errorText(twoFactorFetcher.data?.error)}
							</p>
						) : null}
					</twoFactorFetcher.Form>
				</div>
			</CardContent>
		</Card>
	)
}
