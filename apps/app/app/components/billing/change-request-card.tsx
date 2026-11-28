import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type CancelRequestKind } from '@repo/common/cancel-request'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Form, Link } from 'react-router'
import {
	CANCEL_KIND_TEXT,
	CANCEL_REASON_TEXT,
} from '#app/utils/billing/cancel-request-labels.ts'
import { type OpenChangeRequest } from '#app/utils/billing/cancel-request.ts'
import { cancelRequestPath } from '#app/utils/billing/past-due.ts'

/**
 * On the billing page: a way to ask for a cancellation or a smaller plan
 * (#379), or, while a request is open, what was asked and when it takes effect,
 * with a way to withdraw it. A request never changes anything by itself.
 */
export function ChangeRequestCard({
	orgSlug,
	open,
}: {
	orgSlug: string
	open: OpenChangeRequest | null
}) {
	const { _, i18n } = useLingui()
	if (!open) {
		return (
			<Card data-testid="change-request-card">
				<CardHeader>
					<CardTitle>
						<Trans>Cancel or downgrade</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Need to stop a location, end your subscription or move to a
							smaller plan? Send a request here. It takes effect at the end of
							your billing period.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button
						variant="outline"
						render={<Link to={cancelRequestPath(orgSlug)} />}
					>
						<Trans>Request a change</Trans>
					</Button>
				</CardContent>
			</Card>
		)
	}
	const date = open.effectiveAt
		? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'long' }).format(
				new Date(open.effectiveAt),
			)
		: null
	const kind = open.kind as CancelRequestKind
	const reason = open.reason as keyof typeof CANCEL_REASON_TEXT
	return (
		<Card data-testid="change-request-open">
			<CardHeader>
				<CardTitle>
					<Trans>Your request is with us</Trans>
				</CardTitle>
				<CardDescription>
					{CANCEL_KIND_TEXT[kind] ? _(CANCEL_KIND_TEXT[kind].title) : open.kind}
					{CANCEL_REASON_TEXT[reason] ? (
						<>
							{' · '}
							{_(CANCEL_REASON_TEXT[reason])}
						</>
					) : null}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<p className="text-sm">
					{date ? (
						<Trans>
							Nothing has changed. It takes effect on {date}, the end of your
							billing period.
						</Trans>
					) : (
						<Trans>
							Nothing has changed. It takes effect at the end of your billing
							period.
						</Trans>
					)}
				</p>
				<Form method="post" action={cancelRequestPath(orgSlug)}>
					<input type="hidden" name="intent" value="withdraw" />
					<input type="hidden" name="requestId" value={open.id} />
					<Button type="submit" variant="outline">
						<Trans>Withdraw request</Trans>
					</Button>
				</Form>
			</CardContent>
		</Card>
	)
}
