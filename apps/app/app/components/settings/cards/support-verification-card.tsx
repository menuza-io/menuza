import { Trans } from '@lingui/macro'
import { VERIFICATION_WARNING } from '@repo/common/support-verification'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { useFetcher } from 'react-router'

export type PendingSupportVerification = {
	id: string
	expiresAt: string
	agentFirstName: string
}

type RevealResponse = {
	status: string
	code?: string
	expiresAt?: string
}

/**
 * "Menuza support asked to confirm it's you" (#291). It appears only while a
 * support member has an open request for this person. The code is made when
 * "Show code" is pressed, shown here and nowhere else, and read out on the
 * call. The warning is part of the card.
 */
export function SupportVerificationCard({
	pending,
}: {
	pending: PendingSupportVerification
}) {
	const fetcher = useFetcher<RevealResponse>()
	const revealed = fetcher.data?.status === 'ok' ? fetcher.data : null
	const firstName = pending.agentFirstName
	const gone =
		fetcher.data?.status === 'expired' || fetcher.data?.status === 'not_found'

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Menuza support asked to confirm it's you</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						{firstName} from Menuza support is asking you to read out a code.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<p className="bg-muted text-muted-foreground rounded-md p-3 text-sm">
					{VERIFICATION_WARNING}
				</p>
				{revealed ? (
					<div className="space-y-1" aria-live="polite">
						<p
							className="font-mono text-4xl font-semibold tracking-widest"
							dir="ltr"
							data-testid="support-verification-code"
						>
							{revealed.code}
						</p>
						<p className="text-muted-foreground text-sm">
							<Trans>It works once and stops working in 10 minutes.</Trans>
						</p>
					</div>
				) : gone ? (
					<p className="text-destructive text-sm" role="alert">
						<Trans>
							This request has ended. Ask support to start a new one.
						</Trans>
					</p>
				) : fetcher.data?.status === 'locked' ? (
					<p className="text-destructive text-sm" role="alert">
						<Trans>
							Verification is locked for an hour after too many wrong codes.
						</Trans>
					</p>
				) : null}
				<fetcher.Form method="post" action="/resources/support-verification">
					<input type="hidden" name="verificationId" value={pending.id} />
					<Button type="submit" disabled={fetcher.state !== 'idle'}>
						{revealed ? (
							<Trans>Show a new code</Trans>
						) : (
							<Trans>Show code</Trans>
						)}
					</Button>
				</fetcher.Form>
			</CardContent>
		</Card>
	)
}
