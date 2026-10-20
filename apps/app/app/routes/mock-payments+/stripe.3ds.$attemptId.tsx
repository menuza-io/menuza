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
import { formatMinor, MockPage } from './__mock-page.tsx'

/** The 3D Secure challenge a 3DS test card is sent to: `/mock-payments/stripe/3ds/:attemptId`. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	requirePaymentsMock(request, 'stripe')
	const view = await getPaymentsEmulator().pages.stripe.describeAttempt(
		params.attemptId ?? '',
	)
	if (!view) throw new Response('Not Found', { status: 404 })
	return {
		open: view.open,
		sessionId: String(view.session.id),
		amountTotal: view.session.amount_total as number | null,
		currency: view.session.currency as string,
	}
}

const decisionSchema = z.object({ decision: z.enum(['complete', 'fail']) })

export async function action({ request, params }: ActionFunctionArgs) {
	requirePaymentsMock(request, 'stripe')
	const parsed = decisionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) throw new Response('Bad Request', { status: 400 })
	const result = await getPaymentsEmulator().pages.stripe.resolveThreeDS(
		params.attemptId ?? '',
		parsed.data.decision,
	)
	if (result.status === 'paid' || result.status === 'saved') {
		return redirect(result.redirectUrl)
	}
	const sessionId = result.sessionId
	if (!sessionId) throw new Response('Not Found', { status: 404 })
	if (result.status === 'declined') {
		const code =
			result.code === 'payment_intent_authentication_failure'
				? 'authentication_failed'
				: result.code
		return redirect(
			`/mock-payments/stripe/checkout/${sessionId}?error=${encodeURIComponent(code)}`,
		)
	}
	return redirect(`/mock-payments/stripe/checkout/${sessionId}`)
}

export default function MockStripeThreeDS() {
	const view = useLoaderData<typeof loader>()
	return (
		<MockPage
			testId="mock-stripe-3ds"
			banner={<Trans>Mock Stripe 3D Secure (local)</Trans>}
		>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Authenticate this payment</Trans>
					</CardTitle>
					<CardDescription>
						{view.amountTotal !== null ? (
							<span data-testid="mock-amount">
								{formatMinor(view.amountTotal, view.currency)}
							</span>
						) : (
							<Trans>Your bank needs to confirm it is you.</Trans>
						)}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{view.open ? (
						<div className="flex flex-wrap gap-3">
							<Form method="post" reloadDocument>
								<input type="hidden" name="decision" value="complete" />
								<Button type="submit" data-testid="mock-3ds-complete">
									<Trans>Complete authentication</Trans>
								</Button>
							</Form>
							<Form method="post" reloadDocument>
								<input type="hidden" name="decision" value="fail" />
								<Button
									type="submit"
									variant="outline"
									data-testid="mock-3ds-fail"
								>
									<Trans>Fail authentication</Trans>
								</Button>
							</Form>
						</div>
					) : (
						<p data-testid="mock-session-inactive">
							<Trans>This authentication is no longer active</Trans>
						</p>
					)}
				</CardContent>
			</Card>
		</MockPage>
	)
}
