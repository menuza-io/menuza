import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	data,
	Form,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
	useSearchParams,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { requirePaymentsMock } from '#app/utils/payments-mock/gate.server.ts'
import {
	cardErrorDescriptor,
	KNOWN_CARD_ERROR_CODES,
	type CardFormAction,
} from './__card-errors.ts'
import { CardErrorAlert, CardFields } from './__card-form.tsx'
import { formatMinor, MockPage } from './__mock-page.tsx'

/** The session `url` Stripe Checkout would host: `/mock-payments/stripe/checkout/:sessionId`. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	requirePaymentsMock(request, 'stripe')
	const view = await getPaymentsEmulator().pages.stripe.describeSession(
		params.sessionId ?? '',
	)
	if (!view) throw new Response('Not Found', { status: 404 })
	const { session } = view
	return {
		active: view.active,
		mode: session.mode as 'payment' | 'setup',
		status: session.status as string,
		amountTotal: session.amount_total as number | null,
		currency: session.currency as string,
		message: (session.custom_text?.submit?.message ?? null) as string | null,
		expiresAt: new Date(Number(session.expires_at) * 1000).toISOString(),
		customerEmail: (session.customer_email ?? null) as string | null,
		cancelUrl: (session.cancel_url ?? null) as string | null,
		merchantName: view.merchant?.name ?? null,
		lineItems: view.lineItems.map((item) => ({
			name: String(item.name),
			unitAmount: Number(item.unit_amount),
			quantity: Number(item.quantity),
		})),
	}
}

const submissionSchema = z.object({
	number: z.string().trim().max(40),
	expiry: z.string().trim().max(12),
	cvc: z.string().trim().max(6),
	email: z.string().trim().max(200).optional(),
	name: z.string().trim().max(200).optional(),
	postalCode: z.string().trim().max(20).optional(),
})

export async function action({ request, params }: ActionFunctionArgs) {
	requirePaymentsMock(request, 'stripe')
	const sessionId = params.sessionId ?? ''
	const parsed = submissionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		return data<CardFormAction>(
			{ error: { kind: 'invalid', code: 'invalid_number', field: 'number' } },
			{ status: 400 },
		)
	}
	const result = await getPaymentsEmulator().pages.stripe.submit(
		sessionId,
		parsed.data,
	)
	switch (result.status) {
		case 'paid':
		case 'saved':
			return redirect(result.redirectUrl)
		case 'requires_3ds':
			return redirect(`/mock-payments/stripe/3ds/${result.attemptId}`)
		case 'invalid':
			return data<CardFormAction>(
				{
					error: {
						kind: 'invalid',
						code: `invalid_${result.field === 'number' ? 'number' : result.field}`,
						field: result.field,
					},
				},
				{ status: 400 },
			)
		case 'declined':
			return data<CardFormAction>(
				{ error: { kind: 'declined', code: result.code } },
				{ status: 402 },
			)
		default:
			return redirect(`/mock-payments/stripe/checkout/${sessionId}`)
	}
}

export default function MockStripeCheckout() {
	const view = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>() as CardFormAction
	const [searchParams] = useSearchParams()
	const navigation = useNavigation()
	const { _ } = useLingui()
	const queryError = searchParams.get('error')
	const errorCode =
		actionData?.error?.code ??
		(queryError && KNOWN_CARD_ERROR_CODES.includes(queryError)
			? queryError
			: null)
	const expiresAt = view.expiresAt
	const isSetup = view.mode === 'setup'
	const submitting = navigation.state === 'submitting'

	return (
		<MockPage
			testId="mock-stripe-checkout"
			banner={<Trans>Mock Stripe Checkout (local)</Trans>}
		>
			<Card>
				<CardHeader>
					<CardTitle data-testid="mock-merchant">
						{view.merchantName ?? <Trans>Mock merchant</Trans>}
					</CardTitle>
					<CardDescription>
						{isSetup ? (
							<Trans>Save card for later charges</Trans>
						) : (
							<span data-testid="mock-amount">
								{formatMinor(view.amountTotal ?? 0, view.currency)}
							</span>
						)}
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{view.active ? (
						<>
							{view.lineItems.length > 0 ? (
								<ul
									className="flex flex-col gap-1 text-sm"
									data-testid="mock-line-items"
								>
									{view.lineItems.map((item, index) => (
										<li key={index} className="flex justify-between gap-4">
											<span className="wrap-anywhere">
												{item.name} × {item.quantity}
											</span>
											<span>
												{formatMinor(
													item.unitAmount * item.quantity,
													view.currency,
												)}
											</span>
										</li>
									))}
								</ul>
							) : null}
							{view.message ? (
								<p
									className="text-muted-foreground text-sm wrap-anywhere"
									data-testid="mock-custom-text"
								>
									{view.message}
								</p>
							) : null}
							<p className="text-muted-foreground text-xs">
								<Trans>Expires at {expiresAt}</Trans>
							</p>
							{errorCode ? (
								<CardErrorAlert field={actionData?.error?.field}>
									{_(cardErrorDescriptor(errorCode))}
								</CardErrorAlert>
							) : null}
							<Form
								method="post"
								reloadDocument
								className="flex flex-col gap-4"
							>
								<CardFields
									defaultEmail={view.customerEmail}
									errorField={actionData?.error?.field}
									withZip
								/>
								<Button
									type="submit"
									disabled={submitting}
									data-testid="mock-pay-button"
								>
									{isSetup ? <Trans>Save card</Trans> : <Trans>Pay</Trans>}
								</Button>
							</Form>
						</>
					) : (
						<p data-testid="mock-session-inactive">
							<Trans>This Checkout Session is no longer active</Trans>
						</p>
					)}
				</CardContent>
				{view.cancelUrl ? (
					<CardFooter>
						<Button
							variant="outline"
							render={<a href={view.cancelUrl} />}
							nativeButton={false}
							data-testid="mock-back-link"
						>
							<Trans>Back</Trans>
						</Button>
					</CardFooter>
				) : null}
			</Card>
		</MockPage>
	)
}
