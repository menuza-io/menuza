import { Plural, Trans, msg } from '@lingui/macro'
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
import { useFetcher } from 'react-router'

export type PastDueView = {
	/** When the subscription became past due (ISO), if known. */
	since: string | null
	daysOverdue: number | null
	/** Null when the payment provider could not answer. */
	issue: {
		invoice: {
			id: string
			amountDue: number
			currency: string
			attemptCount: number
			/** Unix seconds. */
			nextPaymentAttempt: number | null
			hostedInvoiceUrl: string | null
		} | null
		attempts: Array<{
			at: number
			brand: string | null
			last4: string | null
			reason: string | null
		}>
	} | null
}

export type RetryOutcome =
	| { status: 'paid' }
	| { status: 'already_paid' }
	| { status: 'declined'; reason: string | null }
	| { status: 'rate_limited'; retryAt: string }
	| { status: 'not_past_due' }
	| { status: 'unavailable' }

const BRAND_NAMES: Record<string, string> = {
	visa: 'Visa',
	mastercard: 'Mastercard',
	amex: 'American Express',
	discover: 'Discover',
	diners: 'Diners Club',
	jcb: 'JCB',
	unionpay: 'UnionPay',
	cartes_bancaires: 'Cartes Bancaires',
	eftpos_au: 'EFTPOS',
}

export function cardLabel(brand: string | null) {
	if (!brand) return null
	return BRAND_NAMES[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1)
}

/**
 * The unpaid invoice and the history behind a past-due subscription (#237):
 * "Failed with Visa ending 1234 on 3 Nov. Next try 6 Nov", with Retry payment.
 * The banner says it is wrong; this page lets the owner fix it.
 */
export function PastDueCard({
	view,
	retry,
}: {
	view: PastDueView
	retry: RetryOutcome | null
}) {
	const { _, i18n } = useLingui()
	const fetcher = useFetcher<{ retry?: RetryOutcome }>()
	const busy = fetcher.state !== 'idle'
	const outcome = fetcher.data?.retry ?? retry
	const day = (unixSeconds: number) =>
		new Intl.DateTimeFormat(i18n.locale, {
			day: 'numeric',
			month: 'short',
		}).format(new Date(unixSeconds * 1000))
	const money = (amount: number, currency: string) =>
		new Intl.NumberFormat(i18n.locale, {
			style: 'currency',
			currency: currency.toUpperCase(),
		}).format(amount / 100)
	const invoice = view.issue?.invoice ?? null
	const attempts = view.issue?.attempts ?? []
	const days = view.daysOverdue
	const nextTry = invoice?.nextPaymentAttempt
		? day(invoice.nextPaymentAttempt)
		: null

	return (
		<Card data-testid="past-due-card">
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2">
					<Trans>Payment failed</Trans>
					<Badge variant="destructive">
						<Trans>Past due</Trans>
					</Badge>
				</CardTitle>
				<CardDescription>
					<Trans>
						We could not charge your payment method for your subscription. Your
						plan stays on while you fix it.
					</Trans>
					{days !== null && days > 0 ? (
						<>
							{' '}
							<Plural
								value={days}
								one="It has been # day."
								other="It has been # days."
							/>
						</>
					) : null}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{invoice ? (
					<div
						className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
						data-testid="past-due-invoice"
					>
						<div>
							<p className="text-sm font-medium">
								<Trans>Unpaid invoice</Trans>
							</p>
							<p className="text-muted-foreground text-sm tabular-nums">
								{money(invoice.amountDue, invoice.currency)}
							</p>
						</div>
						<fetcher.Form method="post">
							<input type="hidden" name="intent" value="retry-payment" />
							<Button type="submit" disabled={busy}>
								{busy ? <Trans>Trying…</Trans> : <Trans>Retry payment</Trans>}
							</Button>
						</fetcher.Form>
					</div>
				) : view.issue === null ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							We could not load the invoice right now. You can still update your
							payment method.
						</Trans>
					</p>
				) : (
					<p className="text-muted-foreground text-sm">
						<Trans>
							No invoice is open any more. Refresh in a moment, the banner goes
							once the payment is recorded.
						</Trans>
					</p>
				)}

				{outcome ? <RetryMessage outcome={outcome} /> : null}

				{attempts.length > 0 || invoice?.nextPaymentAttempt ? (
					<div>
						<h3 className="mb-1 text-sm font-medium">
							<Trans>History</Trans>
						</h3>
						<ul className="text-muted-foreground flex flex-col gap-1 text-sm">
							{attempts.map((attempt, index) => {
								const brand = cardLabel(attempt.brand)
								const last4 = attempt.last4
								const when = day(attempt.at)
								return (
									<li
										key={`${attempt.at}-${index}`}
										data-testid="past-due-attempt"
									>
										{brand && attempt.last4 ? (
											<Trans>
												Failed with {brand} ending {last4} on {when}.
											</Trans>
										) : (
											<Trans>Failed on {when}.</Trans>
										)}
									</li>
								)
							})}
							{nextTry ? (
								<li data-testid="past-due-next-try">
									<Trans>Next try {nextTry}.</Trans>
								</li>
							) : null}
						</ul>
					</div>
				) : null}

				<div className="flex flex-wrap items-center gap-2">
					<fetcher.Form method="post">
						<input type="hidden" name="intent" value="customer-portal" />
						<Button type="submit" variant="outline" disabled={busy}>
							<Trans>Update payment method</Trans>
						</Button>
					</fetcher.Form>
					{invoice?.hostedInvoiceUrl ? (
						<a
							href={invoice.hostedInvoiceUrl}
							target="_blank"
							rel="noreferrer"
							className="text-sm underline underline-offset-2"
						>
							<Trans>View the invoice</Trans>
						</a>
					) : null}
				</div>
				<span className="sr-only" aria-live="polite">
					{busy ? _(msg`Trying your payment method`) : ''}
				</span>
			</CardContent>
		</Card>
	)
}

function RetryMessage({ outcome }: { outcome: RetryOutcome }) {
	if (outcome.status === 'paid' || outcome.status === 'already_paid') {
		return (
			<Alert data-testid="retry-paid">
				<Icon name="check-circle" />
				<AlertTitle>
					<Trans>Payment received</Trans>
				</AlertTitle>
				<AlertDescription>
					<Trans>Thank you. Your subscription is paid up.</Trans>
				</AlertDescription>
			</Alert>
		)
	}
	const text =
		outcome.status === 'declined' ? (
			<Trans>
				The card was declined. Update your payment method, then try again.
			</Trans>
		) : outcome.status === 'rate_limited' ? (
			<Trans>You can try again in about a minute.</Trans>
		) : outcome.status === 'not_past_due' ? (
			<Trans>This subscription is not past due.</Trans>
		) : (
			<Trans>We could not reach the payment provider. Try again shortly.</Trans>
		)
	return (
		<Alert variant="destructive" data-testid="retry-failed">
			<Icon name="alert-triangle" />
			<AlertTitle>
				<Trans>The payment did not go through</Trans>
			</AlertTitle>
			<AlertDescription>{text}</AlertDescription>
		</Alert>
	)
}
