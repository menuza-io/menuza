import { Trans } from '@lingui/macro'
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

/** The Checkout.com 3DS challenge: `/mock-payments/checkout-com/3ds/:attemptId`. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	requirePaymentsMock(request, 'checkout')
	const view = await getPaymentsEmulator().pages.checkout.describeAttempt(
		params.attemptId ?? '',
	)
	if (!view) throw new Response('Not Found', { status: 404 })
	return {
		open: view.open,
		amount: Number(view.hpp.amount),
		currency: String(view.hpp.currency),
		hppId: String(view.hpp.id),
	}
}

const passwordSchema = z.object({ password: z.string().max(64) })

export async function action({ request, params }: ActionFunctionArgs) {
	requirePaymentsMock(request, 'checkout')
	const parsed = passwordSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) throw new Response('Bad Request', { status: 400 })
	const result = await getPaymentsEmulator().pages.checkout.resolveThreeDS(
		params.attemptId ?? '',
		parsed.data.password,
	)
	if (result.status === 'approved' || result.status === 'declined') {
		// A wrong password declines and goes to the failure_url.
		return redirect(result.redirectUrl)
	}
	if (result.hppId)
		return redirect(`/mock-payments/checkout-com/hpp/${result.hppId}`)
	throw new Response('Not Found', { status: 404 })
}

export default function MockCheckoutThreeDS() {
	const view = useLoaderData<typeof loader>()
	return (
		<MockPage
			testId="mock-checkout-3ds"
			banner={<Trans>Mock Checkout.com 3D Secure (local)</Trans>}
		>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Authenticate this payment</Trans>
					</CardTitle>
					<CardDescription>
						<span data-testid="mock-amount">
							{formatMinor(view.amount, view.currency)}
						</span>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{view.open ? (
						<Form method="post" reloadDocument className="flex flex-col gap-3">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mock-3ds-password">
									<Trans>Password</Trans>
								</Label>
								<Input
									id="mock-3ds-password"
									name="password"
									type="password"
									autoComplete="off"
									required
									data-testid="mock-3ds-password"
								/>
							</div>
							<Button type="submit" data-testid="mock-3ds-submit">
								<Trans>Continue</Trans>
							</Button>
						</Form>
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
