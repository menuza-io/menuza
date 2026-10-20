import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	Form,
	redirect,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { requirePaymentsMock } from '#app/utils/payments-mock/gate.server.ts'
import { MockPage } from './__mock-page.tsx'

/** The Account Link `url`: `/mock-payments/stripe/connect/onboard/:linkId`. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	requirePaymentsMock(request, 'stripe')
	const view = await getPaymentsEmulator().pages.stripe.describeOnboarding(
		params.linkId ?? '',
	)
	if (!view) throw new Response('Not Found', { status: 404 })
	return {
		accountId: String(view.account.id),
		organizationName: (view.account.metadata?.organizationName ?? null) as
			string | null,
		refreshUrl: String(view.link.refresh_url),
		returnUrl: String(view.link.return_url),
	}
}

const outcomeSchema = z.object({
	outcome: z.enum(['complete', 'requirements_due', 'payouts_restricted']),
})

export async function action({ request, params }: ActionFunctionArgs) {
	requirePaymentsMock(request, 'stripe')
	const parsed = outcomeSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) throw new Response('Bad Request', { status: 400 })
	const done = await getPaymentsEmulator().pages.stripe.completeOnboarding(
		params.linkId ?? '',
		parsed.data.outcome,
	)
	if (!done) throw new Response('Not Found', { status: 404 })
	// The existing `?connect=return` loader sync then writes the columns.
	return redirect(done.returnUrl)
}

export default function MockStripeOnboarding() {
	const view = useLoaderData<typeof loader>()
	return (
		<MockPage
			testId="mock-stripe-onboarding"
			banner={<Trans>Mock Stripe Connect onboarding (local)</Trans>}
		>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Set up payouts</Trans>
					</CardTitle>
					<CardDescription>
						{view.organizationName ? (
							<span className="wrap-anywhere">{view.organizationName}</span>
						) : (
							<Trans>Connected account</Trans>
						)}{' '}
						<code data-testid="mock-account-id">{view.accountId}</code>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-3">
					<Form method="post" reloadDocument>
						<input type="hidden" name="outcome" value="complete" />
						<Button type="submit" data-testid="mock-onboard-complete">
							<Trans>Complete</Trans>
						</Button>
					</Form>
					<Form method="post" reloadDocument>
						<input type="hidden" name="outcome" value="requirements_due" />
						<Button
							type="submit"
							variant="outline"
							data-testid="mock-onboard-requirements"
						>
							<Trans>Submit with requirements due</Trans>
						</Button>
					</Form>
					<Form method="post" reloadDocument>
						<input type="hidden" name="outcome" value="payouts_restricted" />
						<Button
							type="submit"
							variant="outline"
							data-testid="mock-onboard-payouts"
						>
							<Trans>Payouts restricted</Trans>
						</Button>
					</Form>
					<Button
						variant="ghost"
						render={<a href={view.refreshUrl} />}
						nativeButton={false}
						data-testid="mock-back-link"
					>
						<Trans>Back</Trans>
					</Button>
				</CardContent>
			</Card>
		</MockPage>
	)
}
