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
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { requirePaymentsMock } from '#app/utils/payments-mock/gate.server.ts'
import { cardErrorDescriptor, type CardFormAction } from './__card-errors.ts'
import { CardErrorAlert, CardFields } from './__card-form.tsx'
import { formatMinor, MockPage } from './__mock-page.tsx'

/** The HPP `_links.redirect.href`: `/mock-payments/checkout-com/hpp/:hppId`. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	requirePaymentsMock(request, 'checkout')
	const view = await getPaymentsEmulator().pages.checkout.describeHpp(
		params.hppId ?? '',
	)
	if (!view) throw new Response('Not Found', { status: 404 })
	const { hpp } = view
	return {
		active: view.active,
		amount: Number(hpp.amount),
		currency: String(hpp.currency),
		description: (hpp.description ?? null) as string | null,
		customerEmail: (hpp.customer?.email ?? null) as string | null,
		cancelUrl: String(hpp.cancel_url),
	}
}

const submissionSchema = z.object({
	number: z.string().trim().max(40),
	expiry: z.string().trim().max(12),
	cvc: z.string().trim().max(6),
	email: z.string().trim().max(200).optional(),
	name: z.string().trim().max(200).optional(),
})

export async function action({ request, params }: ActionFunctionArgs) {
	requirePaymentsMock(request, 'checkout')
	const hppId = params.hppId ?? ''
	const parsed = submissionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		return data<CardFormAction>(
			{ error: { kind: 'invalid', code: 'invalid_number', field: 'number' } },
			{ status: 400 },
		)
	}
	const result = await getPaymentsEmulator().pages.checkout.submit(
		hppId,
		parsed.data,
	)
	switch (result.status) {
		case 'approved':
		case 'declined':
			// Success goes to success_url, a decline to failure_url, both with cko-session-id.
			return redirect(result.redirectUrl)
		case 'requires_3ds':
			return redirect(`/mock-payments/checkout-com/3ds/${result.attemptId}`)
		case 'invalid':
			return data<CardFormAction>(
				{
					error: {
						kind: 'invalid',
						code: `invalid_${result.field}`,
						field: result.field,
					},
				},
				{ status: 400 },
			)
		default:
			return redirect(`/mock-payments/checkout-com/hpp/${hppId}`)
	}
}

export default function MockCheckoutHostedPayment() {
	const view = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>() as CardFormAction
	const navigation = useNavigation()
	const { _ } = useLingui()
	return (
		<MockPage
			testId="mock-checkout-hpp"
			banner={<Trans>Mock Checkout.com HPP (local)</Trans>}
		>
			<Card>
				<CardHeader>
					<CardTitle>
						<span data-testid="mock-amount">
							{formatMinor(view.amount, view.currency)}
						</span>
					</CardTitle>
					{view.description ? (
						<CardDescription className="wrap-anywhere">
							{view.description}
						</CardDescription>
					) : null}
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{view.active ? (
						<>
							{actionData?.error ? (
								<CardErrorAlert field={actionData?.error?.field}>
									{_(cardErrorDescriptor(actionData.error.code))}
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
									withZip={false}
								/>
								<Button
									type="submit"
									disabled={navigation.state === 'submitting'}
									data-testid="mock-pay-button"
								>
									<Trans>Pay</Trans>
								</Button>
							</Form>
						</>
					) : (
						<p data-testid="mock-session-inactive">
							<Trans>This payment page is no longer active</Trans>
						</p>
					)}
				</CardContent>
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
			</Card>
		</MockPage>
	)
}
