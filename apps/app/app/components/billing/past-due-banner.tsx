import { Trans } from '@lingui/macro'
import { Icon } from '@repo/ui/icon'
import { Link } from 'react-router'
import { billingPath } from '#app/utils/billing/past-due.ts'

/**
 * One quiet line on every page while the subscription is past due (#237). It
 * cannot be dismissed: it goes when the payment goes through. Only members who
 * can manage billing get it from the layout loader.
 */
export function PastDueBanner({ orgSlug }: { orgSlug: string }) {
	return (
		<div
			role="status"
			data-testid="past-due-banner"
			className="bg-destructive/10 text-destructive flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-1.5 text-center text-sm"
		>
			<Icon name="alert-triangle" className="size-4 shrink-0" />
			<span>
				<Trans>Payment failed. Update your payment method.</Trans>
			</span>
			<Link
				to={billingPath(orgSlug)}
				className="font-medium underline underline-offset-2"
			>
				<Trans>Go to billing</Trans>
			</Link>
		</div>
	)
}
